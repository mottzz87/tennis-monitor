const fs = require('fs')
const path = require('path')

const LOG_ADDED = path.join('stats', 'added.log')
const LOG_REMOVED = path.join('stats', 'removed.log')

function startOfLocalDayMs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 统计周期：从 cutoff 时间戳到「现在」的累计（毫秒时间戳） */
const PERIODS = [
  { label: '今天', cutoff: startOfLocalDayMs },
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '近半年', days: 182 },
  { label: '近一年', days: 365 }
]

function periodCutoff(period) {
  if (typeof period.cutoff === 'function') return period.cutoff()
  const d = period.days
  if (!d) return 0
  return Date.now() - d * 24 * 60 * 60 * 1000
}

function readLogLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const out = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip
    }
  }
  return out
}

function filterSince(list, cutoffMs) {
  return list.filter(i => typeof i.time === 'number' && i.time >= cutoffMs)
}

// ========================
// 📥 记录
// ========================
function record(type, list) {
  if (!list || list.length === 0) return

  const now = Date.now()
  const hour = new Date().getHours()

  const file = `./stats/${type}.log`
  fs.mkdirSync('./stats', { recursive: true })

  const lines = list.map(d => JSON.stringify({
    time: now,
    hour,
    place: d.place,
    court: d.court,
    date: d.date,
    slot: d.time,
    id: d.uid
  })).join('\n') + '\n'

  fs.appendFileSync(file, lines)
}

function groupByHour(list) {
  const map = {}
  list.forEach(i => {
    const h = i.hour
    if (h === undefined || h === null) return
    map[h] = (map[h] || 0) + 1
  })
  return map
}

function groupByPlace(list) {
  const map = {}
  list.forEach(i => {
    const p = i.place || '（未知）'
    map[p] = (map[p] || 0) + 1
  })
  return map
}

function topNFromMap(map, n = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => {
      const short = k.length > 14 ? `${k.slice(0, 12)}…` : k
      return `${short}×${v}`
    })
    .join(' · ') || '—'
}

function calcSpeedBuckets(stats) {
  const addedMap = new Map()
  stats.added.forEach(a => {
    if (!a.id) return
    const t = a.time
    if (!addedMap.has(a.id) || t < addedMap.get(a.id)) {
      addedMap.set(a.id, t)
    }
  })

  const buckets = {
    '≤1m': 0,
    '≤3m': 0,
    '≤10m': 0,
    '≤1h': 0,
    '>1h': 0
  }

  let paired = 0
  stats.removed.forEach(r => {
    if (!r.id || !addedMap.has(r.id)) return
    const diff = (r.time - addedMap.get(r.id)) / 1000
    if (diff < 0) return
    paired++
    if (diff <= 60) buckets['≤1m']++
    else if (diff <= 180) buckets['≤3m']++
    else if (diff <= 600) buckets['≤10m']++
    else if (diff <= 3600) buckets['≤1h']++
    else buckets['>1h']++
  })

  return { paired, buckets }
}

function formatSpeedLine(b) {
  const { paired, buckets } = b
  if (paired === 0) return '配对0次（需同 uid 先出现再消失）'
  return `配对${paired}次 ` + Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')
}

function summarizePeriod(label, cutoffMs, allAdded, allRemoved) {
  const added = filterSince(allAdded, cutoffMs)
  const removed = filterSince(allRemoved, cutoffMs)
  const ah = groupByHour(added)
  const rh = groupByHour(removed)
  const topAdded = topNFromMap(groupByPlace(added), 4)
  const topRemoved = topNFromMap(groupByPlace(removed), 4)
  const peakA = Object.entries(ah).sort((a, b) => b[1] - a[1])[0]
  const peakR = Object.entries(rh).sort((a, b) => b[1] - a[1])[0]
  const peakAText = peakA ? `${peakA[0]}时×${peakA[1]}` : '—'
  const peakRText = peakR ? `${peakR[0]}时×${peakR[1]}` : '—'
  const speed = formatSpeedLine(calcSpeedBuckets({ added, removed }))

  return (
    `【${label}】\n` +
    `  记录: 出现 ${added.length} · 消失 ${removed.length}\n` +
    `  高峰(本地时): 出现 ${peakAText} · 消失 ${peakRText}\n` +
    `  场地(消失TOP): ${topRemoved}\n` +
    `  速度: ${speed}`
  )
}

/**
 * 一条汇总里包含：今天 / 7天 / 30天 / 半年 / 一年（均为「从该区间起点至今」累计）
 * 「今天」按运行本机的本地日历日 0 点起算。
 */
function buildReport() {
  const allAdded = readLogLines(LOG_ADDED)
  const allRemoved = readLogLines(LOG_REMOVED)

  const header =
    '📊 抢场统计 · 多周期汇总\n' +
    '━━━━━━━━━━━━━━\n' +
    '各段均为：从区间起点 → 现在的累计。\n' +
    '「今天」= 本机时区当日 0 点起。\n'

  const blocks = PERIODS.map(p => {
    const cut = periodCutoff(p)
    return summarizePeriod(p.label, cut, allAdded, allRemoved)
  })

  return header + '\n' + blocks.join('\n\n')
}

function splitForTelegram(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text]
  const parts = []
  let rest = text
  while (rest.length) {
    if (rest.length <= maxLen) {
      parts.push(rest)
      break
    }
    let cut = rest.lastIndexOf('\n\n', maxLen)
    if (cut < maxLen / 2) cut = maxLen
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return parts
}

module.exports = {
  record,
  buildReport,
  splitForTelegram
}
