// admin.js — панель администратора сервиса.
// Отдельный вход, не связанный с аккаунтами компаний: свои таблицы
// admins / admin_sessions и собственная проверка доступа.
'use strict';
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const { ACTION_LABELS, clientIp } = require('./activity');

const router = express.Router();
const SESSION_TTL_DAYS = 7;   // у админки срок короче, чем у CRM

// ─── Пароли ────────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === check.length && crypto.timingSafeEqual(known, check);
}

// Читаемый временный пароль: без похожих символов вроде 0/O и 1/l
function generatePassword(length = 12) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(length))
    .map(b => abc[b % abc.length]).join('');
}

// ─── Первый администратор ──────────────────────────────────────────────────
// Создаётся из переменных окружения при старте, если таблица пуста
async function ensureFirstAdmin() {
  const email    = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;

  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM admins');
    if (rows[0].n > 0) return;

    await db.query(
      'INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3)',
      [email, hashPassword(password), process.env.ADMIN_NAME || 'Администратор']
    );
    console.log(`[admin] ✅ Создан первый администратор: ${email}`);
  } catch (err) {
    console.error('[admin] ensureFirstAdmin error:', err.message);
  }
}

// ─── Защита от подбора ─────────────────────────────────────────────────────
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function blockedFor(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.until <= Date.now()) return 0;
  return rec.count >= MAX_ATTEMPTS ? rec.until - Date.now() : 0;
}

function noteFail(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.until <= Date.now()) attempts.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  else rec.count++;
}

