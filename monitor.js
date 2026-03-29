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
  parseSlotStartDateTimeSafe,
  normalizeCourtAlias
} = require('./utils/filters')
const { sleep, clickByText } = require('./utils/runtime')
const stats = require('./utils/stats')
const registerTelegramHandlers = require('./utils/telegramHandlers')


// ========================
// 配置 & 状态
// ========================
const CONFIG_FILE = './config.json'
const STATE_FILE = './lastSet.json'
const BOOKED_FILE = './bookedSlots.json'
const AUTO_BOOKED_FILE = './autoBooked.json'
const REMINDER_INDEX_FILE = './reminderIndex.json'
let bookedSlots = []
let remindedSet = new Set() // 防止重复提醒
let reminderIndex = {} // { [ucode]: [{ chatId, messageId }] }
let logBuffer = []
let currentSlotMap = new Map()
setupConsoleLogging(logBuffer)

let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))

function getSkipCourtContains(cfg) {
  const raw = cfg?.SKIP_COURT_CONTAINS
  if (!Array.isArray(raw)) return []
  return raw.map(s => String(s || '').trim()).filter(Boolean)
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function getDurationText(config) {
  return config.BOOK_DURATION_MAP?.[config.BOOK_DURATION]
}

function normalizeTimeRange(timeStr) {
  const raw = String(timeStr || '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ':')
    .replace(/～/g, '~')
    .trim()

  // already normalized like "11-13"
  if (/^\d{1,2}-\d{1,2}$/.test(raw)) return raw

  const [startRaw = '0', endRaw = '0'] = raw.split(/[~\-]/)
  const toHour = (s) => {
    const v = String(s || '').trim()
    if (!v) return '0'
    const h = Number(v.includes(':') ? v.split(':')[0] : v)
    return Number.isNaN(h) ? '0' : String(h)
  }

  return `${toHour(startRaw)}-${toHour(endRaw)}`
}

function buildUcode(d) {
  const placeMeta = config.PLACE_MAP?.[d.place] || {}
  const placeCode = placeMeta.courtCode || 'unknown'
  const courtCode = normalizeCourtAlias(d.court)
  const dayKey = parseSlotDayKey(d) || d.date || 'unknown-date'
  const timeRange = normalizeTimeRange(d.time)
  return `${placeCode}_${courtCode}_${dayKey}_${timeRange}`
}

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土']

/** 展示用：m.dd（水），与 date(yyyy-mm-dd)、ucode 分离 */
function formatDateDisplayFromIso(iso) {
  const s = String(iso || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const [y, mo, d] = s.split('-').map(Number)
  const dt = new Date(y, mo - 1, d)
  const w = WEEKDAY_JP[dt.getDay()]
  return `${mo}.${String(d).padStart(2, '0')}（${w}）`
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

function loadBookedSlots() {
  try {
    bookedSlots = JSON.parse(fs.readFileSync(BOOKED_FILE))
    let changed = false
    bookedSlots = bookedSlots.map(s => {
      const date = parseSlotDayKey(s) || s.date
      const time = normalizeTimeRange(s.time)
      const ucode = s.ucode || buildUcode({ ...s, date, time })
      const dateDisplay = s.dateDisplay || formatDateDisplayFromIso(date)
      const reminderEnabled = s.reminderEnabled !== false
      if (date !== s.date || time !== s.time || ucode !== s.ucode || dateDisplay !== s.dateDisplay) {
        changed = true
      }
      if (reminderEnabled !== s.reminderEnabled && s.reminderEnabled !== undefined) changed = true
      return { ...s, date, time, ucode, dateDisplay, reminderEnabled }
    })
    if (changed) saveBookedSlots()
    console.log('✅ 已加载 bookedSlots')
  } catch {
    bookedSlots = []
  }
}

function saveBookedSlots() {
  fs.writeFileSync(BOOKED_FILE, JSON.stringify(bookedSlots, null, 2))
}

function loadReminderIndex() {
  try {
    reminderIndex = JSON.parse(fs.readFileSync(REMINDER_INDEX_FILE))
  } catch {
    reminderIndex = {}
  }
}

function saveReminderIndex() {
  fs.writeFileSync(REMINDER_INDEX_FILE, JSON.stringify(reminderIndex, null, 2))
}

function registerReminderMessage(ucode, chatId, messageId) {
  if (!ucode || !chatId || !messageId) return
  if (!reminderIndex[ucode]) reminderIndex[ucode] = []
  reminderIndex[ucode].push({ chatId, messageId })
  saveReminderIndex()
}

/** 仅从索引移除（不删 Telegram 消息），用于同条消息里关掉单条提醒 */
function pruneReminderIndexForUcode(ucode) {
  if (!ucode || !reminderIndex[ucode]) return
  delete reminderIndex[ucode]
  saveReminderIndex()
}

async function deleteReminderMessagesByUcode(ucode) {
  const list = reminderIndex[ucode] || []
  if (list.length === 0) return 0

  const CONCURRENCY = 6
  let deleted = 0

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const chunk = list.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(item => bot.deleteMessage(item.chatId, String(item.messageId)))
    )
    deleted += results.filter(r => r.status === 'fulfilled').length
  }

  delete reminderIndex[ucode]
  saveReminderIndex()
  return deleted
}

async function clickSlot(page, d) {

  // ⭐ 若有 domId 且页面上仍存在该节点则直接点（结果页 id 常与监控页不一致，命中失败则走匹配）
  if (d.domId) {
    const el = await page.$(`#${d.domId}`)
    if (el) {
      await el.click()
      return
    }
  }

  // fallback：与 monitor 解析同一套表格结构 —— 日期在表头第 1 列，时间在各数据列顶格
  const found = await page.evaluate((d) => {

    const normalize = s =>
      String(s)
        .replace(/\s/g, '')
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/：/g, ':')
        .replace(/～/g, '~')

    const o = d.origin || d.oragin
    const targetPlace = normalize(o?.placeText ?? o?.place ?? d.place)
    const targetCourt = normalize(o?.courtText ?? o?.court ?? d.court)
    const targetIso = String(d.date || '').trim()
    const targetTimeRange = normalize(o?.timeText ?? o?.time ?? d.time)
    const originDateRaw = o?.dateText ?? o?.date
    const originTimeRaw = o?.timeText ?? o?.time

    const dateTextMatchesTarget = (textNorm) => {
      if (!textNorm) return false
      if (originDateRaw) {
        const on = normalize(originDateRaw)
        if (on && (textNorm.includes(on) || on.includes(textNorm))) return true
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(targetIso)) {
        const [y, mo, day] = targetIso.split('-').map(Number)
        const patterns = [
          normalize(`${y}年${mo}月${day}日`),
          normalize(`${y}年${String(mo).padStart(2, '0')}月${String(day).padStart(2, '0')}日`),
          normalize(`${mo}.${String(day).padStart(2, '0')}（`),
          normalize(`${mo}.${day}（`),
          normalize(`${String(mo).padStart(2, '0')}.${String(day).padStart(2, '0')}（`),
          normalize(`${mo}/${day}（`),
          normalize(`${mo}/${String(day).padStart(2, '0')}`),
          normalize(`${String(mo).padStart(2, '0')}/${String(day).padStart(2, '0')}`)
        ]
        if (patterns.some(p => p && textNorm.includes(p))) return true
      }
      const fallback = normalize(targetIso)
      return !!(fallback && textNorm.includes(fallback))
    }

    const columnHeaderHasOwnDate = (colNorm) =>
      /\d{4}年\d{1,2}月\d{1,2}日/.test(colNorm) ||
      /\d{1,2}月\d{1,2}日/.test(colNorm) ||
      /\d{1,2}\.\d{1,2}（[月火水木金土日]）/.test(colNorm) ||
      /\d{1,2}\/\d{1,2}（[月火水木金土日]）/.test(colNorm)

    const timeHeaderMatches = (headerNorm) => {
      if (!headerNorm) return false
      const mRange = targetTimeRange.match(/^(\d{1,2})-(\d{1,2})$/)
      if (mRange) {
        const hs = Number(mRange[1])
        const he = Number(mRange[2])
        const m = headerNorm.match(/(\d{1,2}):\d{2}[~\-](\d{1,2}):\d{2}/)
        if (m) return Number(m[1]) === hs && Number(m[2]) === he
        if (headerNorm.includes(`${hs}:`) && headerNorm.includes(`${he}:`)) return true
      }
      if (originTimeRaw) {
        const ot = normalize(originTimeRaw)
        if (ot && (headerNorm.includes(ot) || ot.includes(headerNorm))) return true
      }
      return headerNorm.includes(targetTimeRange)
    }

    function placeNameForDgTable(dgTable) {
      const tb = dgTable.closest('tbody')
      if (tb) {
        const a = tb.querySelector('a[id*="lnkShisetsu"]')
        if (a) return String(a.innerText).replace(/\s+/g, ' ').trim()
      }
      let p = dgTable.parentElement
      for (let n = 0; n < 28 && p; n++) {
        if (p.tagName === 'TABLE' && p !== dgTable) {
          const a = p.querySelector('a[id*="lnkShisetsu"]')
          if (a && !dgTable.contains(a)) return String(a.innerText).replace(/\s+/g, ' ').trim()
        }
        p = p.parentElement
      }
      return ''
    }

    /** 市川：0=利用日 1=定員 2..=時間帯；無「定員」則 1 起為時間帯 */
    function slotColumnStartIndex(headerTds) {
      const h1 = String(headerTds[1]?.innerText || '').replace(/\s/g, '')
      return h1.includes('定員') ? 2 : 1
    }

    const dgTables = document.querySelectorAll('table[id*="dgTable"]')

    for (const table of dgTables) {
      const placeRaw = placeNameForDgTable(table)
      const currentPlace = normalize(placeRaw)

      if (
        !currentPlace ||
        (!currentPlace.includes(targetPlace) && !targetPlace.includes(currentPlace))
      ) continue

      const rows = table.querySelectorAll('tr')
      if (rows.length < 2) continue

      const headerTds = rows[0].querySelectorAll('td')
      const slot0 = slotColumnStartIndex(headerTds)
      const rowDateNorm = normalize(headerTds[0]?.innerText || '')

      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const courtText = normalize(tds[0].innerText)

        if (!courtText.includes(targetCourt)) continue

        for (let j = slot0; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue

          const colHeaderNorm = normalize(headerTds[j]?.innerText || '')
          const dateOk = columnHeaderHasOwnDate(colHeaderNorm)
            ? dateTextMatchesTarget(colHeaderNorm)
            : dateTextMatchesTarget(colHeaderNorm) || dateTextMatchesTarget(rowDateNorm)
          if (!dateOk) continue
          if (!timeHeaderMatches(colHeaderNorm)) continue

          link.click()
          return true
        }
      }
    }

    return false

  }, d)

  if (!found) {
    throw new Error(`❌ 找不到 slot: ${d.place} ${d.court} ${d.date} ${d.time}`)
  }
}

