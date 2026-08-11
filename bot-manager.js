// bot-manager.js — мульти-тенантный оркестратор
'use strict';
require('dotenv').config();
const express = require('express');
const db      = require('./db');
const { createBot } = require('./bot');

const NOTIFY_PORT   = parseInt(process.env.NOTIFY_PORT   || '3001');
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || '';

const activeBots = new Map();

const STATUS_LABELS = {
  NEW: '🆕 Новая', IN_PROGRESS: '🔧 В работе',
  WAITING: '⏳ Ожидание', DONE: '✅ Завершена', CANCELLED: '❌ Отменена',
};

async function startBotForCompany(companyId, token) {
  if (activeBots.has(companyId)) {
    console.log(`[manager] Bot for company ${companyId} already running — skipping.`);
    return;
  }
  try {
    const bot = createBot(token, companyId);
    await bot.launch();
    activeBots.set(companyId, { bot, token });
    console.log(`[manager] ✅ Bot started for company: ${companyId}`);
  } catch (err) {
    console.error(`[manager] ❌ Failed to start bot for company ${companyId}:`, err.message);
  }
}

async function stopBotForCompany(companyId) {
  const entry = activeBots.get(companyId);
  if (!entry) return;
  try {
    await entry.bot.stop();
    activeBots.delete(companyId);
    console.log(`[manager] 🛑 Bot stopped for company: ${companyId}`);
  } catch (err) {
    console.error(`[manager] Error stopping bot for ${companyId}:`, err.message);
  }
}

async function loadAllCompanies() {
  try {
    const companies = await db.getAllCompaniesWithTokens();
    console.log(`[manager] Found ${companies.length} companies with bot tokens.`);
    for (const c of companies) await startBotForCompany(c.id, c.bot_token);
  } catch (err) {
    console.error('[manager] Error loading companies from DB:', err.message);
    console.error('[manager] Continuing without DB bots (you can add them via API).');
  }
}

const app = express();
app.use(express.json());

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
  const entry = activeBots.get(companyId);
  if (!entry) return res.status(404).json({ error: `No active bot for company ${companyId}` });
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
      await entry.bot.telegram.sendMessage(rows[0].telegram_id, text, { parse_mode: 'Markdown' });
      sent++;
    }
    res.json({ ok: true, sent });
  } catch (err) {
    console.error('[manager] /notify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/bots/add', checkSecret, async (req, res) => {
  const { companyId, token } = req.body;
  if (!companyId || !token) return res.status(400).json({ error: 'companyId and token required' });
  if (activeBots.has(companyId)) await stopBotForCompany(companyId);
  await startBotForCompany(companyId, token);
  try { await db.query('UPDATE companies SET bot_token = $1 WHERE id = $2', [token, companyId]); }
  catch (err) { console.warn('[manager] Could not save token to DB:', err.message); }
  res.json({ ok: activeBots.has(companyId), companyId, active: activeBots.has(companyId) });
});

app.post('/bots/remove', checkSecret, async (req, res) => {
  const { companyId } = req.body;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });
  await stopBotForCompany(companyId);
  try { await db.query("UPDATE companies SET bot_token = NULL WHERE id = $1", [companyId]); } catch {}
  res.json({ ok: true, companyId });
});

app.get('/bots', checkSecret, (req, res) => {
  res.json({ bots: [...activeBots.entries()].map(([id]) => ({ companyId: id, active: true })) });
});

app.get('/health', (_, res) => res.json({ ok: true, bots: activeBots.size }));

async function shutdown(signal) {
  console.log(`\n[manager] ${signal} received. Stopping all bots...`);
  for (const [id] of activeBots) await stopBotForCompany(id);
  process.exit(0);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  FleetDesk Bot Manager               ║');
  console.log('╚══════════════════════════════════════╝');
  await loadAllCompanies();
  app.listen(NOTIFY_PORT, () => {
    console.log(`[manager] HTTP API listening on port ${NOTIFY_PORT}`);
    console.log(`  POST /notify       — уведомить водителей о смене статуса`);
    console.log(`  POST /bots/add     — добавить/обновить токен компании`);
    console.log(`  POST /bots/remove  — остановить бот компании`);
    console.log(`  GET  /bots         — список активных ботов`);
    console.log(`  GET  /health       — healthcheck`);
  });
})();
