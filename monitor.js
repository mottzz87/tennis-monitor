require('dotenv').config()
const fs = require('fs')
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')

// ========================
// 配置 & 状态
// ========================
const CONFIG_FILE = './config.json'
const STATE_FILE = './lastSet.json'

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

function saveLastSet() {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...lastSet], null, 2))
}

// ========================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

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

// ========================
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
async function monitor() {
  if (booking) {
    console.log('⏸️ 正在预约，跳过本轮')
    return
  }

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    })

    const page = await browser.newPage()

    await page.goto('https://reserve.city.ichikawa.lg.jp/')

    await clickByText(page, 'スポーツ施設')
    await sleep(config.STEP_DELAY)

    for (const place of config.TARGET_PLACE) {
      await clickByText(page, place)
      await sleep(200)
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

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

    await browser.close()

    const data = filterData(rawData)

    console.log('可预约:', data.length)

    const newSet = new Set(data.map(getKey))

    // ========================
    // ⭐ 首次运行
    // ========================
    if (isFirstRun) {
      isFirstRun = false

      console.log('🚀 首次运行')

      if (config.PUSH_ON_INIT) {
        currentData = data
        currentVersion = Date.now()

        if (data.length > 0) {
          await sendTelegram(data, currentVersion)
        } else {
          await bot.sendMessage(process.env.CHAT_ID, '⚠️ 当前没有可预约')
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

    if (added.length === 0 && removed.length === 0) {
      console.log('⏸️ 无变化')
      return
    }

    lastSet = newSet
    saveLastSet()

    if (added.length > 0 && config.NOTIFY_ADDED) {
      console.log('🆕 新增', added.length)

      currentData = added
      currentVersion = Date.now()

      await sendTelegram(added, currentVersion)

      if (config.AUTO_BOOK) {
        await bookOne(added[0])
      }
    }

    if (removed.length > 0 && config.NOTIFY_REMOVED) {
      console.log('❌ 减少', removed.length)
      await sendRemovedTelegram(removed)
    }

  } catch (e) {
    console.log('❌ monitor错误:', e.message)
  }
}

// ========================
// Telegram
// ========================
function formatText(d) {
  // 场地名简化
  let placeShort = d.place
    .replace('テニスコート', '')
    .replace('スポーツ広場', '')
    .replace('中央公園', '中央')
    .trim()

  // 日期：2026年3月25日（水） → 3.25（水）
  let shortDate = d.date
  const dateMatch = d.date.match(/(\d+)年(\d+)月(\d+)日（(.)）/)
  if (dateMatch) {
    shortDate = `${dateMatch[2]}.${dateMatch[3]}（${dateMatch[4]}）`
  }

  // 时间：11:00～13:00 → 11:00~13:00
  let shortTime = d.time.replace('～', '~')

  return `${placeShort} ${d.court} ${shortDate} ${shortTime}`
}

// ========================
// 新增推送
// ========================
async function sendTelegram(data, version) {
  const buttons = data.slice(0, config.MAX_PUSH).map((d, i) => ({
    text: `🎾 ${formatText(d)}`,
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

// ========================
// 减少推送
// ========================
async function sendRemovedTelegram(data) {
  const msg = data
    .slice(0, config.MAX_PUSH)
    .map(d => `⚠️ 已被预约\n${formatText(d)}`)
    .join('\n\n')

  await bot.sendMessage(process.env.CHAT_ID, msg)
}

// ========================
// 点击预约（已修复）
// ========================
bot.on('callback_query', async (query) => {
  if (booking) return

  const [version, indexStr] = query.data.split('_')
  if (Number(version) !== currentVersion) return

  const d = currentData[Number(indexStr)]

  booking = true
  await bot.answerCallbackQuery(query.id, { text: '预约中...' })

  try {
    await bookOne(d)

    await bot.sendMessage(process.env.CHAT_ID,
      `✅ 成功\n${d.court}\n${d.date}\n${d.time}`)
  } catch (e) {
    await bot.sendMessage(process.env.CHAT_ID,
      `❌ 失败\n${e.message}`)
  }

  booking = false
})

// ========================
// ⭐ 核心修复：独立 browser
// ========================
async function bookOne(d) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  })

  const page = await browser.newPage()

  await page.goto('https://reserve.city.ichikawa.lg.jp/')
  await clickByText(page, 'スポーツ施設')
  await sleep(config.STEP_DELAY)

  await clickByText(page, d.place)
  await sleep(config.STEP_DELAY)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

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

  // 点击目标
  try {
    await page.click(`#${d.id}`, { timeout: 3000 })
  } catch {
    const match = d.id.match(/b(\d+)/)
    if (!match) throw new Error('ID失效')

    await page.click(`a[id$="b${match[1]}"]`)
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  await handleLoginIfNeeded(page)
  await clickApply(page)

  await browser.close()
}

// ========================
async function handleLoginIfNeeded(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  if (!(await btn.isVisible())) return

  const value = await btn.inputValue()
  if (!value.includes('ログイン')) return

  await page.fill('#txtID', process.env.USER_ID)
  await page.fill('#txtPass', process.env.PASSWORD)

  await Promise.all([
    page.waitForNavigation(),
    btn.click()
  ])
}

// ========================
async function clickApply(page) {
  const btn = page.locator('#ucPCFooter_btnForward')
  const value = await btn.inputValue()

  if (value.includes('申込')) {
    await Promise.all([
      page.waitForNavigation(),
      btn.click()
    ])
  }
}

// ========================
loadLastSet()
monitor()
timer = setInterval(monitor, config.INTERVAL * 1000)