// ✅ 添加预约
function addBookedSlot(d) {
  if (bookedSlots.some(s => s.uid === d.uid)) return
  const date = parseSlotDayKey(d) || d.date
  const time = normalizeTimeRange(d.time)
  bookedSlots.push({
    uid: d.uid,
    place: d.place,
    court: d.court,
    date,
    time,
    dateDisplay: d.dateDisplay || formatDateDisplayFromIso(date),
    ucode: buildUcode({ ...d, date, time }),
    reminderEnabled: true,
    bookedAt: Date.now(),
    create: new Date().toLocaleString()
  })

  saveBookedSlots()
}

// ❌ 删除预约
function removeBookedSlot(key) {
  const matched = bookedSlots.find(s => s.uid === key || s.ucode === key)
  bookedSlots = bookedSlots.filter(s => s.uid !== key && s.ucode !== key)
  saveBookedSlots()
  remindedSet.delete(key) // ⭐ 防止残留
  if (matched?.uid) remindedSet.delete(matched.uid)
}

function disableBookedReminder(key) {
  let changed = false
  let matchedUid = null

  bookedSlots = bookedSlots.map(s => {
    if (s.uid === key || s.ucode === key) {
      changed = true
      matchedUid = s.uid
      return { ...s, reminderEnabled: false }
    }
    return s
  })

  if (changed) {
    saveBookedSlots()
    remindedSet.delete(key)
    if (matchedUid) remindedSet.delete(matchedUid)
  }
  return changed
}

