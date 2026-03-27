require('dotenv').config()
const fs = require('fs')
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')
const {
  getLogFile,
  setupConsoleLogging,
  cleanOldLogs,
  createTrace,
  logStep
} = require('./utils/logging')
const { 
  formatCourt,
  filterSlotsByConfig,
  filterSlotsAuto,
  parseSlotDayKey,
  parseSlotStartDateTime } = require('./utils/filters')
const { sleep, clickByText } = require('./utils/runtime')
const stats = require('./utils/stats')
const registerTelegramHandlers = require('./utils/telegramHandlers')


// ========================
// 配置 & 状态
// ========================
const CONFIG_FILE = './config.json'
const STATE_FILE = './lastSet.json'
let logBuffer = []
setupConsoleLogging(logBuffer)

let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function getDurationText(config) {
  return config.BOOK_DURATION_MAP?.[config.BOOK_DURATION]
}

// ========================
// 持久化 lastSet
// ========================
let lastSet = new Set()

function loadLastSet() {
  try {
    const arr = JSON.parse(fs.readFileSync(STATE_FILE))
    lastSet = new Set(arr)
    console.log('✅ 已加载 lastSet')
  } catch {
    console.log('⚠️ 没有历史 lastSet')
  }
}

function saveLastSet() {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...lastSet], null, 2))
}

// ========================
// Telegram 原有
// ========================
function formatText(d, options = {}) {
  const { showBike = false } = options

  const meta = config.PLACE_MAP[d.place] || {}
  const placeShort = meta.short || d.place
  const emoji = meta.emoji || '🎾'
  const bike = showBike && meta.bike ? ` ${meta.bike}` : ''

  let shortDate = d.date
  const dateMatch = d.date.match(/(\d+)年(\d+)月(\d+)日（(.)）/)
  if (dateMatch) {
    shortDate = `${dateMatch[2]}.${dateMatch[3]}（${dateMatch[4]}）`
  }

  let shortTime = d.time.replace('～', '~')

  return `${emoji} ${placeShort} ${formatCourt(d.court)} ${shortDate} ${shortTime}${bike}`
}

async function sendTelegram(data, version, title = '🆕 可预约（点击直接预约）') {
  const buttons = data.slice(0, config.MAX_PUSH).map((d, i) => ({
    text: `${formatText(d)}`,
    callback_data: `${version}_${i}`
  }))

  await bot.sendMessage(
    process.env.CHAT_ID,
    title,
    {
      reply_markup: {
        inline_keyboard: buttons.map(b => [b])
      }
    }
  )
}

async function sendRemovedTelegram(data) {
  const msg = data
    .slice(0, config.MAX_PUSH)
    .map(d => `⚠️ 已被预约\n${formatText(d)}`)
    .join('\n\n')

  await bot.sendMessage(process.env.CHAT_ID, msg)
}

async function handleLoginIfNeeded(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  if (!(await btn.isVisible())) return

  const value = await btn.inputValue()
  if (!value.includes('ログイン')) return

  console.log('🔐 需要登录')

  await page.fill('#txtID', process.env.USER_ID)
  await page.fill('#txtPass', process.env.PASSWORD)

  await Promise.all([
    page.waitForNavigation(),
    btn.click()
  ])
}

async function clickApply(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  const value = await btn.inputValue()

  if (value.includes('申込')) {
    console.log('📩 提交预约')

    await Promise.all([
      page.waitForNavigation(),
      btn.click()
    ])
  }
}

// ========================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

// ⭐ 管理员限制
const ADMIN_ID = Number(process.env.CHAT_ID)
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID
}

let currentData = []
let currentVersion = 0
let booking = false //手动预约
let autoBooking = false  //如AUTO_BOOT打开时，自动预约的状态机
let autoBookedDayKeys = new Set() // 仅用于自动抢：同一天成功过就不再继续自动选
let isFirstRun = true
let timer = null


