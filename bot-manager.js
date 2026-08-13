// bot-manager.js — единый бот на все компании + HTTP API (уведомления, синхронизация из CRM)
'use strict';
require('dotenv').config();
const express = require('express');
const db      = require('./db');
const { createBot }  = require('./bot');
const { initSchema } = require('./schema');
const { router: apiRouter } = require('./api');
const notifier = require('./notifier');

const NOTIFY_PORT   = parseInt(process.env.NOTIFY_PORT   || '3001');
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || '';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';

// ─── Единый бот на все компании ───────────────────────────────────────────
let bot = null;
let botUsername = '';

const STATUS_LABELS = {
  NEW: '🆕 Новая', IN_PROGRESS: '🔧 В работе',
  WAITING: '⏳ Ожидание', DONE: '✅ Завершена', CANCELLED: '❌ Отменена',
};

async function startBot() {
  if (!BOT_TOKEN) {
    console.error('[manager] ❌ BOT_TOKEN не задан в .env — бот не запущен.');
    return;
  }
  try {
    bot = createBot(BOT_TOKEN);
    // Проверяем токен и узнаём юзернейм до запуска polling
    const me = await bot.telegram.getMe();
    botUsername = me.username || '';
    // ВАЖНО: bot.launch() в Telegraf 4 резолвится только при остановке бота,
    // поэтому await здесь заблокировал бы запуск HTTP-сервера навсегда.
    // Если polling всё же упал — поднимаем бота заново, чтобы не ждать редеплоя
    const launch = () => bot.launch().catch((err) => {
      console.error('[manager] ❌ Bot polling stopped:', err.message);
      setTimeout(launch, 5000);
    });
    launch();
    notifier.setBot(bot);
    console.log(`[manager] ✅ Бот запущен: @${botUsername}`);
  } catch (err) {
    bot = null;
    console.error('[manager] ❌ Failed to start bot:', err.message);
  }
}

const app = express();
app.use(express.json());

// ─── CORS (нужно, чтобы CRM на другом домене могла звать этот API) ───────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Notify-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── REST API для CRM (аккаунты, водители, ТС, заявки, подрядчики) ────────
app.use('/api', apiRouter);

function checkSecret(req, res, next) {
  if (!NOTIFY_SECRET) return next();
  const h = req.headers['x-notify-secret'];
  if (h !== NOTIFY_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.post('/notify', checkSecret, async (req, res) => {
  const { companyId, ticketId, newStatus, assignedToId } = req.body;
  if (!companyId || !ticketId || !newStatus)
    return res.status(400).json({ error: 'companyId, ticketId, newStatus required' });
  if (!bot) return res.status(503).json({ error: 'Bot is not running' });
  try {
    const ticket = await db.getTicketById(ticketId, companyId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const statusLabel = STATUS_LABELS[newStatus] || newStatus;
    const recipientIds = new Set();
    if (ticket.created_by) recipientIds.add(ticket.created_by);
    if (assignedToId)       recipientIds.add(assignedToId);
    if (ticket.assigned_to) recipientIds.add(ticket.assigned_to);
    let sent = 0;
    for (const uid of recipientIds) {
      const { rows } = await db.query(
        'SELECT telegram_id FROM users WHERE id = $1 AND telegram_id IS NOT NULL', [uid]
      );
      if (!rows[0]) continue;
      const text =
        `🔔 *Обновление заявки ${ticket.num}*\n\n` +
        `Статус изменён: *${statusLabel}*\n` +
        `🚛 ${ticket.vehicle_plate || '—'}\n` +
        `📋 ${ticket.type_icon || ''} ${ticket.type_name || 'Заявка'}\n` +
        `${ticket.description ? ticket.description.slice(0, 100) : ''}`;
      await bot.telegram.sendMessage(rows[0].telegram_id, text, { parse_mode: 'Markdown' });
      sent++;
    }
    res.json({ ok: true, sent });
  } catch (err) {
    console.error('[manager] /notify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Синхронизация карточек из CRM ────────────────────────────────────────
// CRM живёт со своими локальными данными (компании, водители) и зовёт этот
// эндпоинт при создании/сохранении карточки водителя, чтобы бот видел его
// company_id и Telegram-ник и мог опознать водителя при первом /start.
app.post('/sync/driver', checkSecret, async (req, res) => {
  const { companyId, companyName, driver } = req.body;
  if (!companyId || !driver || !driver.name)
    return res.status(400).json({ error: 'companyId and driver.name required' });
  try {
    await db.upsertCompany(companyId, companyName);
    const result = await db.upsertUserFromCrm(companyId, driver);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[manager] /sync/driver error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Отдаёт CRM данные общего бота — чтобы показать готовую ссылку-приглашение.
app.get('/bot-info', (req, res) => {
  res.json({ ok: !!bot, username: botUsername, link: botUsername ? `https://t.me/${botUsername}` : '' });
});

app.get('/health', (_, res) => res.json({ ok: true, active: !!bot, username: botUsername }));

async function shutdown(signal) {
  console.log(`\n[manager] ${signal} received. Stopping bot...`);
  if (bot) { try { await bot.stop(); } catch {} }
  process.exit(0);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  FleetDesk Bot Manager               ║');
  console.log('╚══════════════════════════════════════╝');
  try {
    await initSchema();
  } catch (err) {
    console.error('[schema] ❌ Schema init error:', err.message);
  }
  await startBot();
  app.listen(NOTIFY_PORT, () => {
    console.log(`[manager] HTTP API listening on port ${NOTIFY_PORT}`);
    console.log(`  /api/auth/*         — регистрация, вход, сессия`);
    console.log(`  /api/bootstrap      — все данные компании`);
    console.log(`  /api/drivers|vehicles|tickets|contractors — CRUD`);
    console.log(`  POST /notify        — уведомить водителей о смене статуса`);
    console.log(`  GET  /bot-info      — юзернейм и ссылка общего бота`);
    console.log(`  GET  /health        — healthcheck`);
  });
})();
