// notifier.js — уведомления водителям.
// Водитель может быть подключён к Telegram, к MAX или к обоим —
// сообщение уходит везде, где он есть.
'use strict';
const db = require('./db');

let bot = null;      // Telegram
let maxBot = null;   // MAX

const setBot    = (instance) => { bot = instance; };
const setMaxBot = (instance) => { maxBot = instance; };

const STATUS_LABELS = {
  NEW: '🆕 Новая', IN_PROGRESS: '🔧 В работе',
  WAITING: '⏳ Ожидание', DONE: '✅ Завершена', CANCELLED: '❌ Отменена',
};

// Единая точка отправки: сама разбирается, куда доставить
async function sendToUser(userId, text, buttons) {
  const { rows } = await db.query(
    'SELECT telegram_id, max_id FROM users WHERE id = $1', [userId]
  );
  const u = rows[0];
  if (!u) return 0;

  let sent = 0;

  if (bot && u.telegram_id) {
    try {
      const extra = { parse_mode: 'Markdown' };
      if (buttons) {
        extra.reply_markup = {
          inline_keyboard: buttons.map(row => row.map(b =>
            b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
        };
      }
      await bot.telegram.sendMessage(u.telegram_id, text, extra);
      sent++;
    } catch (err) {
      console.error('[notifier] telegram error:', err.message);
    }
  }

  if (maxBot && u.max_id) {
    try {
      await maxBot.sendMessage(u.max_id, text, { markdown: true, buttons });
      sent++;
    } catch (err) {
      console.error('[notifier] max error:', err.message);
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
  for (const uid of recipients) sent += await sendToUser(uid, text);
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

  return sendToUser(ticket.created_by, text,
    [[{ text: '✍️ Ответить', data: `reply:${ticket.id}` }]]);
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

  return sendToUser(ticket.created_by, lines.join('\n'));
}

module.exports = {
  setBot, setMaxBot, sendToUser,
  notifyTicketStatus, notifyTicketComment, notifyTicketContractor,
  STATUS_LABELS,
};
