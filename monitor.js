require('dotenv').config()
const { chromium } = require('playwright')
const TelegramBot = require('node-telegram-bot-api')

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const TARGET_PLACE = [
  '菅野終末処理場テニスコート',
  '福栄スポーツ広場テニスコート',
  '行徳・塩焼中央公園テニスコート'
]

let currentData = []
let currentVersion = 0
let booking = false

// ========================
// 通用点击（更稳）
// ========================
async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

// ========================
// 监控
// ========================
async function monitor() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  await page.goto('https://reserve.city.ichikawa.lg.jp/')

  await clickByText(page, 'スポーツ施設')

  for (const place of TARGET_PLACE) {
    await clickByText(page, place)
  }

  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)

  await clickByText(page, '2週間')
  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(500)

  // 👉 选 ○ △
  await page.evaluate(() => {
    const tables = document.querySelectorAll('table[id*="dgTable"]')

    for (const table of tables) {
      const rows = table.querySelectorAll('tr')

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')

        for (let j = 2; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const val = link.innerText.replace(/\s/g, '')
          if (val === '○' || val === '△') {
            link.click()
          }
        }
      }
    }
  })

  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)

  // ========================
  // ✅ 正确解析（核心修复）
  // ========================
  const data = await page.evaluate(() => {
    const result = []
    let currentPlace = ''

    const tables = document.querySelectorAll('table')

    for (const table of tables) {

      // 👉 识别场地名
      const placeEl = table.querySelector('a[id*="lnkShisetsu"]')
      if (placeEl) {
        currentPlace = placeEl.innerText.trim()
        continue
      }

      // 👉 只处理数据表
      if (!table.id || !table.id.includes('dgTable')) continue

      const rows = table.querySelectorAll('tr')
      if (rows.length < 2) continue

      const headers = rows[0].querySelectorAll('td')

      const times = []
      for (let i = 2; i < headers.length; i++) {
        times.push(headers[i].innerText.replace(/\s/g, ''))
      }

      const date = headers[0].innerText.replace(/\s/g, '')

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const court = tds[0].innerText.trim()
        for (let j = 2; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const val = link.innerText.replace(/\s/g, '')

          if (val === '○' || val === '△') {
            result.push({
              place: currentPlace,   // ✅ 修复
              court,
              date: headers[0].innerText.replace(/\s/g, ''), // ⭐关键
              time: times[j - 2], // ⭐关键
              id: link.id
            })
          }
        }
      }
    }

    return result
  })

  console.log('可预约:', data.length)

  if (data.length > 0) {
    currentData = data
    currentVersion = Date.now()

    await sendTelegram(data, currentVersion)
  }

  // await browser.close()
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

    const timeMatch = d.time.match(/(\d+):\d+～(\d+):\d+/)
    // const shortTime = timeMatch
    //   ? `${timeMatch[1]}~${timeMatch[2]}`
    //   : d.time

    const placeShort = d.place.replace('テニスコート', '')
    return {
      text: `🎾 ${d.court} ${shortDate} ${d.time}`,
      callback_data: `${version}_${i}`
    }
  })

  const inline_keyboard = buttons.map(btn => [btn])

  await bot.sendMessage(
    process.env.CHAT_ID,
    '发现可预约时间👇（点一个预约）',
    { reply_markup: { inline_keyboard } }
  )
}

// ========================
// 点击预约
// ========================
bot.on('callback_query', async (query) => {
  if (booking) {
    return bot.answerCallbackQuery(query.id, { text: '已有任务在执行中' })
  }

  const [version, indexStr] = query.data.split('_')
  const index = Number(indexStr)

  if (Number(version) !== currentVersion) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ 数据已过期' })
  }

  const d = currentData[index]
  if (!d || !d.place) {
    return bot.answerCallbackQuery(query.id, { text: '数据异常' })
  }

  booking = true
  await bot.answerCallbackQuery(query.id, { text: '正在预约...' })

  try {
    await bookOne(d)

    await bot.sendMessage(
      process.env.CHAT_ID,
      `✅ 成功\n${d.place}\n${d.court}\n${d.date}\n${d.time}`
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
// ✅ 预约逻辑（已修复反向匹配）
// ========================
async function bookOne(d) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  await page.goto('https://reserve.city.ichikawa.lg.jp/')

  await clickByText(page, 'スポーツ施設')
  await clickByText(page, d.place)

  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)

  await clickByText(page, '2週間')
  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)

  await page.evaluate(() => {
    const tables = document.querySelectorAll('table[id*="dgTable"]')

    for (const table of tables) {
      const rows = table.querySelectorAll('tr')

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')

        for (let j = 2; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const val = link.innerText.replace(/\s/g, '')
          if (val === '○' || val === '△') {
            link.click()
          }
        }
      }
    }
  })
  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)
  // ========================
  // ✅ 直接点日期（核心）
  // ========================
  if (!d.id) {
    throw new Error('❌ 没有可用ID')
  }

  try {
    await page.click(`#${d.id}`, { timeout: 2000 })
  } catch (e) {
    // 👉 兜底（防 ctl 变化）
    const dateIdMatch = d.id.match(/b(\d{8})/)
    if (!dateIdMatch) throw new Error('❌ ID解析失败')

    const dateId = dateIdMatch[1]
    const selector = `a[id$="b${dateId}"]`

    await page.click(selector)
  }

  await page.waitForTimeout(1000)

  // ========================
  // 下一步
  // ========================
  await page.click('#ucPCFooter_btnForward')
  await page.waitForTimeout(1000)

  // 👉 后面你的“选时间”逻辑可以先不动
  await handleLoginIfNeeded(page)

  // ✅ 登录后 or 本来就登录 → 点申込
  await clickApply(page)

}

// ========================
// ✅ 登录
// ========================
async function handleLoginIfNeeded(page) {
  try {
    const btn = page.locator('#ucPCFooter_btnForward');

    if (!(await btn.isVisible())) return;

    const value = await btn.inputValue();

    if (!value.includes('ログイン')) return;

    console.log('🔐 检测到登录页，开始自动登录');

    await page.waitForSelector('#txtID', { timeout: 5000 });

    await page.fill('#txtID', process.env.USER_ID);
    await page.fill('#txtPass', process.env.PASSWORD);

    await page.waitForTimeout(300);

    await btn.click();

    // ✅ 关键：等页面稳定
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    console.log('✅ 登录成功');

  } catch (e) {
    console.log('⚠️ 登录流程异常:', e.message);
  }
}

async function clickApply(page) {
  try {
    const btn = page.locator('#ucPCFooter_btnForward')

    await btn.waitFor({ timeout: 5000 })

    const value = await btn.inputValue()

    if (value.includes('申込')) {
      console.log('📝 点击申込')

      await btn.click()
      await page.waitForLoadState('networkidle')

      console.log('✅ 申込完成')
    } else {
      console.log('⚠️ 当前不是申込按钮:', value)
    }

  } catch (e) {
    console.log('❌ 申込失败:', e.message)
  }
}

// ========================
monitor()

// setInterval(monitor, 5 * 60 * 1000)