const fs = require('fs')

const FILE = './stats.json'
const DAYS = 30 // ⭐ 改这里：30天 or Infinity

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'))
  } catch {
    return { added: [], removed: [] }
  }
}

function saveStats(stats) {
  fs.writeFileSync(FILE, JSON.stringify(stats, null, 2))
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
    court: d.court, // ⭐ 新增
    date: d.date,
    slot: d.time,
    id: d.uid // ⭐ 用稳定ID
  })).join('\n') + '\n'

  fs.appendFileSync(file, lines)
}

// ========================
// 📊 工具
// ========================
function groupByHour(list) {
  const map = {}
  list.forEach(i => {
    map[i.hour] = (map[i.hour] || 0) + 1
  })
  return map
}

function groupByPlace(list) {
  const map = {}
  list.forEach(i => {
    map[i.place] = (map[i.place] || 0) + 1
  })
  return map
}

// ========================
// ⚡ 速度分析（核心🔥）
// ========================
function calcSpeedBuckets(stats) {
  const addedMap = new Map()

  stats.added.forEach(a => {
    addedMap.set(a.id, a.time)
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

  stats.removed.forEach(r => {
    if (!addedMap.has(r.id)) return

    const diff = (r.time - addedMap.get(r.id)) / 1000 // 秒
    const p = r.place

    if (!placeBuckets[p]) {
      placeBuckets[p] = JSON.parse(JSON.stringify(buckets))
    }

    const target = placeBuckets[p]

    if (diff <= 60) target['1m']++
    else if (diff <= 180) target['3m']++
    else if (diff <= 300) target['5m']++
    else if (diff <= 600) target['10m']++
    else if (diff <= 3600) target['1h']++
    else if (diff <= 10800) target['3h']++
    else target['3h+']++
  })

  return placeBuckets
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
  const total = Object.values(b).reduce((a, v) => a + v, 0) || 1

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

  const speed = calcSpeedBuckets(stats)

  let speedText = ''

  for (const place in speed) {
    speedText += `
🏟️ ${place}
${formatBucket(speed[place])}
`
  }

  return `
📊 *预约行为统计（最近${DAYS === Infinity ? '全部' : DAYS + '天'}）*
━━━━━━━━━━━━━━

🟢 *取消高峰（小时）*
${formatMap(addedHour)}

🔴 *被抢高峰（小时）*
${formatMap(removedHour)}

🏟️ *场地取消排行*
${formatMap(addedPlace)}

🏟️ *场地被抢排行*
${formatMap(removedPlace)}

⚡ *被抢速度分布（按场地）*
${speedText || '暂无数据'}

📈 样本：
added=${stats.added.length}
removed=${stats.removed.length}
`
}

module.exports = {
  record,
  buildReport
}