require('dotenv').config()
const fs = require('fs')
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')

// ========================
// ✅ 读取配置
// ========================
let config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'))

function saveConfig() {
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2))
}

// ========================
// ✅ 持久化 lastSet
// ========================
let lastSet = new Set()

function loadLastSet() {
  try {
    const data = JSON.parse(fs.readFileSync('./lastSet.json', 'utf-8'))
    lastSet = new Set(data)
    console.log('✅ 已加载 lastSet')
  } catch {
    console.log('⚠️ 没有历史 lastSet')
  }
}

function saveLastSet() {
  fs.writeFileSync('./lastSet.json', JSON.stringify([...lastSet]))
}

// ========================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

let currentData = []
let currentVersion = 0
let booking = false
let browser
let isFirstRun = true

function getKey(d) {
  return `${d.place}_${d.court}_${d.date}_${d.time}`
}

// ========================
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox']
    })
  }
  return browser
}

async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

// ========================
// ✅ 过滤器
// ========================
function filterData(data) {
  return data.filter(d => {

    // 时间过滤
    if (config.TIME_FILTER.length > 0) {
      if (!config.TIME_FILTER.some(t => d.time.includes(t))) return false
    }

    // 星期过滤
    if (config.WEEKDAY_FILTER.length > 0) {
      const match = d.date.match(/（(.)）/)
      if (!match || !config.WEEKDAY_FILTER.includes(match[1])) return false
    }

    return true
  })
}

// ========================
// ✅ 监控
// ========================
async function monitor() {
  try {
    const browser = await getBrowser()
    const page = await browser.newPage()

    await page.goto('https://reserve.city.ichikawa.lg.jp/')

    await clickByText(page, 'スポーツ施設')

    for (const place of config.TARGET_PLACE) {
      await clickByText(page, place)
    }

    await Promise.all([
      page.waitForNavigation(),
      page.click('#ucPCFooter_btnForward')
    ])

    await clickByText(page, '2週間')

    await Promise.all([
      page.waitForNavigation(),
      page.click('#ucPCFooter_btnForward')
    ])

    await page.evaluate(() => {
      document.querySelectorAll('table[id*="dgTable"] a').forEach(a => {
        const val = a.innerText.replace(/\s/g, '')
        if (val === '○' || val === '△') a.click()
      })
    })

    await Promise.all([
      page.waitForNavigation(),
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

    await page.close()

    const data = filterData(rawData)

    console.log('可预约:', data.length)

    const newSet = new Set(data.map(getKey))

    // 首次
    if (lastSet.size === 0) {
      lastSet = newSet
      saveLastSet()
    
      console.log('🟡 初始化')
    
      if (config.PUSH_ON_INIT && data.length > 0) {
        console.log('🚀 首次推送')
    
        currentData = data
        currentVersion = Date.now()
    
        await sendTelegram(data, currentVersion)
      }
    
      return
    }

    const added = data.filter(d => !lastSet.has(getKey(d)))
    const removed = [...lastSet]
      .filter(k => !newSet.has(k))
      .map(k => {
        const [place, court, date, time] = k.split('_')
        return { place, court, date, time }
      })

      if (isFirstRun) {
        isFirstRun = false
      
        console.log('🚀 首次运行，强制推送')
      
        if (data.length > 0) {
          currentData = data
          currentVersion = Date.now()
      
          await sendTelegram(data, currentVersion)
        } else {
          await bot.sendMessage(process.env.CHAT_ID, '⚠️ 当前没有可预约场地')
        }
      
        // ⚠️ 注意：首次之后再更新 lastSet
        lastSet = newSet
        saveLastSet()
      
        return
      }

    lastSet = newSet
    saveLastSet()

    // 新增
    if (added.length > 0) {
      currentData = added
      currentVersion = Date.now()

      await sendTelegram(added, currentVersion)

      // 自动预约
      if (config.AUTO_BOOK) {
        await bookOne(added[0])
      }
    }

    // 减少
    if (removed.length > 0) {
      await sendRemovedTelegram(removed)
    }

  } catch (e) {
    console.log('❌ monitor错误:', e.message)
  }
}

// ========================
// Telegram 推送
// ========================
async function sendTelegram(data, version) {
  const buttons = data.slice(0, config.MAX_PUSH).map((d, i) => {
    return {
      text: `🎾 ${d.court} ${d.date} ${d.time}`,
      callback_data: `${version}_${i}`
    }
  })

  await bot.sendMessage(
    process.env.CHAT_ID,
    '🆕 可预约',
    { reply_markup: { inline_keyboard: buttons.map(b => [b]) } }
  )
}

async function sendRemovedTelegram(data) {
  const msg = data.slice(0, config.MAX_PUSH)
    .map(d => `⚠️ 已被预约\n${d.court}\n${d.date}\n${d.time}`)
    .join('\n\n')

  await bot.sendMessage(process.env.CHAT_ID, msg)
}

// ========================
// Telegram 控制
// ========================
bot.onText(/\/config/, msg => {
  bot.sendMessage(msg.chat.id, JSON.stringify(config, null, 2))
})

bot.onText(/\/set (.+)/, (msg, match) => {
  const [key, value] = match[1].split('=')

  if (config[key] === undefined) {
    return bot.sendMessage(msg.chat.id, '❌ 参数不存在')
  }

  try {
    config[key] = JSON.parse(value)
  } catch {
    config[key] = value
  }

  saveConfig()
  bot.sendMessage(msg.chat.id, `✅ 已更新 ${key}`)
})

// ========================
async function bookOne(d) {
  console.log('🚀 自动预约:', d.court, d.time)
}

// ========================
loadLastSet()
monitor()
setInterval(monitor, config.INTERVAL * 1000)