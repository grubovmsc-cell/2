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

// Комментарий диспетчера из CRM → водителю в Telegram, с кнопкой «Ответить»
async function notifyTicketComment(ticket, comment) {
  if (!bot || !ticket || !ticket.created_by) return 0;
  try {
    const { rows } = await db.query(
      'SELECT telegram_id FROM users WHERE id = $1 AND telegram_id IS NOT NULL',
      [ticket.created_by]
    );
    if (!rows[0]) return 0;

    const full = await db.getTicketById(ticket.id, ticket.company_id).catch(() => ticket);
    const text =
      `💬 *Комментарий по заявке ${full.num}*\n` +
      `${full.type_icon || ''} ${full.title || full.type_name || ''}\n\n` +
      `_${comment.author || 'Диспетчер'}:_\n${comment.text}`;

    await bot.telegram.sendMessage(rows[0].telegram_id, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✍️ Ответить', callback_data: `reply:${ticket.id}` }]] },
    });
    return 1;
  } catch (err) {
    console.error('[notifier] comment error:', err.message);
    return 0;
  }
}

// Назначен подрядчик → водителю уходят контакты исполнителя
async function notifyTicketContractor(ticket, contractorId) {
  if (!bot || !ticket || !ticket.created_by || !contractorId) return 0;
  try {
    const [{ rows: users }, { rows: contractors }] = await Promise.all([
      db.query('SELECT telegram_id FROM users WHERE id = $1 AND telegram_id IS NOT NULL',
        [ticket.created_by]),
      db.query('SELECT * FROM contractors WHERE id = $1', [contractorId]),
    ]);
    if (!users[0] || !contractors[0]) return 0;

    const c    = contractors[0];
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

    await bot.telegram.sendMessage(users[0].telegram_id, lines.join('\n'), { parse_mode: 'Markdown' });
    return 1;
  } catch (err) {
    console.error('[notifier] contractor error:', err.message);
    return 0;
  }
}

module.exports = { setBot, notifyTicketStatus, notifyTicketComment, notifyTicketContractor, STATUS_LABELS };
