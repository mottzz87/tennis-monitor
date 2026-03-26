const fs = require('fs')

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10)
  return `./logs/runtime-${date}.log`
}

function setupConsoleLogging(logBuffer) {
  if (console._log) return

  console._log = console.log
  console.log = (...args) => {
    const msg = `[${new Date().toLocaleString()}] ` +
      args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ')
    console._log(...args)

    logBuffer.push(msg)
    if (logBuffer.length > 200) logBuffer.shift()

    const logFile = getLogFile()
    fs.mkdirSync('./logs', { recursive: true })
    fs.appendFileSync(logFile, msg + '\n')
  }
}

function cleanOldLogs(days = 7) {
  const dir = './logs'
  if (!fs.existsSync(dir)) return

  const files = fs.readdirSync(dir)
  const now = Date.now()

  files.forEach(file => {
    const match = file.match(/runtime-(\d{4}-\d{2}-\d{2})\.log/)
    if (!match) return

    const fileDate = new Date(match[1]).getTime()
    const diffDays = (now - fileDate) / (1000 * 60 * 60 * 24)

    if (diffDays > days) {
      fs.unlinkSync(`${dir}/${file}`)
      console.log(`🧹 删除旧日志: ${file}`)
    }
  })
}

function createTrace() {
  return Math.random().toString(36).slice(2, 8)
}

function logStep(trace, step, msg, extra = '') {
  console.log(`[${trace}] [${step}] ${msg}`, extra || '')
}

module.exports = {
  getLogFile,
  setupConsoleLogging,
  cleanOldLogs,
  createTrace,
  logStep
}
