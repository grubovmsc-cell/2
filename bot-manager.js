// bot-manager.js — единый бот на все компании + HTTP API (уведомления, синхронизация из CRM)
'use strict';
require('dotenv').config();
const express = require('express');
const db      = require('./db');
const { createBot }  = require('./bot');
const { initSchema } = require('./schema');
const { router: apiRouter } = require('./api');
const { router: driverRouter } = require('./driver');
const { router: adminRouter, ensureFirstAdmin } = require('./admin');
const notifier = require('./notifier');
const { startEscalation } = require('./escalation');

const { MaxBot } = require('./max-bot');

const NOTIFY_PORT   = parseInt(process.env.NOTIFY_PORT   || '3001');
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || '';
const BOT_TOKEN     = process.env.BOT_TOKEN || '';
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN || '';
// Ник бота в MAX. Обычно узнаём его у самого MAX, но если их API
// недоступен с сервера — берём отсюда, чтобы ссылка в CRM всё равно была
const MAX_BOT_USERNAME = (process.env.MAX_BOT_USERNAME || '').replace(/^@/, '').trim();

// ─── Боты: Telegram и MAX, оба на все компании ────────────────────────────
let bot = null;
let botUsername = '';
let maxBot = null;
let maxUsername = MAX_BOT_USERNAME;
let maxError = '';

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
    console.log(`[manager] ✅ Telegram-бот запущен: @${botUsername}`);
  } catch (err) {
    bot = null;
    console.error('[manager] ❌ Failed to start bot:', err.message);
  }
}

async function startMaxBot(attempt = 1) {
  if (!MAX_BOT_TOKEN) {
    console.log('[manager] MAX_BOT_TOKEN не задан — бот MAX не запущен.');
    return;
  }
  try {
    maxBot = new MaxBot(MAX_BOT_TOKEN);
    const me = await maxBot.launch();
    maxUsername = me.username || MAX_BOT_USERNAME;
    maxError = '';
    notifier.setMaxBot(maxBot);
    console.log(`[manager] ✅ MAX-бот запущен: @${maxUsername}`);
  } catch (err) {
    maxBot = null;
    maxError = err.message;
    console.error(`[manager] ❌ Не удалось запустить MAX-бот (попытка ${attempt}):`, err.message);

    // Сеть могла быть недоступна временно — пробуем ещё дважды
    if (attempt < 3) {
      setTimeout(() => startMaxBot(attempt + 1), 15000 * attempt);
    } else {
      console.error('[manager] MAX-бот отключён. Telegram работает как обычно.');
    }
  }
}

const app = express();
// Импорт из Excel и восстановление резервной копии приходят JSON-ом
// и заметно превышают стандартный лимит в 100 КБ
app.use(express.json({ limit: '50mb' }));

// ─── CORS ────────────────────────────────────────────────────────────────────
// CRM живёт на отдельном домене, поэтому доступ разрешаем явным списком.
// Свои домены можно переопределить переменной ALLOWED_ORIGINS (через запятую).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://www.grubov.com,https://grubov.com,https://fleetdesk-crm-production.up.railway.app'
).split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Notify-Secret');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── REST API для CRM (аккаунты, водители, ТС, заявки, подрядчики) ────────
// Кабинет водителя и админку объявляем первыми — у них свои способы входа
app.use('/api/driver', driverRouter);
app.use('/api/admin', adminRouter);
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

// Отдаёт CRM данные ботов — чтобы показать готовые ссылки-приглашения.
app.get('/bot-info', (req, res) => {
  res.json({
    ok: !!bot,
    username: botUsername,
    link: botUsername ? `https://t.me/${botUsername}` : '',
    max: {
      ok: !!maxBot,
      username: maxUsername,
      link: maxUsername ? `https://max.ru/${maxUsername}` : '',
      error: maxError || undefined,
    },
  });
});

app.get('/health', (_, res) => res.json({
  ok: true,
  active: !!bot, username: botUsername,
  maxActive: !!maxBot, maxUsername, maxError: maxError || undefined,
}));

async function shutdown(signal) {
  console.log(`\n[manager] ${signal} received. Stopping bots...`);
  if (bot) { try { await bot.stop(); } catch {} }
  if (maxBot) { try { maxBot.stop(); } catch {} }
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
  await ensureFirstAdmin();
  await startBot();
  await startMaxBot();
  startEscalation();
  app.listen(NOTIFY_PORT, () => {
    console.log(`[manager] HTTP API listening on port ${NOTIFY_PORT}`);
    console.log(`  /api/auth/*         — регистрация, вход, сессия`);
    console.log(`  /api/bootstrap      — все данные компании`);
    console.log(`  /api/import/*       — массовая загрузка из таблицы`);
    console.log(`  /api/driver/*       — личный кабинет водителя`);
    console.log(`  /api/admin/*        — панель администратора`);
    console.log(`  /api/drivers|vehicles|tickets|contractors — CRUD`);
    console.log(`  POST /notify        — уведомить водителей о смене статуса`);
    console.log(`  GET  /bot-info      — юзернейм и ссылка общего бота`);
    console.log(`  GET  /health        — healthcheck`);
  });
})();
