// notifier.js — уведомления водителям.
// Водитель может быть подключён к Telegram, к MAX или к обоим —
// сообщение уходит везде, где он есть.
'use strict';
const db = require('./db');
const { CHANNELS, BOT_CHANNELS, availableFor } = require('./channels');

// Отправители по каналам: ключ → функция (externalId, text, opts)
const senders = new Map();

const registerSender = (channel, fn) => { senders.set(channel, fn); };

// Совместимость с прежними вызовами
const setBot = (bot) => {
  registerSender('telegram', (chatId, text, { buttons } = {}) => {
    const extra = { parse_mode: 'Markdown' };
    if (buttons) {
      extra.reply_markup = {
        inline_keyboard: buttons.map(row => row.map(b =>
          b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
      };
    }
    return bot.telegram.sendMessage(chatId, text, extra);
  });
};

const setMaxBot = (maxBot) => {
  registerSender('max', (userId, text, { buttons } = {}) =>
    maxBot.sendMessage(userId, text, { markdown: true, buttons }));
};

const STATUS_LABELS = {
  NEW: '🆕 Новая', IN_PROGRESS: '🔧 В работе',
  WAITING: '⏳ Ожидание', DONE: '✅ Завершена', CANCELLED: '❌ Отменена',
};

// Единая точка отправки.
// prefer — канал, из которого пришла заявка: отвечаем туда же, где водитель
// начал разговор. Если он там больше не подключён, доставляем куда сможем.
async function sendToUser(userId, text, { buttons, prefer } = {}) {
  const fields = BOT_CHANNELS.map(c => c.idField).join(', ');
  const { rows } = await db.query(
    `SELECT ${fields} FROM users WHERE id = $1`, [userId]
  );
  const u = rows[0];
  if (!u) return 0;

  const available = availableFor(u).filter(c => senders.has(c.key));
  if (!available.length) return 0;

  const preferred = prefer && available.find(c => c.key === prefer);
  const targets = preferred ? [preferred] : available;

  let sent = 0;
  for (const channel of targets) {
    try {
      await senders.get(channel.key)(u[channel.idField], text, { buttons });
      sent++;
    } catch (err) {
      console.error(`[notifier] ${channel.key} error:`, err.message);
    }
  }
  return sent;
}

// ─── Смена статуса заявки ──────────────────────────────────────────────────
async function notifyTicketStatus(ticket, newStatus) {
  if (!ticket) return 0;
  const recipients = new Set([ticket.created_by, ticket.assigned_to].filter(Boolean));
  if (!recipients.size) return 0;

  const full = await db.getTicketById(ticket.id, ticket.company_id).catch(() => ticket);
  const text =
    `🔔 *Обновление заявки ${full.num}*\n\n` +
    `Статус изменён: *${STATUS_LABELS[newStatus] || newStatus}*\n` +
    `🚛 ${full.vehicle_plate || '—'}\n` +
    `📋 ${full.type_icon || ''} ${full.type_name || 'Заявка'}\n` +
    `${full.description ? full.description.slice(0, 100) : ''}`;

  let sent = 0;
  for (const uid of recipients) sent += await sendToUser(uid, text, { prefer: full.channel });
  return sent;
}

// ─── Комментарий диспетчера ────────────────────────────────────────────────
async function notifyTicketComment(ticket, comment) {
  if (!ticket || !ticket.created_by) return 0;
  const full = await db.getTicketById(ticket.id, ticket.company_id).catch(() => ticket);

  const text =
    `💬 *Комментарий по заявке ${full.num}*\n` +
    `${full.type_icon || ''} ${full.title || full.type_name || ''}\n\n` +
    `_${comment.author || 'Диспетчер'}:_\n${comment.text}`;

  return sendToUser(ticket.created_by, text, {
    buttons: [[{ text: '✍️ Ответить', data: `reply:${ticket.id}` }]],
    prefer: full.channel,
  });
}

// ─── Назначен подрядчик ────────────────────────────────────────────────────
async function notifyTicketContractor(ticket, contractorId) {
  if (!ticket || !ticket.created_by || !contractorId) return 0;

  const { rows } = await db.query('SELECT * FROM contractors WHERE id = $1', [contractorId]);
  const c = rows[0];
  if (!c) return 0;

  const full = await db.getTicketById(ticket.id, ticket.company_id).catch(() => ticket);

  const lines = [
    `🔧 *Исполнитель назначен — заявка ${full.num}*`,
    `${full.type_icon || ''} ${full.title || full.type_name || ''}`,
    '',
    `*${c.name}*`,
  ];
  if (c.contact_person) lines.push(`👤 Контакт: ${c.contact_person}`);
  if (c.phone)          lines.push(`📞 Телефон: ${c.phone}`);
  if (c.email)          lines.push(`✉️ E-mail: ${c.email}`);
  if (c.website)        lines.push(`🌐 Сайт: ${c.website}`);
  if (c.address)        lines.push(`📍 Адрес: ${c.address}`);
  if (c.work_hours)     lines.push(`🕒 Часы работы: ${c.work_hours}`);
  if (c.notes)          lines.push('', `_${c.notes}_`);

  return sendToUser(ticket.created_by, lines.join('\n'), { prefer: full.channel });
}

module.exports = {
  setBot, setMaxBot, registerSender, sendToUser,
  notifyTicketStatus, notifyTicketComment, notifyTicketContractor,
  STATUS_LABELS, CHANNELS,
};
