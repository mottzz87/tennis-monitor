require('dotenv').config()
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const TARGET_PLACE = [
  '菅野終末処理場テニスコート',
  '福栄スポーツ広場テニスコート',
]

let currentData = []
let currentVersion = 0
let booking = false
let browser
let lastHash = ''

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
// ✅ 数据 hash（去重推送核心）
// ========================
function genHash(data) {
  return JSON.stringify(
    data.map(d => `${d.place}_${d.court}_${d.date}_${d.time}`)
  )
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

    for (const place of TARGET_PLACE) {
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

    // 👉 选 ○ △
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

    // ========================
    // ✅ 解析
    // ========================
    const data = await page.evaluate(() => {
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
        if (rows.length < 2) continue

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

    console.log('可预约:', data.length)

    const hash = genHash(data)

    // ✅ 无变化 → 不推送
    if (hash === lastHash) {
      console.log('⏸️ 无变化，不推送')
      return
    }

    lastHash = hash

    if (data.length > 0) {
      currentData = data
      currentVersion = Date.now()

      await sendTelegram(data, currentVersion)
    }

  } catch (e) {
    console.log('❌ monitor错误:', e.message)
  }
}

// ========================
// Telegram
// ========================
async function sendTelegram(data, version) {
  const buttons = data.slice(0, 10).map((d, i) => {
    const dateMatch = d.date.match(/(\d+)年(\d+)月(\d+)日（(.)）/)
    const shortDate = dateMatch
      ? `${dateMatch[2]}.${dateMatch[3]}(${dateMatch[4]})`
      : d.date

    return {
      text: `🎾 ${d.court} ${shortDate} ${d.time}`,
      callback_data: `${version}_${i}`
    }
  })

  const inline_keyboard = buttons.map(btn => [btn])

  await bot.sendMessage(
    process.env.CHAT_ID,
    '发现可预约👇',
    { reply_markup: { inline_keyboard } }
  )
}

// ========================
// 点击预约
// ========================
bot.on('callback_query', async (query) => {
  if (booking) return

  const [version, indexStr] = query.data.split('_')
  const index = Number(indexStr)

  if (Number(version) !== currentVersion) return

  const d = currentData[index]

  booking = true
  await bot.answerCallbackQuery(query.id, { text: '预约中...' })

  try {
    await bookOne(d)

    await bot.sendMessage(
      process.env.CHAT_ID,
      `✅ 成功\n${d.court}\n${d.date}\n${d.time}`
    )
  } catch (e) {
    await bot.sendMessage(
      process.env.CHAT_ID,
      `❌ 失败\n${e.message}`
    )
  }

  booking = false
})

// ========================
// 预约
// ========================
async function bookOne(d) {
  const browser = await getBrowser()
  const page = await browser.newPage()

  await page.goto('https://reserve.city.ichikawa.lg.jp/')

  await clickByText(page, 'スポーツ施設')
  await clickByText(page, d.place)

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

  await page.click(`#${d.id}`)

  await Promise.all([
    page.waitForNavigation(),
    page.click('#ucPCFooter_btnForward')
  ])

  await handleLoginIfNeeded(page)
  await clickApply(page)
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
monitor()
setInterval(monitor, 3 * 60 * 1000)