// ========================
// 监控
// ========================
async function monitor(options = {}) {
  const { forcePush = false } = options
  const trace = createTrace()
  logStep(trace, 'START', '开始监控')

  if (booking) {
    logStep(trace, 'SKIP', '正在预约，跳过')
    return
  }

  try {
    logStep(trace, 'BROWSER', '启动浏览器')
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    })

    const page = await browser.newPage()

    logStep(trace, 'NAV', '进入首页')
    await page.goto('https://reserve.city.ichikawa.lg.jp/')

    logStep(trace, 'CLICK', '点击 スポーツ施設')
    await clickByText(page, 'スポーツ施設')
    await sleep(config.STEP_DELAY)

    logStep(trace, 'FILTER', `选择场地: ${config.TARGET_PLACE.join(',')}`)
    for (const place of config.TARGET_PLACE) {
      await clickByText(page, place)
      await sleep(200)
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

    logStep(trace, 'STEP', '进入表示期间选择')
    await clickByText(page, getDurationText(config))
    await sleep(config.STEP_DELAY)

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

    logStep(trace, 'SCAN', '扫描空位按钮')
    await page.evaluate(() => {
      let count = 0
      const MAX = 10
    
      document.querySelectorAll('table[id*="dgTable"] a').forEach(a => {
        if (count >= MAX) return
    
        const val = a.innerText.replace(/\s/g, '')
        if (val === '○' || val === '△') {
          a.click()
          count++
        }
      })
    })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

    logStep(trace, 'NAV', '进入结果页')

    const rawData = await page.evaluate(() => {
      const result = []
      let currentPlace = ''
      const tables = document.querySelectorAll('table')

      for (const table of tables) {
        const placeEl = table.querySelector('a[id*="lnkShisetsu"]')
        if (placeEl) {
          currentPlace = placeEl.innerText.trim()
          continue
        }

        if (!table.id || !table.id.includes('dgTable')) continue

        const rows = table.querySelectorAll('tr')
        const headers = rows[0].querySelectorAll('td')

        const times = []
        for (let i = 2; i < headers.length; i++) {
          times.push(headers[i].innerText.replace(/\s/g, ''))
        }

        for (let i = 1; i < rows.length; i++) {
          const tds = rows[i].querySelectorAll('td')
          const court = tds[0].innerText.trim()

          for (let j = 2; j < tds.length; j++) {
            const link = tds[j].querySelector('a')
            if (!link) continue

            const val = link.innerText.replace(/\s/g, '')

            if (val === '○' || val === '△') {
              const dateStr = headers[0].innerText.replace(/\s/g, '')
              const timeStr = times[j - 2]
              const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/)
              if (m) {
                const y = m[1]
                const mo = String(m[2]).padStart(2, '0')
                const d = String(m[3]).padStart(2, '0')
                dateKey = `${y}-${mo}-${d}`
              }
              const formatStr = str => String(str)
              .toLowerCase()
              .replace(/\u3000/g, ' ')
              .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
              .replace(/\s+/g, ' ')
              .trim()

              result.push({
                place: currentPlace,
                court: formatStr(court),
                date: dateStr,
                time: timeStr,
                domId: link.id, // ⭐ 用于点击
                uid: formatStr(`${currentPlace}_${court}_${dateKey}_${timeStr}`)
              })
            }
          }
        }
      }

      return result
    })

    logStep(trace, 'PARSE', `抓取数据: ${rawData.length}条`)

    await browser.close()

    const data = filterSlotsByConfig(rawData, config)
    currentData = data
    currentVersion = Date.now()
    logStep(trace, 'FILTER', `过滤后: ${data.length}条`)

    if (data[0]) {
      logStep(trace, 'SAMPLE', JSON.stringify(data[0]))
    }

    console.log('可预约:', data.length)

    const newSet = new Set(data.map(d => d.uid))

    if (isFirstRun) {
      isFirstRun = false
      console.log('🚀 首次运行')

      if (config.PUSH_ON_INIT) {
        currentData = data
        currentVersion = Date.now()

        if (data.length > 0) {
          await sendTelegram(data, currentVersion)
        } else {
          await bot.sendMessage(
            process.env.CHAT_ID,
            `📭 *暂无可预约*\n━━━━━━━━━━━━━━\n可以稍后再试 /run`,
            { parse_mode: 'Markdown' }
          )
        }
      }

      lastSet = new Set(data.map(d => d.uid))
      saveLastSet()
      return
    }

    const added = data.filter(d => !lastSet.has(d.uid))
    const removed = [...lastSet]
    .filter(k => !newSet.has(k))
    .map(k => {
      const [place, court, date, time] = k.split('_')
      return { place, court, date, time }
    })
    .filter(d => config.TARGET_PLACE.includes(d.place)) // ⭐关键过滤
    // ⭐ 统计埋点
    stats.record('added', added)
    stats.record('removed', removed)
    logStep(trace, 'DIFF', `新增:${added.length} 减少:${removed.length}`)

    if (added.length === 0 && removed.length === 0) {
      if (forcePush) {
        logStep(trace, 'FORCE_PUSH', `强制推送当前数据 ${data.length}`)
    
        currentData = data
        currentVersion = Date.now()
    
        if (data.length > 0) {
          await sendTelegram(data, currentVersion, '✨ 有新场地！！点击直接预约）')
        } else {
          await bot.sendMessage(
            process.env.CHAT_ID,
            `📭 *暂无可预约*\n━━━━━━━━━━━━━━\n可以稍后再试 /run`,
            { parse_mode: 'Markdown' }
          )
        }
      } else {
        console.log('⏸️ 无变化')
      }
      return
    }

    lastSet = new Set(data.map(d => d.uid))
    saveLastSet()

    if (added.length > 0) {
      // 先按“通知规则”处理 Telegram（如果你开了通知）
      if (config.NOTIFY_ADDED) {
        logStep(trace, 'PUSH', `发送新增通知 ${added.length}`)

        currentData = added
        currentVersion = Date.now()

        await sendTelegram(added, currentVersion)
      }

      // 再按“自动抢规则”挑选最合适的 slot 去预约
      if (config.AUTO_BOOK && !autoBooking) {
        const autoCandidates = filterSlotsAuto(added, config)
        if (autoCandidates.length === 0) {
          logStep(trace, 'AUTO_BOOK', `无匹配项（added=${added.length}）`)
        } else {
          // 仅用于自动抢的附加规则：
          // 1) 开始时间距离当前时间 < 20 分钟的筛掉
          // 2) 当天若已自动抢成功过，则不再继续自动抢该天
          const now = Date.now()

          const candidates = autoCandidates.filter(d => {
            const startDate = parseSlotStartDateTime(d)
            if (!startDate) return false

            const diffMin = (startDate.getTime() - now) / 60000
            if (diffMin < 20) return false

            const dayKey = parseSlotDayKey(d)
            if (dayKey && autoBookedDayKeys.has(dayKey)) return false

            return true
          })

          if (candidates.length === 0) {
            logStep(trace, 'AUTO_BOOK', `筛选后无候选（added=${added.length}，auto=${autoCandidates.length}）`)
          } else {
            // 优先抢最晚开始的 slot
            candidates.sort((a, b) => {
              const ta = parseSlotStartDateTime(a)?.getTime() ?? -Infinity
              const tb = parseSlotStartDateTime(b)?.getTime() ?? -Infinity
              return tb - ta
            })

            const d = candidates[0]
            const dayKey = parseSlotDayKey(d)

            logStep(trace, 'AUTO_BOOK', `尝试预约（最晚且>=20min）${d.place} ${d.court} ${d.time}`)
            autoBooking = true
          try {
            await bookOne(d)

            await bot.sendMessage(
              process.env.CHAT_ID,
              `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n${formatText(d, { showBike: true })}`,
              { parse_mode: 'Markdown' }
            )

            if (dayKey) autoBookedDayKeys.add(dayKey)

            await monitor({ forcePush: true })
          } catch (e) {
            await bot.sendMessage(
              process.env.CHAT_ID,
              `❌ *预约失败*\n━━━━━━━━━━━━━━\n${formatText(d)}\n\n🧨 ${e.message}`,
              { parse_mode: 'Markdown' }
            )
          } finally {
            autoBooking = false
          }
          }
        }
      }
    }

    if (removed.length > 0 && config.NOTIFY_REMOVED) {
      logStep(trace, 'PUSH', `发送减少通知 ${removed.length}`)
      await sendRemovedTelegram(removed)
    }

  } catch (e) {
    console.log(`[${trace}] ❌ monitor错误:`, e.stack || e.message)
  }
}