function getBookedSlots() {
  return [...bookedSlots]
}

// ✅ 获取未来预约
function getFutureBookedSlots() {
  const now = Date.now()
  return bookedSlots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })
}

// 🧹 清理过期
function cleanExpiredBooked() {
  const now = Date.now()

  bookedSlots = bookedSlots.filter(s => {
    const start = parseSlotStartDateTimeSafe(s)
    return start && start.getTime() > now
  })

  saveBookedSlots()
}

function loadAutoBooked() {
  try {
    const arr = JSON.parse(fs.readFileSync(AUTO_BOOKED_FILE))
    autoBookedUIDs = new Set(arr)
  } catch {
    autoBookedUIDs = new Set()
  }
}

function saveAutoBooked() {
  fs.writeFileSync(AUTO_BOOKED_FILE, JSON.stringify([...autoBookedUIDs], null, 2))
}

// ========================
// Telegram 原有
// ========================
function formatTimeDisplay(time) {
  const raw = String(time || '').trim()
  const m = raw.match(/^(\d{1,2})-(\d{1,2})$/)
  if (m) return `${String(m[1]).padStart(2, '0')}:00–${String(m[2]).padStart(2, '0')}:00`
  return raw.replace('~', '–')
}

const TG_INLINE_BTN_TEXT_MAX = 64

function truncateTelegramButtonText(s, max = TG_INLINE_BTN_TEXT_MAX) {
  const str = String(s || '')
  if (str.length <= max) return str
  const chars = Array.from(str)
  if (chars.length <= max) return str
  return chars.slice(0, max - 1).join('') + '…'
}

/** 预约提醒：单行 🔕 按钮文案（关闭提醒，不删记录） */
function formatReminderMuteButtonLabel(d) {
  const meta = config.PLACE_MAP[d.place] || {}
  const placeShort = (meta.short || d.place || '').trim()
  const court = String(formatCourt(d.court) || '').toUpperCase()
  const t = formatTimeDisplay(d.time)
  const em = meta.emoji || '🎾'
  const s = `🔕 ${em} ${placeShort} ${court} · ${t}`
  return truncateTelegramButtonText(s)
}

