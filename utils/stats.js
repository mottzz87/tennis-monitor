const fs = require('fs')
const path = require('path')

const DAYS = 30 // 统计窗口（天），Infinity 表示不限

const LOG_ADDED = path.join('stats', 'added.log')
const LOG_REMOVED = path.join('stats', 'removed.log')

function readLogLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const out = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // 跳过坏行
    }
  }
  return out
}

function filterByWindow(list) {
  if (DAYS === Infinity) return list
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000
  return list.filter(i => typeof i.time === 'number' && i.time >= cutoff)
}

/**
 * 从 append 的 log 加载；与 record() 写入的格式一致。
 * （旧版 stats.json 若存在则忽略，以日志为准）
 */
function loadStats() {
  const added = filterByWindow(readLogLines(LOG_ADDED))
  const removed = filterByWindow(readLogLines(LOG_REMOVED))
  return { added, removed }
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

// ========================
// 📊 工具
// ========================
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

// ========================
// ⚡ 速度分析：同一 slot（id）从「出现」到「消失」的间隔
// ========================
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
    '1m': 0,
    '3m': 0,
    '5m': 0,
    '10m': 0,
    '1h': 0,
    '3h': 0,
    '3h+': 0
  }

  const placeBuckets = {}
  const global = { ...buckets }

  function bump(target, diffSec) {
    if (diffSec <= 60) target['1m']++
    else if (diffSec <= 180) target['3m']++
    else if (diffSec <= 300) target['5m']++
    else if (diffSec <= 600) target['10m']++
    else if (diffSec <= 3600) target['1h']++
    else if (diffSec <= 10800) target['3h']++
    else target['3h+']++
  }

  stats.removed.forEach(r => {
    if (!r.id || !addedMap.has(r.id)) return

    const diff = (r.time - addedMap.get(r.id)) / 1000
    if (diff < 0) return

    const p = r.place || '（未知）'
    if (!placeBuckets[p]) {
      placeBuckets[p] = { ...buckets }
    }
    bump(placeBuckets[p], diff)
    bump(global, diff)
  })

  return { byPlace: placeBuckets, global }
}

// ========================
// 📊 报告生成
// ========================
function formatMap(map) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} → ${v}`)
    .join('\n') || '暂无数据'
}

function formatBucket(b) {
  const total = Object.values(b).reduce((a, v) => a + v, 0)
  if (total === 0) return '暂无配对样本（需同一 uid 先 added 再 removed）'

  return Object.entries(b)
    .map(([k, v]) => {
      const pct = ((v / total) * 100).toFixed(0)
      return `${k.padEnd(4)}: ${v} (${pct}%)`
    })
    .join('\n')
}

function buildReport() {
  const stats = loadStats()

  const addedHour = groupByHour(stats.added)
  const removedHour = groupByHour(stats.removed)

  const addedPlace = groupByPlace(stats.added)
  const removedPlace = groupByPlace(stats.removed)

  const { byPlace: speed, global: speedGlobal } = calcSpeedBuckets(stats)

  let speedText = ''
  const places = Object.keys(speed).sort()
  for (const place of places) {
    speedText += `\n🏟️ ${place}\n${formatBucket(speed[place])}`
  }

  const windowLabel = DAYS === Infinity ? '全部' : `最近 ${DAYS} 天`

  return (
    `📊 抢场统计（${windowLabel}）\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `🟢 空位出现时段（监控本地小时）\n` +
    `${formatMap(addedHour)}\n\n` +
    `🔴 空位消失时段（被约走）\n` +
    `${formatMap(removedHour)}\n\n` +
    `📍 出现次数 · 按场地\n` +
    `${formatMap(addedPlace)}\n\n` +
    `📍 消失次数 · 按场地\n` +
    `${formatMap(removedPlace)}\n\n` +
    `⚡ 从出现到消失（全局，需 uid 配对）\n` +
    `${formatBucket(speedGlobal)}` +
    `${speedText || ''}\n\n` +
    `📈 样本条数 · added=${stats.added.length} · removed=${stats.removed.length}`
  )
}

module.exports = {
  record,
  buildReport
}