// ========================
// ⭐ bookOne 日志增强
// ========================
async function bookOne(d, trace = createTrace()) {
  logStep(trace, 'BOOK', `开始预约 ${d.place} ${d.court} ${d.time}`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  })

  const page = await browser.newPage()

  logStep(trace, 'BOOK', '进入首页')
  await page.goto('https://reserve.city.ichikawa.lg.jp/')

  logStep(trace, 'BOOK', '选择场地')
  await clickByText(page, 'スポーツ施設')
  await sleep(config.STEP_DELAY)

  await clickByText(page, d.place)
  await sleep(config.STEP_DELAY)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '进入表示期间选择')
  await clickByText(page, getDurationText(config))
  await sleep(config.STEP_DELAY)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  await page.evaluate(() => {
    let count = 0
    const MAX = 10
  
    document.querySelectorAll('table[id*="dgTable"] a').forEach(a => {
      if (count >= MAX) return
  
      const val = a.innerText.replace(/\s/g, '')
      if (val === '○' || val === '△') {
        a.click()
        count++
      }
    })
  })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '点击目标slot')
  await page.click(`#${d.domId}`).catch(() => {})

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '提交预约')
  await handleLoginIfNeeded(page)
  await clickApply(page)

  logStep(trace, 'BOOK_SUCCESS', `${d.court} ${d.time}`)

  await browser.close()
}

registerTelegramHandlers({
  bot,
  config,
  isAdmin,
  getCurrentData: () => currentData,
  getCurrentVersion: () => currentVersion,
  getBooking: () => booking,
  setBooking: (v) => { booking = v },
  getTimer: () => timer,
  setTimer: (v) => { timer = v },
  monitor,
  bookOne,
  formatText,
  saveConfig,
  getLogFile,
  getLogBuffer: () => logBuffer
})

// ========================
loadLastSet()
cleanOldLogs(30)
monitor()
timer = setInterval(monitor, Math.floor(Math.random() * (60) + config.INTERVAL) * 1000)
setInterval(() => cleanOldLogs(30), 24 * 60 * 60 * 1000)