function formatText(d, options = {}) {
  const { showBike = false, style = 'compact' } = options

  const meta = config.PLACE_MAP[d.place] || {}
  const placeShort = meta.short || d.place
  const emoji = meta.emoji || '🎾'
  const bike = showBike && meta.bike ? ` ${meta.bike}` : ''
  const courtDisplay = String(formatCourt(d.court) || '').toUpperCase()

  let shortDate = d.dateDisplay
  if (!shortDate && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
    shortDate = formatDateDisplayFromIso(d.date)
  }
  if (!shortDate) {
    const dateMatch = String(d.date || '').match(/(\d+)年(\d+)月(\d+)日（(.)）/)
    if (dateMatch) {
      shortDate = `${dateMatch[2]}.${dateMatch[3]}（${dateMatch[4]}）`
    } else {
      shortDate = d.date
    }
  }

  const shortTime = formatTimeDisplay(d.time)

  if (style === 'detail') {
    return `${emoji} ${placeShort}｜${courtDisplay}\n📅 ${shortDate} ⏰ ${shortTime}${bike}`
  }

  return `${emoji} ${placeShort} ${formatCourt(d.court)} ${shortDate} ${shortTime}${bike}`
}

function eligibleForBookedSummary(s) {
  if (s.reminderEnabled === false) return false
  const intervalMs = getBookedReminderIntervalMs()
  if (s.bookedAt == null) return true
  return Date.now() >= s.bookedAt + intervalMs
}

async function pushBookedReminder() {
  const future = getFutureBookedSlots().filter(eligibleForBookedSummary)

  if (future.length === 0) return

  // ========================
  // ⭐ 按天分组
  // ========================
  const grouped = new Map()

  for (const d of future) {
    const dayKey = d.date // yyyy-mm-dd

    if (!grouped.has(dayKey)) grouped.set(dayKey, [])
    grouped.get(dayKey).push(d)
  }

  // ========================
  // ⭐ 每天一条消息
  // ========================
  for (const [dayKey, list] of grouped.entries()) {

    // 按时间排序
    list.sort((a, b) => {
      const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? 0
      const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? 0
      return ta - tb
    })

    const dayTitle = list[0].dateDisplay || formatDateDisplayFromIso(dayKey) || dayKey
    const buttons = list.map(d => [
      {
        text: formatReminderMuteButtonLabel(d),
        callback_data: `del_booked_${d.ucode}`
      }
    ])

    const sent = await bot.sendMessage(
      process.env.CHAT_ID,
      `📅 已预约提醒（${dayTitle}）\n` +
        `━━━━━━━━━━━━━━\n` +
        ``,
      {
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    )
    for (const d of list) {
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id)
    }
  }
}