// ─── Авторизация ───────────────────────────────────────────────────────────
async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется вход' });

  try {
    const { rows } = await db.query(
      `SELECT a.id, a.email, a.name, s.last_used_at
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token = $1
         AND COALESCE(s.last_used_at, s.created_at) > NOW() - INTERVAL '${SESSION_TTL_DAYS} days'
       LIMIT 1`,
      [token]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Сессия истекла, войдите заново' });

    req.admin = rows[0];
    const last = rows[0].last_used_at ? new Date(rows[0].last_used_at).getTime() : 0;
    if (Date.now() - last > 600_000) {
      db.query('UPDATE admin_sessions SET last_used_at = NOW() WHERE token = $1', [token]).catch(() => {});
    }
    next();
  } catch (err) {
    console.error('[admin] auth error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

// Действия администратора тоже пишем в журнал
function logAdmin(req, action, details) {
  db.query(
    `INSERT INTO activity_log (actor, action, details, ip)
     VALUES ($1, $2, $3, $4)`,
    [`Админ: ${req.admin?.email || '—'}`, action, details ? String(details).slice(0, 500) : null, clientIp(req)]
  ).catch(() => {});
}

// ─── Вход ──────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });

  const ip = clientIp(req) || 'unknown';
  const wait = blockedFor(ip);
  if (wait) return res.status(429).json({
    error: `Слишком много попыток. Повторите через ${Math.ceil(wait / 60000)} мин.`,
  });

  try {
    const { rows } = await db.query(
      'SELECT * FROM admins WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]
    );
    const admin = rows[0];
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      noteFail(ip);
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      'INSERT INTO admin_sessions (token, admin_id, last_used_at) VALUES ($1, $2, NOW())',
      [token, admin.id]
    );
    await db.query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [admin.id]);

    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name } });
  } catch (err) {
    console.error('[admin] login error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/logout', adminAuth, async (req, res) => {
  await db.query('DELETE FROM admin_sessions WHERE token = $1',
    [req.headers.authorization.slice(7)]).catch(() => {});
  res.json({ ok: true });
});

router.get('/me', adminAuth, (req, res) => res.json({ admin: req.admin }));

// ─── Сводка ────────────────────────────────────────────────────────────────
router.get('/overview', adminAuth, async (req, res) => {
  try {
    const [companies, totals, recent] = await Promise.all([
      db.query(`
        SELECT c.id, c.name, c.created_at, c.blocked_at, c.note,
          (SELECT COUNT(*)::int FROM accounts    WHERE company_id = c.id) AS accounts,
          (SELECT COUNT(*)::int FROM users       WHERE company_id = c.id) AS drivers,
          (SELECT COUNT(*)::int FROM vehicles    WHERE company_id = c.id) AS vehicles,
          (SELECT COUNT(*)::int FROM contractors WHERE company_id = c.id) AS contractors,
          (SELECT COUNT(*)::int FROM tickets     WHERE company_id = c.id) AS tickets,
          (SELECT COUNT(*)::int FROM tickets     WHERE company_id = c.id
             AND status NOT IN ('DONE','CANCELLED')) AS tickets_open,
          (SELECT MAX(created_at) FROM activity_log
             WHERE company_id = c.id AND action = 'login') AS last_login
        FROM companies c ORDER BY c.created_at DESC`),
      db.query(`
        SELECT (SELECT COUNT(*)::int FROM companies) AS companies,
               (SELECT COUNT(*)::int FROM accounts)  AS accounts,
               (SELECT COUNT(*)::int FROM users)     AS drivers,
               (SELECT COUNT(*)::int FROM vehicles)  AS vehicles,
               (SELECT COUNT(*)::int FROM tickets)   AS tickets,
               (SELECT COUNT(*)::int FROM users WHERE telegram_id IS NOT NULL) AS drivers_in_bot,
               (SELECT COUNT(*)::int FROM activity_log
                  WHERE action = 'login' AND created_at > NOW() - INTERVAL '7 days') AS logins_week`),
      db.query(`
        SELECT company_id, actor, action, entity, details, created_at
        FROM activity_log ORDER BY created_at DESC LIMIT 20`),
    ]);

    res.json({
      companies: companies.rows,
      totals: totals.rows[0],
      recent: recent.rows,
      actionLabels: ACTION_LABELS,
    });
  } catch (err) {
    console.error('[admin] overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Компания ──────────────────────────────────────────────────────────────
router.get('/companies/:id', adminAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const [company, accounts, drivers, vehicles, tickets, log] = await Promise.all([
      db.query('SELECT * FROM companies WHERE id = $1', [cid]),
      db.query(`SELECT a.id, a.email, a.name, a.created_at,
                  (SELECT MAX(created_at) FROM activity_log
                     WHERE account_id = a.id AND action = 'login') AS last_login,
                  (SELECT COUNT(*)::int FROM activity_log WHERE account_id = a.id) AS actions
                FROM accounts a WHERE a.company_id = $1 ORDER BY a.created_at`, [cid]),
      db.query(`SELECT id, name, phone, email, telegram_username, status, telegram_id
                FROM users WHERE company_id = $1 ORDER BY name`, [cid]),
      db.query('SELECT id, plate, brand, model, status, mileage FROM vehicles WHERE company_id = $1 ORDER BY plate', [cid]),
      db.query(`SELECT status, COUNT(*)::int AS n FROM tickets WHERE company_id = $1 GROUP BY status`, [cid]),
      db.query(`SELECT actor, action, entity, details, created_at FROM activity_log
                WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`, [cid]),
    ]);

    if (!company.rows[0]) return res.status(404).json({ error: 'Компания не найдена' });

    res.json({
      company: company.rows[0],
      accounts: accounts.rows,
      drivers: drivers.rows,
      vehicles: vehicles.rows,
      ticketStats: tickets.rows,
      log: log.rows,
    });
  } catch (err) {
    console.error('[admin] company error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/companies/:id', adminAuth, async (req, res) => {
  const { name, note } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE companies SET name = COALESCE($1, name), note = $2 WHERE id = $3 RETURNING *`,
      [name || null, note || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Компания не найдена' });
    logAdmin(req, 'admin_company_update', rows[0].name);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Блокировка — обратимая: данные остаются, вход закрыт
router.post('/companies/:id/block', adminAuth, async (req, res) => {
  const block = (req.body || {}).block !== false;
  try {
    const { rows } = await db.query(
      `UPDATE companies SET blocked_at = ${block ? 'NOW()' : 'NULL'} WHERE id = $1 RETURNING name, blocked_at`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Компания не найдена' });

    // Блокируем — закрываем активные сессии сотрудников
    if (block) {
      await db.query(
        `DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE company_id = $1)`,
        [req.params.id]
      );
    }
    logAdmin(req, block ? 'admin_company_block' : 'admin_company_unblock', rows[0].name);
    res.json({ ok: true, blocked_at: rows[0].blocked_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Полное удаление вместе со всеми данными
router.delete('/companies/:id', adminAuth, async (req, res) => {
  if ((req.body || {}).confirm !== req.params.id)
    return res.status(400).json({ error: 'Удаление не подтверждено' });
  try {
    const { rows } = await db.query('DELETE FROM companies WHERE id = $1 RETURNING name', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Компания не найдена' });
    logAdmin(req, 'admin_company_delete', rows[0].name);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] delete company error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Аккаунты ──────────────────────────────────────────────────────────────
router.post('/companies/:id/accounts', adminAuth, async (req, res) => {
  const { email, name } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'Укажите имя и email' });

  try {
    const exists = await db.query('SELECT 1 FROM accounts WHERE LOWER(email) = LOWER($1)', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Такой email уже зарегистрирован' });

    const company = await db.query('SELECT id FROM companies WHERE id = $1', [req.params.id]);
    if (!company.rows[0]) return res.status(404).json({ error: 'Компания не найдена' });

    const password = generatePassword();
    const initials = String(name).trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);

    const { rows } = await db.query(
      `INSERT INTO accounts (company_id, email, password_hash, name, initials)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name`,
      [req.params.id, email, hashPassword(password), name, initials]
    );
    logAdmin(req, 'admin_account_create', email);

    // Пароль показываем один раз — в базе только хеш
    res.json({ ...rows[0], password });
  } catch (err) {
    console.error('[admin] create account error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/reset-password', adminAuth, async (req, res) => {
  try {
    const password = generatePassword();
    const { rows } = await db.query(
      'UPDATE accounts SET password_hash = $1 WHERE id = $2 RETURNING email, name',
      [hashPassword(password), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Аккаунт не найден' });

    // Старые сессии закрываем — вход только с новым паролем
    await db.query('DELETE FROM sessions WHERE account_id = $1', [req.params.id]);
    logAdmin(req, 'admin_password_reset', rows[0].email);

    res.json({ ok: true, email: rows[0].email, name: rows[0].name, password });
  } catch (err) {
    console.error('[admin] reset password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/accounts/:id', adminAuth, async (req, res) => {
  const { name, email } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE accounts SET name = COALESCE($1, name), email = COALESCE($2, email)
       WHERE id = $3 RETURNING id, email, name`,
      [name || null, email || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Аккаунт не найден' });
    logAdmin(req, 'admin_account_update', rows[0].email);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/accounts/:id', adminAuth, async (req, res) => {
  try {
    const { rows } = await db.query('DELETE FROM accounts WHERE id = $1 RETURNING email', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Аккаунт не найден' });
    logAdmin(req, 'admin_account_delete', rows[0].email);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Журнал ────────────────────────────────────────────────────────────────
router.get('/activity', adminAuth, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const cid    = req.query.company || null;
  const action = req.query.action  || null;

  try {
    const { rows } = await db.query(
      `SELECT l.company_id, c.name AS company_name, l.actor, l.action, l.entity,
              l.details, l.ip, l.created_at
       FROM activity_log l
       LEFT JOIN companies c ON c.id = l.company_id
       WHERE ($1::text IS NULL OR l.company_id = $1)
         AND ($2::text IS NULL OR l.action = $2)
       ORDER BY l.created_at DESC LIMIT $3`,
      [cid, action, limit]
    );
    res.json({ items: rows, actionLabels: ACTION_LABELS });
  } catch (err) {
    console.error('[admin] activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, ensureFirstAdmin };
