const stats = require('./stats')
module.exports = function registerTelegramHandlers({
  bot,
  config,
  isAdmin,
  getCurrentData,
  getCurrentVersion,
  getBooking,
  setBooking,
  getTimer,
  setTimer,
  monitor,
  bookOne,
  formatText,
  saveConfig,
  getLogFile,
  getLogBuffer
}) {
  bot.setMyCommands([
    { command: 'run', description: '🚀 执行监控（强制推送）' },
    { command: 'status', description: '📊 查看系统状态' },
    { command: 'listplace', description: '📋 场地面板（开关控制）' },

    { command: 'config', description: '⚙️ 查看配置' },
    { command: 'set', description: '✏️ 修改配置' },
    { command: 'log', description: '📜 查看日志（/log 50）' },

    { command: 'pause', description: '⏸️ 暂停监控' },
    { command: 'resume', description: '▶️ 恢复监控' },

    // ❗ 全部改小写
    { command: 'enableplace', description: '🟢 开启场地监控' },
    { command: 'disableplace', description: '⚪ 关闭场地监控' },
    { command: 'addplace', description: '➕ 添加新场地' },
    { command: 'removeplace', description: '❌ 删除场地' },

    { command: 'help', description: '❓ 使用说明' }
  ])

  bot.on('callback_query', async (query) => {
    const data = query.data
    // ========================
    // ⭐ 快捷操作按钮
    // ========================
    if (data === 'quick_run') {
      await bot.answerCallbackQuery(query.id, { text: '🚀 执行中...' })

      await monitor({ forcePush: true })
      return
    }

    if (data === 'quick_stats') {
      await bot.answerCallbackQuery(query.id, { text: '📊 统计中...' })

      const text = stats.buildReport()

      await bot.sendMessage(query.message.chat.id, text, {
        parse_mode: 'Markdown'
      })
      return
    }

    if (data === 'quick_place') {
      await bot.answerCallbackQuery(query.id, { text: '📍 打开面板' })

      const rows = Object.entries(config.PLACE_MAP).map(([name, v]) => {
        const enabled = config.TARGET_PLACE.includes(name)

        return [
          {
            text: `${enabled ? '🟢' : '⚪'} ${v.emoji} ${v.short}`,
            callback_data: `noop`
          },
          {
            text: enabled ? '⏸️ 关闭' : '▶️ 开启',
            callback_data: `${enabled ? 'disable' : 'enable'}|${name}`
          }
        ]
      })

      await bot.sendMessage(query.message.chat.id, '📍 场地管理', {
        reply_markup: {
          inline_keyboard: rows
        }
      })

      return
    }
    if (getBooking()) {
      return bot.answerCallbackQuery(query.id, {
        text: '⏳ 正在预约中，请稍等'
      })
    }

    // ========================
    // ⭐ 场地开关控制
    // ========================
    if (data.includes('|')) {
      const [action, name] = data.split('|')

      if (!config.PLACE_MAP[name]) {
        return bot.answerCallbackQuery(query.id, { text: '❌ 场地不存在' })
      }

      if (action === 'enable') {
        if (!config.TARGET_PLACE.includes(name)) {
          config.TARGET_PLACE.push(name)
          saveConfig()
        }

        await bot.answerCallbackQuery(query.id, { text: '✅ 已开启' })
      }

      if (action === 'disable') {
        config.TARGET_PLACE = config.TARGET_PLACE.filter(p => p !== name)
        saveConfig()

        await bot.answerCallbackQuery(query.id, { text: '⏸️ 已关闭' })
      }

      await bot.editMessageReplyMarkup(
        {
          inline_keyboard: Object.entries(config.PLACE_MAP).map(([name, v]) => {
            const enabled = config.TARGET_PLACE.includes(name)

            return [
              {
                text: `${enabled ? '🟢' : '⚪'} ${v.emoji} ${v.short}`,
                callback_data: 'noop'
              },
              {
                text: enabled ? '⏸️ 关闭' : '▶️ 开启',
                callback_data: `${enabled ? 'disable' : 'enable'}|${name}`
              }
            ]
          })
        },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }
      )

      return
    }

    const [version, indexStr] = query.data.split('_')
    if (Number(version) !== getCurrentVersion()) return

    const d = getCurrentData()[Number(indexStr)]

    setBooking(true)
    await bot.answerCallbackQuery(query.id, { text: '🚀 开始预约...' })

    try {
      await bookOne(d)

      await bot.sendMessage(
        process.env.CHAT_ID,
        `🎉 *预约成功！*\n━━━━━━━━━━━━━━\n${formatText(d, { showBike: true })}`,
        { parse_mode: 'Markdown' }
      )
      await monitor({ forcePush: true })
    } catch (e) {
      await bot.sendMessage(
        process.env.CHAT_ID,
        `❌ *预约失败*\n━━━━━━━━━━━━━━\n${formatText(d)}\n\n🧨 ${e.message}`,
        { parse_mode: 'Markdown' }
      )
    } finally {
      setBooking(false)
    }

    setBooking(false)
  })

  // log
  bot.onText(/\/log(?: (\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const n = Number(match[1] || 50)
    const logs = getLogBuffer().slice(-n).join('\n')

    if (logs.length > 3500) {
      await bot.sendMessage(msg.chat.id, '📜 日志过长，发送文件...')
      return bot.sendDocument(msg.chat.id, getLogFile())
    }

    await bot.sendMessage(msg.chat.id, logs)
  })

  // config
  bot.onText(/\/config$/, async (msg) => {
    if (!isAdmin(msg)) return
    await bot.sendMessage(msg.chat.id, '⚙️ 当前配置：\n\n' + JSON.stringify(config, null, 2))
  })

  // set
  bot.onText(/\/set (\w+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const key = match[1]
    let value = match[2]

    if (!(key in config)) {
      return bot.sendMessage(msg.chat.id, '❌ 不存在这个配置项')
    }

    try {
      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (!isNaN(value)) value = Number(value)
      else if (value.startsWith('[')) value = JSON.parse(value)

      config[key] = value
      saveConfig()

      await bot.sendMessage(
        msg.chat.id,
        `✅ *配置已更新*
      ━━━━━━━━━━━━━━
      🔧 ${key} = \`${JSON.stringify(value)}\``,
        { parse_mode: 'Markdown' }
      )
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ 修改失败`)
    }
  })

  // run
  bot.onText(/\/run/, async (msg) => {
    if (!isAdmin(msg)) return
    await bot.sendMessage(
      msg.chat.id,
      `🚀 *手动执行监控*\n━━━━━━━━━━━━━━\n⏳ 正在抓取最新数据...`,
      { parse_mode: 'Markdown' }
    )
    await monitor({ forcePush: true })
  })

  // pause
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) return
    clearInterval(getTimer())
    setTimer(null)
    await bot.sendMessage(msg.chat.id, '⏸️ *监控已暂停*\n━━━━━━━━━━━━━━\n不会再自动刷新')
  })

  // resume
  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) return
    if (!getTimer()) {
      setTimer(setInterval(monitor, config.INTERVAL * 1000))
    }
    await bot.sendMessage(msg.chat.id, '监控已恢复*\n━━━━━━━━━━━━━━\n每 ${config.INTERVAL}s 执行一次')
  })

  // status
  bot.onText(/\/status/, async (msg) => {
    if (!isAdmin(msg)) return

    // ✅ 场地状态（动态计算）
    const placeStatus = Object.entries(config.PLACE_MAP)
      .map(([name, v]) => {
        const enabled = config.TARGET_PLACE.includes(name)
        return `${enabled ? '🟢' : '⚪'} ${v.emoji} ${v.short}`
      })
      .join('\n')

    const statusText = `
📊 *系统状态*
━━━━━━━━━━━━━━
📡 监控状态：${!!getTimer() ? '✅ 运行中' : '⏸️ 已暂停'}
🤖 预约状态：${getBooking() ? '⏳ 预约中' : '🟢 空闲'}

📦 *数据情况*
━━━━━━━━━━━━━━
📊 当前可预约：${getCurrentData().length}
🆔 当前版本：${getCurrentVersion()}

🏟️ *场地状态*
━━━━━━━━━━━━━━
${placeStatus || '暂无场地'}

⚙️ *运行配置*
━━━━━━━━━━━━━━
⏱️ 间隔：${config.INTERVAL}
🕒 时间过滤：${config.TIME_FILTER.join(', ') || '不限'}
📅 星期过滤：${config.WEEKDAY_FILTER.join(', ') || '不限'}

🚀 *快捷操作*
━━━━━━━━━━━━━━
/run ｜ /pause ｜ /resume
`

    await bot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown'
    })
  })

  bot.onText(/\/addPlace (.+?) (.+?) (.+?) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const [, name, short, emoji, bike] = match

    // 1️⃣ 加入 TARGET_PLACE（避免重复）
    if (!config.TARGET_PLACE.includes(name)) {
      config.TARGET_PLACE.push(name)
    }

    // 2️⃣ 加入 PLACE_MAP
    config.PLACE_MAP[name] = {
      short,
      emoji,
      bike
    }

    saveConfig()

    await bot.sendMessage(
      msg.chat.id,
      `✅ *已添加场地* ━━━━━━━━━━━━━━ ${emoji} ${short} 📍 ${name} 🚴 ${bike}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/listplace/, async (msg) => {
    if (!isAdmin(msg)) return

    const rows = Object.entries(config.PLACE_MAP).map(([name, v]) => {
      const enabled = config.TARGET_PLACE.includes(name)

      return [
        {
          text: `${enabled ? '🟢' : '⚪'} ${v.emoji} ${v.short}`,
          callback_data: `noop`
        },
        {
          text: enabled ? '⏸️ 关闭' : '▶️ 开启',
          callback_data: `${enabled ? 'disable' : 'enable'}|${name}`
        }
      ]
    })

    await bot.sendMessage(
      msg.chat.id,
      `📍 *场地管理面板*
━━━━━━━━━━━━━━
点击右侧按钮即可开关监控

🟢 = 监控中
⚪ = 已关闭

💡 提示：
- 只影响监控，不会删除场地
- 修改立即生效`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: rows
        }
      }
    )
  })

  bot.onText(/\/removePlace (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const name = match[1].trim()

    // 是否存在
    if (!config.PLACE_MAP[name]) {
      return bot.sendMessage(msg.chat.id, '❌ 场地不存在')
    }

    // 1️⃣ 从 TARGET_PLACE 删除
    config.TARGET_PLACE = config.TARGET_PLACE.filter(p => p !== name)

    // 2️⃣ 从 PLACE_MAP 删除
    delete config.PLACE_MAP[name]

    saveConfig()

    await bot.sendMessage(
      msg.chat.id,
      `🗑️ *已删除场地* ━━━━━━━━━━━━━━ 📍 ${name}`,
      { parse_mode: 'Markdown' }
    )
  })

  // help
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return
  
    const helpText = `
  🧠 *网球场监控系统 v2*
  ━━━━━━━━━━━━━━
  
  📊 *当前状态*
  ━━━━━━━━━━━━━━
  📡 监控：${!!getTimer() ? '✅ 运行中' : '⏸️ 已暂停'}
  🤖 预约：${getBooking() ? '⏳ 执行中' : '🟢 空闲'}
  
  🚀 *核心操作*
  ━━━━━━━━━━━━━━
  /run        👉 立即扫描（强制推送）
  /status     👉 查看系统状态
  /stats      👉 查看抢场统计（🔥推荐）
  
  ⏯️ *运行控制*
  ━━━━━━━━━━━━━━
  /pause      👉 停止监控
  /resume     👉 恢复监控
  
  🏟️ *场地管理*
  ━━━━━━━━━━━━━━
  /listplace  👉 可视化管理（推荐⭐）
  /addplace 名称 简称 emoji 距离
  /removeplace 名称
  /enableplace 名称
  /disableplace 名称
  
  ⚙️ *配置调整*
  ━━━━━━━━━━━━━━
  /config     👉 查看配置
  /set KEY VAL 👉 修改配置
  
  示例：
  /set INTERVAL 30
  /set AUTO_BOOK true
  /set TIME_FILTER ["18:00","21:00"]
  
  📜 *日志系统*
  ━━━━━━━━━━━━━━
  /log        👉 最近日志
  /log 100    👉 最近100条
  
  📈 *统计系统（重点）*
  ━━━━━━━━━━━━━━
  /stats      👉 抢场速度分析
  👉 自动统计：
     • 不同场地
     • 不同时段
     • 被抢时间分布（1m/3m/5m/10m/1h/3h）
  
  💡 *使用建议*
  ━━━━━━━━━━━━━━
  • ⭐ 用 /listplace 管理场地
  • 🔥 开启 AUTO_BOOK 自动抢
  • 📊 定期看 /stats 优化策略
  • ⏱️ 晚上时段竞争最激烈（重点关注）
  
  `
    await bot.sendMessage(msg.chat.id, helpText, {
      parse_mode: 'Markdown',
      reply_markup: {
        remove_keyboard: true
      }
    })
  })

  bot.onText(/\/enablePlace (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const name = match[1].trim()

    // 必须存在于 PLACE_MAP
    if (!config.PLACE_MAP[name]) {
      return bot.sendMessage(msg.chat.id, '❌ 场地不存在（请先 addPlace）')
    }

    // 已经开启
    if (config.TARGET_PLACE.includes(name)) {
      return bot.sendMessage(msg.chat.id, '⚠️ 已经在监控中')
    }

    config.TARGET_PLACE.push(name)
    saveConfig()

    const meta = config.PLACE_MAP[name]

    await bot.sendMessage(
      msg.chat.id,
      `✅ *已开启监控*
━━━━━━━━━━━━━━
${meta.emoji} ${meta.short}
📍 ${name}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/disablePlace (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const name = match[1].trim()

    if (!config.PLACE_MAP[name]) {
      return bot.sendMessage(msg.chat.id, '❌ 场地不存在')
    }

    // 已经关闭
    if (!config.TARGET_PLACE.includes(name)) {
      return bot.sendMessage(msg.chat.id, '⚠️ 本来就没在监控')
    }

    config.TARGET_PLACE = config.TARGET_PLACE.filter(p => p !== name)
    saveConfig()

    const meta = config.PLACE_MAP[name]

    await bot.sendMessage(
      msg.chat.id,
      `⏸️ *已关闭监控*
━━━━━━━━━━━━━━
${meta.emoji} ${meta.short}
📍 ${name}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) return
  
    const text = stats.buildReport()
  
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'Markdown'
    })

    bot.sendMessage(msg.chat.id, '👇 常用操作', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 立即扫描', callback_data: 'quick_run' }],
          [{ text: '📊 查看统计', callback_data: 'quick_stats' }],
          [{ text: '📍 场地管理', callback_data: 'quick_place' }]
        ]
      }
    })
  })
}