async function pushUpcomingReminder() {
  const future = getFutureBookedSlots().filter(s => s.reminderEnabled !== false)
  const now = Date.now()

  for (const d of future) {
    const start = parseSlotStartDateTimeSafe(d)
    if (!start) continue

    const diffMin = (start.getTime() - now) / 60000

    // ✅ 触发条件：0~60分钟
    if (diffMin > 0 && diffMin <= 60) {

      if (remindedSet.has(d.uid)) continue // 防重复

      remindedSet.add(d.uid)

      const sent = await bot.sendMessage(
        process.env.CHAT_ID,
        `⏰ *即将开始（1小时内）*\n━━━━━━━━━━━━━━\n${formatText(d, { style: 'detail' })}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: formatReminderMuteButtonLabel(d),
                callback_data: `del_booked_${d.ucode}`
              }
            ]]
          }
        }
      )
      registerReminderMessage(d.ucode, sent.chat.id, sent.message_id)
    }
  }
}

async function sendTelegram(data, version, title = '🆕 可预约（点击直接预约）') {
  const buttons = data.slice(0, config.MAX_PUSH).map((d, i) => ({
    text: `${formatText(d)}`,
    callback_data: `book_${d.ucode}`
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
let autoBookedUIDs = new Set()
let isFirstRun = true
let timer = null
let lastBookedReminderAt = 0

function getBookedReminderIntervalMs() {
  const hours = Number(config.BOOKED_REMINDER_INTERVAL_HOURS)
  if (Number.isFinite(hours) && hours > 0) {
    return Math.floor(hours * 60 * 60 * 1000)
  }
  return 2 * 60 * 60 * 1000
}

async function pushBookedReminderBySchedule() {
  const now = Date.now()
  if (now - lastBookedReminderAt < getBookedReminderIntervalMs()) return
  await pushBookedReminder()
  lastBookedReminderAt = now
}


// ========================
// 监控
// ========================
async function monitor(options = {}) {
  const { forcePush = false } = options
  const trace = createTrace()
  logStep(trace, 'START')

  if (booking) {
    logStep(trace, 'SKIP', '正在预约，跳过')
    return
  }
  let browser
  try {
    browser = await chromium.launch({
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

    await clickByText(page, getDurationText(config))
    await sleep(config.STEP_DELAY)

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])

    await page.evaluate(({ autoWeekdays, skipCourtContains }) => {
      let count = 0
      const MAX = 10

      const shouldSkipCourtRow = (rowCourtNorm) =>
        Array.isArray(skipCourtContains) &&
        skipCourtContains.some(sub => sub && rowCourtNorm.includes(sub))
    
      const weekdayMap = {
        '日': 0,
        '月': 1,
        '火': 2,
        '水': 3,
        '木': 4,
        '金': 5,
        '土': 6
      }
    
      const preferred = autoWeekdays.map(w => weekdayMap[w])
    
      const tables = document.querySelectorAll('table[id*="dgTable"]')
    
      const candidates = []
    
      // ========================
      // ⭐ 收集所有可点击 slot + 对应星期
      // ========================
      tables.forEach(table => {
        const rows = table.querySelectorAll('tr')
        if (rows.length === 0) return
    
        const headers = rows[0].querySelectorAll('td')
        const h1 = String(headers[1]?.innerText || '').replace(/\s/g, '')
        const slot0 = h1.includes('定員') ? 2 : 1
    
        const row0Wd = String(headers[0]?.innerText || '')
          .replace(/\s/g, '')
          .match(/（([月火水木金土日])）/)
        const rowWeekday = row0Wd ? row0Wd[1] : null
    
        const colWeekdays = []
        for (let i = slot0; i < headers.length; i++) {
          const text = headers[i].innerText.replace(/\s/g, '')
          const m = text.match(/（([月火水木金土日])）/)
          colWeekdays.push(m ? m[1] : rowWeekday)
        }
    
        for (let i = 1; i < rows.length; i++) {
          const tds = rows[i].querySelectorAll('td')
          const rowCourt = (tds[0]?.innerText || '').replace(/\s/g, '')
          if (shouldSkipCourtRow(rowCourt)) continue
    
          for (let j = slot0; j < tds.length; j++) {
            const link = tds[j].querySelector('a')
            if (!link) continue
    
            const val = link.innerText.replace(/\s/g, '')
            if (val !== '○' && val !== '△') continue
    
            const weekday = colWeekdays[j - slot0]
            candidates.push({
              el: link,
              weekday,
            })
          }
        }
      })
    
      // ========================
      // ⭐ 1️⃣ 先选 AUTO_WEEKDAY
      // ========================
      for (const c of candidates) {
        if (count >= MAX) break
    
        const wd = weekdayMap[c.weekday]
        if (preferred.includes(wd)) {
          c.el.click()
          c.el.dataset.selected = '1'
          count++
        }
      }
    
      // ========================
      // ⭐ 2️⃣ 再补剩余
      // ========================
      for (const c of candidates) {
        if (count >= MAX) break
        if (c.el.dataset.selected) continue
    
        c.el.click()
        count++
      }
    
    }, {
      autoWeekdays: config.AUTO_WEEKDAY_FILTER || [],
      skipCourtContains: getSkipCourtContains(config)
    })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('#ucPCFooter_btnForward')
    ])


    const rawData = await page.evaluate((skipCourtContains) => {
      const shouldSkipCourtRow = (courtText) =>
        Array.isArray(skipCourtContains) &&
        skipCourtContains.some(sub => sub && String(courtText).includes(sub))

      const halfNum = (s) =>
        String(s).replace(/[０-９]/g, ch =>
          String.fromCharCode(ch.charCodeAt(0) - 0xfee0))

      /** 每列表头常带独立「利用日」；不能用第 0 列日期代表整行 */
      function resolveRawDateTimeForColumn(headers, j, timesArr, slotColStart) {
        const row0 = halfNum(headers[0].innerText).replace(/\s/g, '')
        const col = halfNum(headers[j].innerText).replace(/\s/g, '')
        let rawDate = row0
        let rawTime = timesArr[j - slotColStart]

        const ymdCol = col.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
        if (ymdCol) {
          rawDate = ymdCol[0]
          let rest = col.slice(ymdCol.index + ymdCol[0].length)
          const wd = rest.match(/^（[月火水木金土日]）/)
          if (wd) {
            rawDate += wd[0]
            rest = rest.slice(wd[0].length)
          }
          const tm = rest.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
          if (tm) rawTime = `${tm[1]}～${tm[2]}`
          return { rawDate, rawTime }
        }

        const mdCol = col.match(/(\d{1,2})月(\d{1,2})日/)
        if (mdCol) {
          const yFromRow = row0.match(/(\d{4})年/)
          if (yFromRow) {
            rawDate = `${yFromRow[1]}年${mdCol[1]}月${mdCol[2]}日`
            let rest = col.slice(mdCol.index + mdCol[0].length)
            const wd = rest.match(/^（[月火水木金土日]）/)
            if (wd) {
              rawDate += wd[0]
              rest = rest.slice(wd[0].length)
            }
            const tm = rest.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
            if (tm) rawTime = `${tm[1]}～${tm[2]}`
            return { rawDate, rawTime }
          }
        }

        const dotMd = col.match(/(\d{1,2})\.(\d{1,2})（([月火水木金土日])）/)
        if (dotMd) {
          const ymdRow = row0.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
          if (ymdRow) {
            rawDate =
              `${ymdRow[1]}年${Number(dotMd[1])}月${Number(dotMd[2])}日（${dotMd[3]}）`
            const after = col.slice(dotMd.index + dotMd[0].length)
            const tm = after.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
            if (tm) rawTime = `${tm[1]}～${tm[2]}`
            return { rawDate, rawTime }
          }
        }

        const slashMd = col.match(/(\d{1,2})\/(\d{1,2})（([月火水木金土日])）/)
        if (slashMd) {
          const ymdRow = row0.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
          if (ymdRow) {
            rawDate =
              `${ymdRow[1]}年${Number(slashMd[1])}月${Number(slashMd[2])}日（${slashMd[3]}）`
            const after = col.slice(slashMd.index + slashMd[0].length)
            const tm = after.match(/(\d{1,2}:\d{2})[～~\-](\d{1,2}:\d{2})/)
            if (tm) rawTime = `${tm[1]}～${tm[2]}`
            return { rawDate, rawTime }
          }
        }

        return { rawDate, rawTime }
      }

      function placeNameForDgTable(dgTable) {
        const tb = dgTable.closest('tbody')
        if (tb) {
          const a = tb.querySelector('a[id*="lnkShisetsu"]')
          if (a) return String(a.innerText).replace(/\s+/g, ' ').trim()
        }
        let p = dgTable.parentElement
        for (let n = 0; n < 28 && p; n++) {
          if (p.tagName === 'TABLE' && p !== dgTable) {
            const a = p.querySelector('a[id*="lnkShisetsu"]')
            if (a && !dgTable.contains(a)) return String(a.innerText).replace(/\s+/g, ' ').trim()
          }
          p = p.parentElement
        }
        return ''
      }

      function slotColumnStartIndex(headerTds) {
        const h1 = String(headerTds[1]?.innerText || '').replace(/\s/g, '')
        return h1.includes('定員') ? 2 : 1
      }

      const result = []
      const dgTables = document.querySelectorAll('table[id*="dgTable"]')

      for (const table of dgTables) {
        const currentPlace = placeNameForDgTable(table)

        const rows = table.querySelectorAll('tr')
        const headers = rows[0].querySelectorAll('td')
        const slot0 = slotColumnStartIndex(headers)

        const times = []
        for (let i = slot0; i < headers.length; i++) {
          times.push(headers[i].innerText.replace(/\s/g, ''))
        }

        for (let i = 1; i < rows.length; i++) {
          const tds = rows[i].querySelectorAll('td')
          const court = tds[0].innerText.trim()
          if (shouldSkipCourtRow(court)) continue

          for (let j = slot0; j < tds.length; j++) {
            const link = tds[j].querySelector('a')
            if (!link) continue

            const val = link.innerText.replace(/\s/g, '')

            if (val === '○' || val === '△') {
              const { rawDate: rawDateCompact, rawTime: rawTimeFromCol } =
                resolveRawDateTimeForColumn(headers, j, times, slot0)
              const rawDate = rawDateCompact
              const rawTime = rawTimeFromCol
              const formatStr = str => String(str)
              .toLowerCase()
              .replace(/\u3000/g, ' ')
              .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
              .replace(/\s+/g, ' ')
              .trim()
              // 统一格式
              const dateMatch = rawDate.match(/(\d+)年(\d+)月(\d+)日/);
              let dateFormatted = rawDate;
              let dateDisplay = '';
              if (dateMatch) {
                const y = dateMatch[1];
                const mo = String(dateMatch[2]).padStart(2, '0');
                const d = String(dateMatch[3]).padStart(2, '0');
                dateFormatted = `${y}-${mo}-${d}`; // YYYY-MM-DD
                const moNum = Number(dateMatch[2]);
                const dday = String(dateMatch[3]).padStart(2, '0');
                const wdMatch = rawDate.match(/（([月火水木金土日])）/);
                dateDisplay = wdMatch
                  ? `${moNum}.${dday}（${wdMatch[1]}）`
                  : `${moNum}.${dday}`;
              }

              const normalized = rawTime
                .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
                .replace(/：/g, ':')
                .replace(/～/g, '~')
                .trim();
              const [startRaw = '0', endRaw = '0'] = normalized.split('~');
              const toHour = (s) => {
                const t = String(s || '').trim();
                const h = Number(t.includes(':') ? t.split(':')[0] : t);
                return Number.isNaN(h) ? '0' : String(h);
              };
              const timeFormatted = `${toHour(startRaw)}-${toHour(endRaw)}`; // 13-15
              
              result.push({
                origin: {
                  place: currentPlace,
                  court,
                  domId: link.id,
                  time: rawTime,
                  date: rawDate
                },
                place: currentPlace,
                court: formatStr(court),
                date: dateFormatted,
                time: timeFormatted,
                dateDisplay,
                domId: link.id, // ⭐ 用于点击
                uid: formatStr(`${currentPlace}_${court}_${dateFormatted}_${timeFormatted}`)
              })
            }
          }
        }
      }

      return result
    }, getSkipCourtContains(config))

    logStep(trace, 'PARSE', `抓取数据: ${rawData.length}条`)

    // ========================
    // 处理数据
    // ========================
    const sourceData = rawData.map(d => {
      const date = parseSlotDayKey(d) || d.date
      const time = normalizeTimeRange(d.time)
      const dateDisplay = d.dateDisplay || formatDateDisplayFromIso(date)

      const ucode = buildUcode({ ...d, date, time })

      return {
        ...d,
        date,
        time,
        dateDisplay,
        ucode
      }
    })

    // ⭐ 建立映射（核心）
    const slotMap = new Map()
    for (const d of sourceData) {
      slotMap.set(d.ucode, d)
    }


    const data = filterSlotsByConfig(sourceData, config)
    currentData = data
    currentVersion = Date.now()
    currentSlotMap = slotMap

    logStep(trace, 'FILTER', `过滤后: ${data.length}条`)

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

    lastSet = new Set(data.map(d => d.uid))
    saveLastSet()

    if (added.length > 0) {
      // 先按“通知规则”处理 Telegram（如果你开了通知）
      if (config.NOTIFY_ADDED) {
        logStep(trace, 'PUSH', `发送新增通知 ${added.length}`)

        currentData = added
        currentVersion = Date.now()

        await sendTelegram(added, currentVersion, '✨ 有新场地！点击直接预约')
      }

      // 再按“自动抢规则”挑选最合适的 slot 去预约
      if (config.AUTO_BOOK && !autoBooking) {
        const autoCandidates = filterSlotsAuto(added, config)

        if (autoCandidates.length === 0) {
          logStep(trace, 'AUTO_BOOK', `无匹配项（added=${added.length}）`)
        } else {
          const now = Date.now()

          // ✅ 基础过滤
          const candidates = autoCandidates.filter(d => {
            const startDate = parseSlotStartDateTimeSafe(d)
            if (!startDate) return false
          
            const now = Date.now()
            const diffMin = (startDate.getTime() - now) / 60000
          
            // ❌ 太近的不抢
            if (diffMin < 20) return false
          
            const dayKey = parseSlotDayKey(d)
          
            // ❌ 已经抢过这一天（你原有逻辑）
            if (dayKey && autoBookedDayKeys.has(dayKey)) return false
          
            // ❌ ⭐ 已经抢过这个 slot（新增核心）
            if (autoBookedUIDs.has(d.uid)) return false
          
            return true
          })

          if (candidates.length === 0) {
            logStep(trace, 'AUTO_BOOK', `筛选后无候选（added=${added.length}，auto=${autoCandidates.length}）`)
          } else {

            // ========================
            // ⭐ 按天分组
            // ========================
            const grouped = new Map()

            for (const d of candidates) {
              const dayKey = parseSlotDayKey(d)
              if (!dayKey) continue

              if (!grouped.has(dayKey)) grouped.set(dayKey, [])
              grouped.get(dayKey).push(d)
            }

            // ========================
            // ⭐ 每天选最晚一个
            // ========================
            const targets = []

            for (const [dayKey, list] of grouped.entries()) {
              list.sort((a, b) => {
                const ta = parseSlotStartDateTimeSafe(a)?.getTime() ?? -Infinity
                const tb = parseSlotStartDateTimeSafe(b)?.getTime() ?? -Infinity
                return tb - ta
              })

              const best = list[0]
              targets.push(best)
            }

            if (targets.length === 0) {
              logStep(trace, 'AUTO_BOOK', '分组后无目标')
              return
            }

            logStep(
              trace,
              'AUTO_BOOK',
              `准备一次性预约 ${targets.length} 个：` +
              targets.map(d => `${d.place} ${d.time}`).join(' | ')
            )

            autoBooking = true

            try {
              // ========================
              // ⭐ 一次性点击多个 slot
              // ========================
              await Promise.all(
                targets.map(async d => {
                  logStep(trace, 'AUTO_BOOK', `选中 ${d.place} ${d.time}`)
                  try {
                    await clickSlot(page, d)
                  } catch (e) {
                    logStep(trace, 'AUTO_BOOK_CLICK_FAIL', `${d.domId}`)
                    throw e
                  }
                })
              )

              // ========================
              // ⭐ 一次提交
              // ========================
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle' }),
                page.click('#ucPCFooter_btnForward')
              ])

              await handleLoginIfNeeded(page)
              await clickApply(page)

              // ========================
              // ⭐ 标记已预约的日期
              // ========================
              for (const d of targets) {
                const dayKey = parseSlotDayKey(d)
              
                addBookedSlot(d)
              
                if (dayKey) autoBookedDayKeys.add(dayKey)
              
                // ⭐ 标记这个 slot 已经抢过
                autoBookedUIDs.add(d.uid)
                saveAutoBooked()
              }

              // ========================
              // ⭐ 通知
              // ========================
              await bot.sendMessage(
                process.env.CHAT_ID,
                `🎉 *自动预约成功（多场）！*\n━━━━━━━━━━━━━━\n` +
                targets.map(d => formatText(d, { showBike: true, style: 'detail' })).join('\n\n'),
                { parse_mode: 'Markdown' }
              )

              setTimeout(() => monitor({ forcePush: true }), 1000)

            } catch (e) {
              // ⭐ 防止失败反复抢同一个 slot
              for (const d of targets) {
                autoBookedUIDs.add(d.uid)
              }

              await bot.sendMessage(
                process.env.CHAT_ID,
                `❌ *自动预约失败（多场）*\n━━━━━━━━━━━━━━\n` +
                targets.map(d => formatText(d, { style: 'detail' })).join('\n\n') +
                `\n\n🧨 ${e.message}`,
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
  }finally {
    if (browser) await browser.close()
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
  // ========================
  // ✅ 优先点击 AUTO_WEEKDAY_FILTER（比如 土日）
  // ✅ 不够 10 个 → 再补其他
  // ✅ 不影响 monitor 全量扫描能力
  // ========================
  await page.evaluate(({ autoWeekdays, skipCourtContains }) => {
    let count = 0
    const MAX = 10

    const shouldSkipCourtRow = (rowCourtNorm) =>
      Array.isArray(skipCourtContains) &&
      skipCourtContains.some(sub => sub && rowCourtNorm.includes(sub))
  
    const weekdayMap = {
      '日': 0,
      '月': 1,
      '火': 2,
      '水': 3,
      '木': 4,
      '金': 5,
      '土': 6
    }
  
    const preferred = autoWeekdays.map(w => weekdayMap[w])
  
    const tables = document.querySelectorAll('table[id*="dgTable"]')
  
    const candidates = []

    // ========================
    // ⭐ 收集所有可点击 slot + 对应星期
    // ========================
    tables.forEach(table => {
      const rows = table.querySelectorAll('tr')
      if (rows.length === 0) return
  
      const headers = rows[0].querySelectorAll('td')
      const h1 = String(headers[1]?.innerText || '').replace(/\s/g, '')
      const slot0 = h1.includes('定員') ? 2 : 1
  
      const row0Wd = String(headers[0]?.innerText || '')
        .replace(/\s/g, '')
        .match(/（([月火水木金土日])）/)
      const rowWeekday = row0Wd ? row0Wd[1] : null
  
      const colWeekdays = []
      for (let i = slot0; i < headers.length; i++) {
        const text = headers[i].innerText.replace(/\s/g, '')
        const m = text.match(/（([月火水木金土日])）/)
        colWeekdays.push(m ? m[1] : rowWeekday)
      }
  
      for (let i = 1; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td')
        const rowCourt = (tds[0]?.innerText || '').replace(/\s/g, '')
        if (shouldSkipCourtRow(rowCourt)) continue
        for (let j = slot0; j < tds.length; j++) {
          const link = tds[j].querySelector('a')
          if (!link) continue
  
          const val = link.innerText.replace(/\s/g, '')
          if (val !== '○' && val !== '△') continue
  
          const weekday = colWeekdays[j - slot0]
  
          candidates.push({
            el: link,
            weekday,
          })
        }
      }
    })
  
    // ========================
    // ⭐ 1️⃣ 先选 AUTO_WEEKDAY
    // ========================
    for (const c of candidates) {
      if (count >= MAX) break
  
      const wd = weekdayMap[c.weekday]
      if (preferred.includes(wd)) {
        c.el.click()
        c.el.dataset.selected = '1'
        count++
      }
    }
  
    // ========================
    // ⭐ 2️⃣ 再补剩余
    // ========================
    for (const c of candidates) {
      if (count >= MAX) break
      if (c.el.dataset.selected) continue
  
      c.el.click()
      count++
    }
  
  }, {
    autoWeekdays: config.AUTO_WEEKDAY_FILTER || [],
    skipCourtContains: getSkipCourtContains(config)
  })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '点击目标slot')
  await clickSlot(page, d)

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#ucPCFooter_btnForward')
  ])

  logStep(trace, 'BOOK', '提交预约')
  await handleLoginIfNeeded(page)
  await clickApply(page)

  await bot.sendMessage(
    process.env.CHAT_ID,
    `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n` +
    formatText(d, { showBike: true, style: 'detail' }),
    { parse_mode: 'Markdown' }
  )
  addBookedSlot(d)
  logStep(trace, 'BOOK_SUCCESS', `${d.court} ${d.time}`)

  await browser.close()
}

registerTelegramHandlers({
  bot,
  config,
  isAdmin,
  getCurrentData: () => currentData,
  getCurrentVersion: () => currentVersion,
  getSlotMap: () => currentSlotMap,
  getBooking: () => booking,
  setBooking: (v) => { booking = v },
  getTimer: () => timer,
  setTimer: (v) => { timer = v },
  monitor,
  bookOne,
  formatText,
  saveConfig,
  getLogFile,
  getLogBuffer: () => logBuffer,
  removeBookedSlot,
  disableBookedReminder,
  deleteReminderMessagesByUcode,
  pruneReminderIndexForUcode,
  getBookedSlots
})

// ========================
loadLastSet()
loadAutoBooked()
loadBookedSlots()
loadReminderIndex()

cleanOldLogs(30)

monitor()
timer = setInterval(monitor, Math.floor(Math.random() * (60) + config.INTERVAL) * 1000)
setInterval(() => cleanOldLogs(30), 24 * 60 * 60 * 1000)
// 预约提醒间隔
setInterval(pushBookedReminderBySchedule, 60 * 1000)
setInterval(pushUpcomingReminder, 60 * 1000)
setInterval(cleanExpiredBooked, 24 * 60 * 60 * 1000)