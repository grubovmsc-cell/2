// notifier.js — отправка уведомлений водителям в Telegram.
// Бот регистрируется здесь при старте, API дёргает notifyTicketStatus
// при смене статуса заявки — так CRM не обязана ничего вызывать сама.
'use strict';
const db = require('./db');

let bot = null;
const setBot = (instance) => { bot = instance; };

const STATUS_LABELS = {
  NEW: '🆕 Новая', IN_PROGRESS: '🔧 В работе',
  WAITING: '⏳ Ожидание', DONE: '✅ Завершена', CANCELLED: '❌ Отменена',
};

async function notifyTicketStatus(ticket, newStatus) {
  if (!bot || !ticket) return 0;
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
  for (const uid of recipients) {
    try {
      const { rows } = await db.query(
        'SELECT telegram_id FROM users WHERE id = $1 AND telegram_id IS NOT NULL', [uid]
      );
      if (!rows[0]) continue;
      await bot.telegram.sendMessage(rows[0].telegram_id, text, { parse_mode: 'Markdown' });
      sent++;
    } catch (err) {
      console.error('[notifier] send error:', err.message);
    }
  }
  return sent;
}

module.exports = { setBot, notifyTicketStatus, STATUS_LABELS };
