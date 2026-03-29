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

  return `c${num}`
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
  const iso = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const m = String(dateStr).match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return String(dateStr).trim()

  const y = m[1]
  const mo = String(m[2]).padStart(2, '0')
  const d = String(m[3]).padStart(2, '0')

  return `${y}-${mo}-${d}`
}

function toMinutes(timeStr) {
  const t = String(timeStr).trim()
  if (t.includes(':')) {
    const [hour = 0, minute = 0] = t.split(':').map(Number)
    return hour * 60 + minute
  }
  const hour = Number(t)
  if (Number.isNaN(hour)) return 0
  return hour * 60
}

function matchTime(dTime, filter) {
  const start = String(dTime).split(/[～~\-]/)[0]
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
  const COURT_NUM_FILTER = rules.COURT_NUM_FILTER || []
  const PLACE_FILTER = rules.PLACE_FILTER || []
  const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土']

  return data.filter(d => {
    if (TIME_FILTER.length > 0) {
      if (!matchTime(d.time, TIME_FILTER)) return false
    }

    if (WEEKDAY_FILTER.length > 0) {
      let weekday = null
      const display = String(d.dateDisplay || '')
      const m1 = display.match(/[（(]([月火水木金土日])[）)]/)
      if (m1) {
        weekday = m1[1]
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '').trim())) {
        const [y, mo, day] = String(d.date).split('-').map(Number)
        weekday = WEEKDAY_JP[new Date(y, mo - 1, day).getDay()]
      } else {
        const m2 = String(d.date || '').match(/[（(]([月火水木金土日])[）)]/)
        if (m2) weekday = m2[1]
      }
      if (!weekday || !WEEKDAY_FILTER.includes(weekday)) return false
    }

    if (COURT_NUM_FILTER.length > 0) {
      const court = normalizeCourtAlias(formatCourt(d.court))

      if (!COURT_NUM_FILTER.some(c => {
        return court.includes(normalizeCourtAlias(c))
      })) return false
    }

    if (PLACE_FILTER.length > 0) {
      const placeStr = String(d.place || '')
      const placeN = normalizeText(placeStr)
      const hit = PLACE_FILTER.some(kw => {
        const k = String(kw || '').trim()
        if (!k) return false
        return placeStr.includes(k) || placeN.includes(normalizeText(k))
      })
      if (!hit) return false
    }

    return true
  })
}

function filterSlotsByConfig(data, config) {
  return filterSlotsByRules(data, {
    TIME_FILTER: config.TIME_FILTER,
    WEEKDAY_FILTER: config.WEEKDAY_FILTER,
    COURT_NUM_FILTER: config.COURT_NUM_FILTER
  })
}

function mergeAutoCourtKeywords(config) {
  const k = Array.isArray(config.AUTO_COURT_KEYWORDS) ? config.AUTO_COURT_KEYWORDS : []
  const n = Array.isArray(config.AUTO_COURT_NUM_FILTER) ? config.AUTO_COURT_NUM_FILTER : []
  const merged = [...new Set([...k, ...n].map(String).map(s => s.trim()).filter(Boolean))]
  if (merged.length > 0) return merged
  return Array.isArray(config.COURT_NUM_FILTER) ? config.COURT_NUM_FILTER : []
}

function getAutoRules(config) {
  return {
    TIME_FILTER: Array.isArray(config.AUTO_TIME_FILTER) ? config.AUTO_TIME_FILTER : config.TIME_FILTER,
    WEEKDAY_FILTER: Array.isArray(config.AUTO_WEEKDAY_FILTER) ? config.AUTO_WEEKDAY_FILTER : config.WEEKDAY_FILTER,
    COURT_NUM_FILTER: Array.isArray(config.AUTO_COURT_NUM_FILTER) ? config.AUTO_COURT_NUM_FILTER : [],
    PLACE_FILTER: Array.isArray(config.AUTO_PLACE_FILTER) ? config.AUTO_PLACE_FILTER : []
  }
}

function filterSlotsAuto(data, config) {
  return filterSlotsByRules(data, getAutoRules(config))
}

function parseSlotDayKey(d) {
  const dateStr = String(d.date).trim()

  // d.date: "2026-03-26"
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  // d.date: "2026年3月26日（木）"
  const m = dateStr.match(/(\d+)年(\d+)月(\d+)日/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const day = Number(m[3])
  if (!y || !mo || !day) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseTimeSafe(timeStr) {
  if (!timeStr) return [0, 0]

  // 统一全角数字 -> 半角数字
  timeStr = timeStr.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  
  // 全角冒号、波浪线也替换为半角
  timeStr = timeStr.replace(/：/g, ':').replace(/～/g, '~')

  // 取开始时间
  const start = timeStr.split(/[~\-]/)[0].trim()
  const [hStr = '0', mStr = '0'] = start.includes(':')
    ? start.split(':')
    : [start, '0']
  
  const h = Number(hStr)
  const m = Number(mStr)

  if (Number.isNaN(h) || Number.isNaN(m)) return [0, 0]
  return [h, m]
}

function parseSlotStartDateTimeSafe(d) {
  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date).trim())) {
    const [h, m] = parseTimeSafe(String(d.time))
    return new Date(`${d.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`)
  }

  return parseSlotStartDateTime(d)
}

function parseSlotStartDateTime(d) {
  const dayKey = parseSlotDayKey(d)
  if (!dayKey) return null

  const [hour, minute] = parseTimeSafe(String(d.time))
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
  parseSlotStartDateTime,
  parseSlotStartDateTimeSafe
}
