const stats = require('./stats')

function buildPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🚀 立即扫描', callback_data: 'quick_run' },
        { text: '📊 系统状态', callback_data: 'quick_status' }
      ],
      [
        { text: '📍 场地开关', callback_data: 'quick_place' },
        { text: '📚 预约记录', callback_data: 'quick_booked' }
      ]
    ]
  }
}

function formatBookedLines(all, limit, formatText) {
  const list = all
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.create || 0).getTime() || 0
      const tb = new Date(b.create || 0).getTime() || 0
      return tb - ta
    })
    .slice(0, limit)

  const lines = list.map((d, i) => {
    const status = d.reminderEnabled === false ? '🔕 已关提醒' : '🔔 提醒开'
    return `${i + 1}. ${formatText(d, { style: 'detail' })}\n   ${status}\n   ucode: ${d.ucode}`
  })
  return { lines, list, total: all.length }
}

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
  getLogBuffer,
  removeBookedSlot,
  disableBookedReminder,
  deleteReminderMessagesByUcode,
  getBookedSlots
}) {
  bot.setMyCommands([
    { command: 'panel', description: '🎛️ 控制面板（常用）' },
    { command: 'run', description: '🚀 立即扫描并推送' },
    { command: 'status', description: '📊 系统状态' },
    { command: 'listplace', description: '📍 场地开关' },
    { command: 'booked', description: '📚 预约记录' },
    { command: 'stats', description: '📈 抢场统计' },
    { command: 'pause', description: '⏸️ 暂停监控' },
    { command: 'resume', description: '▶️ 恢复监控' },
    { command: 'help', description: '❓ 帮助' }
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

    if (data === 'quick_status') {
      await bot.answerCallbackQuery(query.id, { text: '已生成' })
      const placeStatus = Object.entries(config.PLACE_MAP)
        .map(([name, v]) => {
          const enabled = config.TARGET_PLACE.includes(name)
          return `${enabled ? '🟢' : '⚪'} ${v.emoji} ${v.short}`
        })
        .join('\n')

      const statusText =
        `📊 *系统状态*\n━━━━━━━━━━━━━━\n` +
        `📡 监控：${!!getTimer() ? '运行中' : '已暂停'}\n` +
        `🤖 预约：${getBooking() ? '进行中' : '空闲'}\n` +
        `📋 当前列表：${getCurrentData().length} 条\n\n` +
        `🏟️ *场地*\n━━━━━━━━━━━━━━\n${placeStatus || '（无）'}\n\n` +
        `⏱️ 间隔 ${config.INTERVAL}s · 提醒间隔 ${config.BOOKED_REMINDER_INTERVAL_HOURS ?? '?'}h`

      await bot.sendMessage(query.message.chat.id, statusText, { parse_mode: 'Markdown' })
      return
    }

    if (data === 'quick_booked') {
      await bot.answerCallbackQuery(query.id, { text: '📚 …' })
      const all = getBookedSlots()
      if (all.length === 0) {
        await bot.sendMessage(query.message.chat.id, '📚 暂无预约记录')
        return
      }
      const { lines, list, total } = formatBookedLines(all, 12, formatText)
      await bot.sendMessage(
        query.message.chat.id,
        `📚 预约记录（最近 ${list.length}/${total} 条）\n━━━━━━━━━━━━━━\n${lines.join('\n\n')}`
      )
      return
    }
    if (data.startsWith('del_booked_')) {
      const key = data.replace('del_booked_', '')
      const updated = disableBookedReminder(key)
      const n = await deleteReminderMessagesByUcode(key)
  
      await bot.answerCallbackQuery(query.id, {
        text: updated
          ? (n > 0 ? `✅ 已取消提醒，并清理 ${n} 条历史消息` : '✅ 已取消该预约提醒')
          : '⚠️ 未找到对应预约记录'
      })
  
      try {
        await bot.editMessageText(
          `❌ 已删除提醒`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        )
      } catch (e) {
        // 该消息可能已被 deleteReminderMessagesByUcode 删除，忽略
      }
      return
    }

    if (data === 'noop') {
      await bot.answerCallbackQuery(query.id, { text: 'ℹ️ 仅展示信息' })
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

      await bot.sendMessage(query.message.chat.id, '📍 场地开关\n点右侧开启/关闭监控（立即生效）', {
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

    if (/^\d+_\d+$/.test(data)) {
      await bot.answerCallbackQuery(query.id, {
        text: '⚠️ 旧按钮已过期，请使用最新推送'
      })
      return
    }

    if (!data.startsWith('book_')) {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ 无效操作' })
      return
    }

    const ucode = data.replace('book_', '')
    const d = getCurrentData().find(item => item.ucode === ucode)
    if (!d) {
      await bot.answerCallbackQuery(query.id, {
        text: '⚠️ 该场地已过期或不在最新列表'
      })
      return
    }

    setBooking(true)
    await bot.answerCallbackQuery(query.id, { text: '🚀 开始预约...' })

    try {
      await bookOne(d)
      await monitor({ forcePush: true })
    } catch (e) {
      await bot.sendMessage(
        process.env.CHAT_ID,
        `❌ *预约失败*\n━━━━━━━━━━━━━━\n${formatText(d, { style: 'detail' })}\n\n🧨 ${e.message}`,
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
        `✅ 配置已更新\n━━━━━━━━━━━━━━\n${key} = ${JSON.stringify(value)}`
      )
    } catch (e) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ 修改失败：${e.message || e}`
      )
    }
  })

  bot.onText(/\/panel/, async (msg) => {
    if (!isAdmin(msg)) return
    await bot.sendMessage(msg.chat.id, '🎛️ *控制面板*\n━━━━━━━━━━━━━━\n点下方按钮操作', {
      parse_mode: 'Markdown',
      reply_markup: buildPanelKeyboard()
    })
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
    await bot.sendMessage(
      msg.chat.id,
      `▶️ *监控已恢复*\n━━━━━━━━━━━━━━\n每 ${config.INTERVAL}s 执行一次`,
      { parse_mode: 'Markdown' }
    )
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

🚀 *快捷入口*
━━━━━━━━━━━━━━
/panel · /run · /pause · /resume
`

    await bot.sendMessage(msg.chat.id, statusText, {
      parse_mode: 'Markdown',
      reply_markup: buildPanelKeyboard()
    })
  })

  // booked history
  bot.onText(/\/booked(?: (\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) return

    const limit = Math.max(1, Math.min(100, Number(match?.[1] || 15)))
    const all = getBookedSlots()
    if (all.length === 0) {
      await bot.sendMessage(msg.chat.id, '📚 暂无历史预约记录')
      return
    }

    const { lines, list, total } = formatBookedLines(all, limit, formatText)

    await bot.sendMessage(
      msg.chat.id,
      `📚 历史预约（最近 ${list.length}/${total} 条）\n━━━━━━━━━━━━━━\n${lines.join('\n\n')}`
    )
  })

  bot.onText(/\/addplace (.+?) (.+?) (.+?) (.+)/, async (msg, match) => {
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
      `📍 *场地开关*
━━━━━━━━━━━━━━
右侧按钮开关监控（不删场地，立即生效）`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: rows
        }
      }
    )
  })

  bot.onText(/\/removeplace (.+)/, async (msg, match) => {
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
  
    const helpText =
      `🎾 网球场监控 · 帮助\n\n` +
      `【常用】\n` +
      `/panel  控制面板（下方按钮）\n` +
      `/run  立即扫描并推送\n` +
      `/status  状态（含面板）\n` +
      `/listplace  场地开关\n` +
      `/booked  预约记录（可加条数，如 /booked 20）\n` +
      `/stats  抢场统计\n` +
      `/pause · /resume  暂停/恢复定时扫描\n\n` +
      `【说明】\n` +
      `推送里点按钮预约；过期消息会提示刷新。\n` +
      `取消提醒只关提醒，不删预约记录。\n\n` +
      `【高级】\n` +
      `/config  查看配置\n` +
      `/set KEY 值  修改（例：/set INTERVAL 45）\n` +
      `/log  日志（/log 100）\n` +
      `/addplace … /removeplace …  增删场地`

    await bot.sendMessage(msg.chat.id, helpText, {
      reply_markup: buildPanelKeyboard()
    })
  })

  bot.onText(/\/enableplace (.+)/, async (msg, match) => {
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

  bot.onText(/\/disableplace (.+)/, async (msg, match) => {
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

    if (text.length > 4000) {
      await bot.sendMessage(msg.chat.id, '📈 统计过长，仅显示前 3800 字…')
      await bot.sendMessage(msg.chat.id, text.slice(0, 3800))
    } else {
      await bot.sendMessage(msg.chat.id, text)
    }

    await bot.sendMessage(msg.chat.id, '👇 快捷操作', {
      reply_markup: buildPanelKeyboard()
    })
  })
}

