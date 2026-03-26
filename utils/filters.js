function normalizeText(str) {
  if (!str) return ''
  return String(str)
    .toLowerCase()
    .replace(/\u3000/g, ' ')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim()
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

function normalizeCourtAlias(str) {
  const s = normalizeText(str)

  let match = s.match(/(\d+)/)
  if (match) return `c${match[1]}`

  match = s.match(/([a-z])\s*(コート|court)/i)
  if (match) return `c${match[1].toLowerCase()}`

  return s
}

function normalizeDate(dateStr) {
  // 2026年3月27日（金） → 2026-03-27
  const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return normalize(dateStr)

  const y = m[1]
  const mo = String(m[2]).padStart(2, '0')
  const d = String(m[3]).padStart(2, '0')

  return `${y}-${mo}-${d}`
}

function toMinutes(timeStr) {
  const [hour = 0, minute = 0] = String(timeStr).split(':').map(Number)
  return hour * 60 + minute
}

function matchTime(dTime, filter) {
  const start = String(dTime).split(/[～~]/)[0]
  const startMin = toMinutes(start)

  if (filter.length === 1) {
    return startMin >= toMinutes(filter[0])
  }

  if (filter.length === 2) {
    const [min, max] = filter.map(toMinutes)
    return startMin >= min && startMin <= max
  }

  return true
}

function filterSlotsByRules(data, rules) {
  const TIME_FILTER = rules.TIME_FILTER || []
  const WEEKDAY_FILTER = rules.WEEKDAY_FILTER || []
  const COURT_FILTER = rules.COURT_FILTER || []

  return data.filter(d => {
    if (TIME_FILTER.length > 0) {
      if (!matchTime(d.time, TIME_FILTER)) return false
    }

    if (WEEKDAY_FILTER.length > 0) {
      const match = d.date.match(/[（(]([月火水木金土日])[）)]/)
      if (!match || !WEEKDAY_FILTER.includes(match[1])) return false
    }

    if (COURT_FILTER.length > 0) {
      const court = normalizeCourtAlias(formatCourt(d.court))

      if (!COURT_FILTER.some(c => {
        return court.includes(normalizeCourtAlias(c))
      })) return false
    }

    return true
  })
}

function filterSlotsByConfig(data, config) {
  return filterSlotsByRules(data, {
    TIME_FILTER: config.TIME_FILTER,
    WEEKDAY_FILTER: config.WEEKDAY_FILTER,
    COURT_FILTER: config.COURT_FILTER
  })
}

function getAutoRules(config) {
  return {
    TIME_FILTER: Array.isArray(config.AUTO_TIME_FILTER) ? config.AUTO_TIME_FILTER : config.TIME_FILTER,
    WEEKDAY_FILTER: Array.isArray(config.AUTO_WEEKDAY_FILTER) ? config.AUTO_WEEKDAY_FILTER : config.WEEKDAY_FILTER,
    COURT_FILTER: Array.isArray(config.AUTO_COURT_FILTER) ? config.AUTO_COURT_FILTER : config.COURT_FILTER
  }
}

function filterSlotsAuto(data, config) {
  return filterSlotsByRules(data, getAutoRules(config))
}

function parseSlotDayKey(d) {
  // d.date: "2026年3月26日（木）"
  const m = String(d.date).match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const day = Number(m[3])
  if (!y || !mo || !day) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseSlotStartDateTime(d) {
  const dayKey = parseSlotDayKey(d)
  if (!dayKey) return null

  const startStr = String(d.time).split(/[～~]/)[0].trim()
  const tm = startStr.match(/^(\d+):(\d+)$/)
  if (!tm) return null

  const hour = Number(tm[1])
  const minute = Number(tm[2])
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null

  const [yStr, moStr, dayStr] = dayKey.split('-')
  const y = Number(yStr)
  const mo = Number(moStr) - 1
  const day = Number(dayStr)

  return new Date(y, mo, day, hour, minute, 0, 0)
}


module.exports = {
  formatCourt,
  normalizeCourtAlias,
  matchTime,
  normalizeText,
  normalizeDate,
  filterSlotsByRules,
  filterSlotsByConfig,
  getAutoRules,
  filterSlotsAuto,
  parseSlotDayKey,
  parseSlotStartDateTime
}
