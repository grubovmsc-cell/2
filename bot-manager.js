// bot-manager.js — единый бот на все компании + HTTP API (уведомления, синхронизация из CRM)
'use strict';
require('dotenv').config();
const express = require('express');
const db      = require('./db');
const { createBot } = require('./bot');

const NOTIFY_PORT   = parseInt(process.env.NOTIFY_PORT   || '3001');
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || '';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';

// ─── Инициализация схемы БД ───────────────────────────────────────────────────
async function initSchema() {
  console.log('[schema] Initializing database schema...');
  try {
    // Миграция: CRM выдаёт компаниям строковые ID (co_169...), а не UUID.
    // Если старая схема создала companies.id как UUID — пересоздаём таблицы
    // (безопасно только пока в них нет данных).
    const { rows: colCheck } = await db.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'companies' AND column_name = 'id'
    `);
    if (colCheck.length && colCheck[0].data_type === 'uuid') {
      console.log('[schema] Migrating company id columns from UUID to TEXT...');
      await db.query(`DROP TABLE IF EXISTS tickets, contractors, ticket_types, vehicles, users, companies CASCADE`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        slug       TEXT UNIQUE NOT NULL,
        bot_token  TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        email             TEXT,
        phone             TEXT,
        role              TEXT NOT NULL DEFAULT 'EMPLOYEE',
        telegram_id       TEXT UNIQUE,
        telegram_username TEXT,
        license_number    TEXT,
        license_category  TEXT,
        license_expires   DATE,
        medical_expires   DATE,
        tachograph        TEXT,
        briefing_date     DATE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_company  ON users(company_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_telegram_username ON users(LOWER(telegram_username))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email))`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        plate      TEXT NOT NULL,
        model      TEXT,
        brand      TEXT,
        year       SMALLINT,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ticket_types (
        id         SERIAL PRIMARY KEY,
        company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        icon       TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Базовые типы заявок (только если таблица пустая)
    const { rows } = await db.query(`SELECT COUNT(*) FROM ticket_types WHERE company_id IS NULL`);
    if (parseInt(rows[0].count) === 0) {
      await db.query(`
        INSERT INTO ticket_types (name, icon, sort_order) VALUES
          ('Поломка / Неисправность', '🔴', 1),
          ('Плановое ТО',              '🔧', 2),
          ('Шины / Резина',            '🛞', 3),
          ('Топливо',                  '⛽', 4),
          ('Документы',                '📄', 5),
          ('ДТП / Авария',             '🚨', 6),
          ('Мойка',                    '🚿', 7),
          ('Прочее',                   '❓', 8)
      `);
      console.log('[schema] Default ticket types inserted.');
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS contractors (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        phone      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        num           TEXT NOT NULL,
        type_id       INTEGER REFERENCES ticket_types(id),
        vehicle_id    UUID REFERENCES vehicles(id) ON DELETE SET NULL,
        description   TEXT,
        status        TEXT NOT NULL DEFAULT 'NEW',
        created_by    UUID NOT NULL REFERENCES users(id),
        assigned_to   UUID REFERENCES users(id),
        contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_company    ON tickets(company_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by)`);

    console.log('[schema] ✅ Schema ready.');
  } catch (err) {
    console.error('[schema] ❌ Schema init error:', err.message);
    // Не прерываем запуск — возможно схема уже существует
  }
}

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
    bot.launch().catch((err) => {
      console.error('[manager] ❌ Bot polling stopped:', err.message);
    });
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Notify-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
  await initSchema();
  await startBot();
  app.listen(NOTIFY_PORT, () => {
    console.log(`[manager] HTTP API listening on port ${NOTIFY_PORT}`);
    console.log(`  POST /notify        — уведомить водителей о смене статуса`);
    console.log(`  POST /sync/driver   — синхронизировать карточку водителя из CRM`);
    console.log(`  GET  /bot-info      — юзернейм и ссылка общего бота`);
    console.log(`  GET  /health        — healthcheck`);
  });
})();
