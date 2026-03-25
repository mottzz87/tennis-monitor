require('dotenv').config()
const fs = require('fs')
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')

// ========================
// 配置 & 状态
// ========================
const CONFIG_FILE = './config.json'
const STATE_FILE = './lastSet.json'
let logBuffer = []

// ⭐ 劫持 console.log
console._log = console.log
console.log = (...args) => {
  const msg = `[${new Date().toLocaleString()}] ` + args.join(' ')
  console._log(...args)

  logBuffer.push(msg)
  if (logBuffer.length > 200) logBuffer.shift()

  const logFile = getLogFile()

  fs.mkdirSync('./logs', { recursive: true }) // 确保目录存在
  fs.appendFileSync(logFile, msg + '\n')
}

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10) // 2026-03-26
  return `./logs/runtime-${date}.log`
}

// ⭐ trace 工具
function createTrace() {
  return Math.random().toString(36).slice(2, 8)
}

function logStep(trace, step, msg, extra = '') {
  console.log(`[${trace}] [${step}] ${msg}`, extra || '')
}

let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
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

function formatCourt(court) {
  if (!court) return ''

  court = court.replace(/\u3000/g, ' ')
  court = court.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))

  const match = court.match(/第\s*(\d+)\s*コート/)
  if (!match) return court

  const num = match[1]
  const prefix = court.split(/第\s*\d+\s*コート/)[0].trim()

  return prefix ? `${prefix} c${num}` : `c${num}`
}

function saveLastSet() {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...lastSet], null, 2))
}

function cleanOldLogs(days = 7) {
  const dir = './logs'
  if (!fs.existsSync(dir)) return

  const files = fs.readdirSync(dir)
  const now = Date.now()

  files.forEach(file => {
    const match = file.match(/runtime-(\d{4}-\d{2}-\d{2})\.log/)
    if (!match) return

    const fileDate = new Date(match[1]).getTime()
    const diffDays = (now - fileDate) / (1000 * 60 * 60 * 24)

    if (diffDays > days) {
      fs.unlinkSync(`${dir}/${file}`)
      console.log(`🧹 删除旧日志: ${file}`)
    }
  })
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

async function sendTelegram(data, version) {
  const buttons = data.slice(0, config.MAX_PUSH).map((d, i) => ({
    text: `${formatText(d)}`,
    callback_data: `${version}_${i}`
  }))

  await bot.sendMessage(
    process.env.CHAT_ID,
    '🆕 可预约（点击直接抢）',
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

bot.setMyCommands([
  { command: 'run', description: '🚀 手动执行监控（强制推送）' },
  { command: 'status', description: '📊 查看当前状态' },
  { command: 'pause', description: '⏸️ 暂停监控' },
  { command: 'resume', description: '▶️ 恢复监控' },
  { command: 'config', description: '⚙️ 查看配置' },
  { command: 'log', description: '📜 查看日志 /log 50' },
  { command: 'help', description: '❓ 查看帮助' }
])

// ⭐ 管理员限制
const ADMIN_ID = Number(process.env.CHAT_ID)
function isAdmin(msg) {
  return msg.from.id === ADMIN_ID
}

let currentData = []
let currentVersion = 0
let booking = false
let isFirstRun = true
let timer = null

function getKey(d) {
  return `${d.place}_${d.court}_${d.date}_${d.time}`
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

// ========================
// 过滤器
// ========================
function filterData(data) {
  return data.filter(d => {

    if (config.TIME_FILTER.length > 0) {
      if (!config.TIME_FILTER.some(t => d.time.includes(t))) return false
    }

    if (config.WEEKDAY_FILTER.length > 0) {
      const match = d.date.match(/（(.)）/)
      if (!match || !config.WEEKDAY_FILTER.includes(match[1])) return false
    }

    if (config.COURT_FILTER.length > 0) {
      if (!config.COURT_FILTER.some(c => d.court.includes(c))) return false
    }

    return true
  })
}

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

    logStep(trace, 'STEP', '进入2周视图')
    await clickByText(page, '2週間')
    await sleep(config.STEP_DELAY)

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

    logStep(trace, 'SCAN', '扫描空位按钮')
    await page.evaluate(() => {
      document.querySelectorAll('table[id*="dgTable"] a').forEach(a => {
        const val = a.innerText.replace(/\s/g, '')
        if (val === '○' || val === '△') a.click()
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
              result.push({
                place: currentPlace,
                court,
                date: headers[0].innerText.replace(/\s/g, ''),
                time: times[j - 2],
                id: link.id
              })
            }
          }
        }
      }

      return result
    })

    logStep(trace, 'PARSE', `抓取数据: ${rawData.length}条`)

    await browser.close()

    const data = filterData(rawData)
    currentData = data
    currentVersion = Date.now()
    logStep(trace, 'FILTER', `过滤后: ${data.length}条`)

    if (data[0]) {
      logStep(trace, 'SAMPLE', JSON.stringify(data[0]))
    }

    console.log('可预约:', data.length)

    const newSet = new Set(data.map(getKey))

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

      lastSet = newSet
      saveLastSet()
      return
    }

    const added = data.filter(d => !lastSet.has(getKey(d)))
    const removed = [...lastSet]
      .filter(k => !newSet.has(k))
      .map(k => {
        const [place, court, date, time] = k.split('_')
        return { place, court, date, time }
      })

    logStep(trace, 'DIFF', `新增:${added.length} 减少:${removed.length}`)

    if (added.length === 0 && removed.length === 0) {
      if (forcePush) {
        logStep(trace, 'FORCE_PUSH', `强制推送当前数据 ${data.length}`)
    
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
      } else {
        console.log('⏸️ 无变化')
      }
      return
    }

    lastSet = newSet
    saveLastSet()

    if (added.length > 0 && config.NOTIFY_ADDED) {
      logStep(trace, 'PUSH', `发送新增通知 ${added.length}`)

      currentData = added
      currentVersion = Date.now()

      await sendTelegram(added, currentVersion)

      if (config.AUTO_BOOK) {
        logStep(trace, 'AUTO_BOOK', `尝试预约`)
        await bookOne(added[0])
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

  logStep(trace, 'BOOK', '进入时间页')
  await clickByText(page, '2週間')
  await sleep(config.STEP_DELAY)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  await page.evaluate(() => {
    document.querySelectorAll('table[id*="dgTable"] a').forEach(a => {
      const val = a.innerText.replace(/\s/g, '')
      if (val === '○' || val === '△') a.click()
    })
  })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '点击目标slot')
  await page.click(`#${d.id}`).catch(() => {})

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

bot.on('callback_query', async (query) => {
  if (booking) return

  const [version, indexStr] = query.data.split('_')
  if (Number(version) !== currentVersion) return

  const d = currentData[Number(indexStr)]

  booking = true
  await bot.answerCallbackQuery(query.id, { text: '预约中...' })

  try {
    await bookOne(d)

    await bot.sendMessage(
      process.env.CHAT_ID,
      `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n${formatText(d, { showBike: true })}`,
      { parse_mode: 'Markdown' }
    )
    await monitor({ forcePush: true })
  } catch (e) {
    await bot.sendMessage(
      process.env.CHAT_ID,
      `❌ *预约失败*\n━━━━━━━━━━━━━━\n${formatText(d)}\n\n🧨 ${e.message}`,
      { parse_mode: 'Markdown' }
    )
  }

  booking = false
})



// log
bot.onText(/\/log(?: (\d+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const MAX = 3500
  const safeLogs = logBuffer.slice(-MAX)
  const n = Number(match[1] || 20)
  await bot.sendMessage(msg.chat.id, `📜 最近 ${n} 条日志：\n\n${safeLogs}`)
})

// config
bot.onText(/\/config$/, async (msg) => {
  if (!isAdmin(msg)) return
  await bot.sendMessage(msg.chat.id, '⚙️ 当前配置：\n\n' + JSON.stringify(config, null, 2))
})

// set
bot.onText(/\/set (\w+) (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return

  const key = match[1]
  let value = match[2]

  if (!(key in config)) {
    return bot.sendMessage(msg.chat.id, '❌ 不存在这个配置项')
  }

  try {
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (!isNaN(value)) value = Number(value)
    else if (value.startsWith('[')) value = JSON.parse(value)

    config[key] = value
    saveConfig()

    await bot.sendMessage(msg.chat.id, `✅ 已更新 ${key}`)
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ 修改失败`)
  }
})

// run
bot.onText(/\/run/, async (msg) => {
  if (!isAdmin(msg)) return
  await bot.sendMessage(
    msg.chat.id,
    `🚀 *手动执行监控*\n━━━━━━━━━━━━━━\n⏳ 正在抓取最新数据...`,
    { parse_mode: 'Markdown' }
  )
  await monitor({ forcePush: true })
})

// pause
bot.onText(/\/pause/, async (msg) => {
  if (!isAdmin(msg)) return
  clearInterval(timer)
  timer = null
  await bot.sendMessage(msg.chat.id, '⏸️ *监控已暂停*\n━━━━━━━━━━━━━━\n不会再自动刷新')
})

// resume
bot.onText(/\/resume/, async (msg) => {
  if (!isAdmin(msg)) return
  if (!timer) {
    timer = setInterval(monitor, config.INTERVAL * 1000)
  }
  await bot.sendMessage(msg.chat.id, '监控已恢复*\n━━━━━━━━━━━━━━\n每 ${config.INTERVAL}s 执行一次')
})

// status
bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg)) return

  const statusText = `
    📊 *系统状态*
    ━━━━━━━━━━━━━━
    📡 监控状态：${!!timer ? '✅ 运行中' : '⏸️ 已暂停'}
    🤖 预约状态：${booking ? '⏳ 预约中' : '🟢 空闲'}

    📦 *数据情况*
    ━━━━━━━━━━━━━━
    📊 当前可预约：${currentData.length}
    🆔 当前版本：${currentVersion}

    ⚙️ *运行配置*
    ━━━━━━━━━━━━━━
    ⏱️ 间隔：${config.INTERVAL}s
    🎯 场地：${config.TARGET_PLACE.join(', ') || '全部'}
    🕒 时间过滤：${config.TIME_FILTER.join(', ') || '不限'}
    📅 星期过滤：${config.WEEKDAY_FILTER.join(', ') || '不限'}

    🚀 *快捷操作*
    ━━━━━━━━━━━━━━
    /run ｜ /pause ｜ /resume
    `

  await bot.sendMessage(msg.chat.id, statusText, {
    parse_mode: 'Markdown'
  })
})
// help
bot.onText(/\/help/, async (msg) => {
  if (!isAdmin(msg)) return

  const helpText = `
    🧠 *系统状态*
    ━━━━━━━━━━━━━━
    📡 监控中：${!!timer ? '✅ 开启' : '❌ 关闭'}
    🤖 预约中：${booking ? '⏳ 进行中' : '🟢 空闲'}

    🛠️ *基础命令*
    ━━━━━━━━━━━━━━
    🚀 /run       手动执行一次监控（强制推送）
    📊 /status    查看当前状态
    ❓ /help      查看帮助

    ⚙️ *配置管理*
    ━━━━━━━━━━━━━━
    📜 /config    查看当前配置

    ✏️ /set key value
    修改配置（支持 number / boolean / array）

    示例：
    /set INTERVAL 30
    /set AUTO_BOOK false
    /set TIME_FILTER ["18:00","19:00"]

    📡 *监控控制*
    ━━━━━━━━━━━━━━
    ⏸️ /pause     暂停监控
    ▶️ /resume    恢复监控

    📜 *日志*
    ━━━━━━━━━━━━━━
    /log [n]      查看最近日志（默认20条）
    例：/log 50
    `

  await bot.sendMessage(msg.chat.id, helpText, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['/run', '/status'],
        ['/pause', '/resume'],
        ['/config', '/log']
      ],
      resize_keyboard: true
    }
  })
})

// ========================
loadLastSet()
cleanOldLogs()
monitor()
timer = setInterval(monitor, config.INTERVAL * 1000)
setInterval(() => cleanOldLogs(), 24 * 60 * 60 * 1000)