// api.js — REST API для CRM. Все данные живут в PostgreSQL,
// изоляция между компаниями — по company_id из сессии.
'use strict';
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const { TICKET_TYPES } = require('./ticket-types');
const { notifyTicketStatus } = require('./notifier');

const router = express.Router();

// ─── Пароли (scrypt из стандартной библиотеки, без внешних зависимостей) ───
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === check.length && crypto.timingSafeEqual(known, check);
}

const initialsOf = (name) =>
  String(name || '').trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);

const PALETTE = ['#3b82f6', '#a855f7', '#22c55e', '#f97316', '#ef4444', '#10b981', '#f59e0b', '#6366f1'];
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

// Пустая строка из формы должна попасть в БД как NULL, иначе DATE/NUMERIC ругаются
const nz  = (v) => (v === '' || v === undefined ? null : v);
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const int = (v) => (v === '' || v === null || v === undefined ? null : parseInt(v, 10) || null);

// ─── Аутентификация ────────────────────────────────────────────────────────
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.company_id, a.email, a.name, a.initials, c.name AS company_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN companies c ON c.id = a.company_id
       WHERE s.token = $1 LIMIT 1`,
      [token]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Сессия истекла, войдите заново' });
    req.account = rows[0];
    next();
  } catch (err) {
    console.error('[api] auth error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

async function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions (token, account_id) VALUES ($1, $2)', [token, accountId]);
  return token;
}

const accountPayload = (a, token) => ({
  token,
  account: { id: a.id, email: a.email, name: a.name, initials: a.initials },
  company: { id: a.company_id, name: a.company_name },
});

// ─── Регистрация / вход ────────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  const { companyName, name, email, password } = req.body || {};
  if (!companyName || !name || !email || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });

  try {
    const exists = await db.query('SELECT 1 FROM accounts WHERE LOWER(email) = LOWER($1)', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email уже зарегистрирован' });

    const companyId = 'co_' + crypto.randomBytes(8).toString('hex');
    await db.query('INSERT INTO companies (id, name, slug) VALUES ($1, $2, $1)', [companyId, companyName]);

    const { rows } = await db.query(
      `INSERT INTO accounts (company_id, email, password_hash, name, initials)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, email, hashPassword(password), name, initialsOf(name)]
    );

    const token = await createSession(rows[0].id);
    res.json(accountPayload({
      id: rows[0].id, company_id: companyId, email, name,
      initials: initialsOf(name), company_name: companyName,
    }, token));
  } catch (err) {
    console.error('[api] register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });
  try {
    const { rows } = await db.query(
      `SELECT a.*, c.name AS company_name FROM accounts a
       JOIN companies c ON c.id = a.company_id
       WHERE LOWER(a.email) = LOWER($1) LIMIT 1`,
      [email]
    );
    const acc = rows[0];
    if (!acc || !verifyPassword(password, acc.password_hash))
      return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = await createSession(acc.id);
    res.json(accountPayload(acc, token));
  } catch (err) {
    console.error('[api] login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/logout', auth, async (req, res) => {
  const token = req.headers.authorization.slice(7);
  await db.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  res.json({ ok: true });
});

router.get('/auth/me', auth, (req, res) => {
  const a = req.account;
  res.json({
    account: { id: a.id, email: a.email, name: a.name, initials: a.initials },
    company: { id: a.company_id, name: a.company_name },
  });
});

// ─── Все данные компании одним запросом ────────────────────────────────────
router.get('/bootstrap', auth, async (req, res) => {
  const cid = req.account.company_id;
  try {
    const [users, vehicles, contractors, tickets] = await Promise.all([
      db.query('SELECT * FROM users       WHERE company_id = $1 ORDER BY name',            [cid]),
      db.query('SELECT * FROM vehicles    WHERE company_id = $1 ORDER BY plate',           [cid]),
      db.query('SELECT * FROM contractors WHERE company_id = $1 ORDER BY name',            [cid]),
      db.query('SELECT * FROM tickets     WHERE company_id = $1 ORDER BY created_at DESC', [cid]),
    ]);
    res.json({
      company:     { id: cid, name: req.account.company_name },
      account:     { id: req.account.id, email: req.account.email, name: req.account.name, initials: req.account.initials },
      users:       users.rows,
      vehicles:    vehicles.rows,
      contractors: contractors.rows,
      tickets:     tickets.rows,
      ticketTypes: TICKET_TYPES,
    });
  } catch (err) {
    console.error('[api] bootstrap error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Водители ──────────────────────────────────────────────────────────────
const DRIVER_FIELDS = [
  'name', 'email', 'phone', 'status', 'initials', 'color',
  'telegram_username', 'license_number', 'license_category', 'license_expires',
  'medical_expires', 'medical_date', 'briefing_date', 'tachograph', 'has_tachograph',
  'has_waybill', 'fuel_card', 'transponder', 'assigned_vehicle',
  'driving_style', 'fuel_per_100km', 'fines_count', 'accidents_count',
];

function driverValues(body) {
  return {
    name:              body.name || 'Без имени',
    email:             nz(body.email),
    phone:             nz(body.phone),
    status:            body.status || 'active',
    initials:          body.initials || initialsOf(body.name),
    color:             body.color || pickColor(),
    telegram_username: nz(String(body.telegram || body.telegram_username || '').replace(/^@/, '').trim()),
    license_number:    nz(body.license_number),
    license_category:  nz(body.license_category),
    license_expires:   nz(body.license_expires),
    medical_expires:   nz(body.medical_expires),
    medical_date:      nz(body.medical_date),
    briefing_date:     nz(body.briefing_date),
    tachograph:        typeof body.tachograph === 'string' ? nz(body.tachograph) : null,
    has_tachograph:    !!body.has_tachograph || body.tachograph === true,
    has_waybill:       !!body.has_waybill,
    fuel_card:         nz(body.fuel_card),
    transponder:       nz(body.transponder),
    assigned_vehicle:  nz(body.assigned_vehicle),
    driving_style:     num(body.driving_style),
    fuel_per_100km:    num(body.fuel_per_100km),
    fines_count:       int(body.fines_count) || 0,
    accidents_count:   int(body.accidents_count) || 0,
  };
}

router.post('/drivers', auth, async (req, res) => {
  const v = driverValues(req.body || {});
  const cols = DRIVER_FIELDS.join(', ');
  const ph   = DRIVER_FIELDS.map((_, i) => `$${i + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `INSERT INTO users (company_id, ${cols}) VALUES ($1, ${ph}) RETURNING *`,
      [req.account.company_id, ...DRIVER_FIELDS.map(f => v[f])]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] create driver error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/drivers/:id', auth, async (req, res) => {
  const v = driverValues(req.body || {});
  const sets = DRIVER_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE users SET ${sets} WHERE id = $${DRIVER_FIELDS.length + 1}
       AND company_id = $${DRIVER_FIELDS.length + 2} RETURNING *`,
      [...DRIVER_FIELDS.map(f => v[f]), req.params.id, req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Водитель не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] update driver error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/drivers/:id', auth, async (req, res) => {
  await db.query('DELETE FROM users WHERE id = $1 AND company_id = $2',
    [req.params.id, req.account.company_id]);
  res.json({ ok: true });
});

// ─── Транспортные средства ─────────────────────────────────────────────────
const VEHICLE_FIELDS = [
  'plate', 'brand', 'model', 'year', 'color', 'vin', 'type', 'status',
  'length', 'width', 'height', 'max_mass', 'purchase_date', 'purchase_type', 'lease_end',
  'mileage', 'location', 'next_service_km', 'next_service_date',
  'insurance_until', 'inspection_until', 'tires_change_date',
  'fuel_card_number', 'fuel_card_code', 'insurance_policy', 'assigned_user_id',
  'telematics', 'tco_monthly', 'parking', 'operation_mode', 'availability_window', 'history',
];

function vehicleValues(body) {
  return {
    plate:              body.plate || '—',
    brand:              nz(body.brand),
    model:              nz(body.model),
    year:               int(body.year),
    color:              nz(body.color),
    vin:                nz(body.vin),
    type:               body.type || 'sedan',
    status:             body.status || 'active',
    length:             int(body.length),
    width:              int(body.width),
    height:             int(body.height),
    max_mass:           int(body.max_mass),
    purchase_date:      nz(body.purchase_date),
    purchase_type:      nz(body.purchase_type),
    lease_end:          nz(body.lease_end),
    mileage:            int(body.mileage),
    location:           nz(body.location),
    next_service_km:    int(body.next_service_km),
    next_service_date:  nz(body.next_service_date),
    insurance_until:    nz(body.insurance_until),
    inspection_until:   nz(body.inspection_until),
    tires_change_date:  nz(body.tires_change_date),
    fuel_card_number:   nz(body.fuel_card_number),
    fuel_card_code:     nz(body.fuel_card_code),
    insurance_policy:   nz(body.insurance_policy),
    assigned_user_id:   nz(body.assigned_user_id),
    telematics:         nz(body.telematics),
    tco_monthly:        int(body.tco_monthly),
    parking:            nz(body.parking),
    operation_mode:     nz(body.operation_mode),
    availability_window:nz(body.availability_window),
    history:            JSON.stringify(Array.isArray(body.history) ? body.history : []),
  };
}

router.post('/vehicles', auth, async (req, res) => {
  const v = vehicleValues(req.body || {});
  const cols = VEHICLE_FIELDS.join(', ');
  const ph   = VEHICLE_FIELDS.map((_, i) => `$${i + 2}`).join(', ');
  try {
    const { rows } = await db.query(
      `INSERT INTO vehicles (company_id, ${cols}) VALUES ($1, ${ph}) RETURNING *`,
      [req.account.company_id, ...VEHICLE_FIELDS.map(f => v[f])]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] create vehicle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/vehicles/:id', auth, async (req, res) => {
  const v = vehicleValues(req.body || {});
  const sets = VEHICLE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE vehicles SET ${sets} WHERE id = $${VEHICLE_FIELDS.length + 1}
       AND company_id = $${VEHICLE_FIELDS.length + 2} RETURNING *`,
      [...VEHICLE_FIELDS.map(f => v[f]), req.params.id, req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Автомобиль не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] update vehicle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/vehicles/:id', auth, async (req, res) => {
  await db.query('DELETE FROM vehicles WHERE id = $1 AND company_id = $2',
    [req.params.id, req.account.company_id]);
  res.json({ ok: true });
});

// ─── Подрядчики ────────────────────────────────────────────────────────────
router.post('/contractors', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await db.query(
      `INSERT INTO contractors (company_id, name, phone, specializations)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.account.company_id, b.name || 'Без названия', nz(b.phone),
       JSON.stringify(Array.isArray(b.specializations) ? b.specializations : [])]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] create contractor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/contractors/:id', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE contractors SET name = $1, phone = $2, specializations = $3
       WHERE id = $4 AND company_id = $5 RETURNING *`,
      [b.name || 'Без названия', nz(b.phone),
       JSON.stringify(Array.isArray(b.specializations) ? b.specializations : []),
       req.params.id, req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Подрядчик не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] update contractor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/contractors/:id', auth, async (req, res) => {
  await db.query('DELETE FROM contractors WHERE id = $1 AND company_id = $2',
    [req.params.id, req.account.company_id]);
  res.json({ ok: true });
});

// ─── Заявки ────────────────────────────────────────────────────────────────
async function nextTicketNum(companyId) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(num, '\\D', '', 'g'), '')::INTEGER), 0) + 1 AS next
     FROM tickets WHERE company_id = $1`,
    [companyId]
  );
  return 'TK-' + String(rows[0].next).padStart(4, '0');
}

router.post('/tickets', auth, async (req, res) => {
  const b   = req.body || {};
  const cid = req.account.company_id;
  try {
    const num = await nextTicketNum(cid);
    const history = [{ from: null, to: 'NEW', time: new Date().toISOString(), who: null }];
    const { rows } = await db.query(
      `INSERT INTO tickets (company_id, num, type_key, title, description, status, priority,
         vehicle_id, created_by, contractor_id, due, comments, history)
       VALUES ($1,$2,$3,$4,$5,'NEW',$6,$7,$8,$9,$10,'[]'::jsonb,$11) RETURNING *`,
      [cid, num, b.type || 'other', nz(b.title), nz(b.desc || b.description),
       b.priority || 'MEDIUM', nz(b.vehicleId || b.vehicle_id),
       nz(b.userId || b.created_by), nz(b.contractorId || b.contractor_id),
       nz(b.due), JSON.stringify(history)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] create ticket error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/tickets/:id', auth, async (req, res) => {
  const b   = req.body || {};
  const cid = req.account.company_id;
  try {
    const cur = await db.query('SELECT * FROM tickets WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]);
    const t = cur.rows[0];
    if (!t) return res.status(404).json({ error: 'Заявка не найдена' });

    const newStatus = b.status || t.status;
    const history   = Array.isArray(t.history) ? t.history.slice() : [];
    if (newStatus !== t.status) {
      history.push({ from: t.status, to: newStatus, time: new Date().toISOString(), who: null });
    }
    const comments = Array.isArray(b.comments) ? b.comments : (t.comments || []);

    const { rows } = await db.query(
      `UPDATE tickets SET type_key = $1, title = $2, description = $3, status = $4, priority = $5,
         vehicle_id = $6, created_by = $7, contractor_id = $8, due = $9,
         comments = $10, history = $11,
         closed_at = CASE WHEN $4 = 'DONE' AND closed_at IS NULL THEN NOW() ELSE closed_at END
       WHERE id = $12 AND company_id = $13 RETURNING *`,
      [b.type || t.type_key, nz(b.title ?? t.title), nz(b.desc ?? b.description ?? t.description),
       newStatus, b.priority || t.priority,
       nz(b.vehicleId ?? b.vehicle_id ?? t.vehicle_id),
       nz(b.userId ?? b.created_by ?? t.created_by),
       nz(b.contractorId ?? b.contractor_id ?? t.contractor_id),
       nz(b.due ?? t.due),
       JSON.stringify(comments), JSON.stringify(history),
       req.params.id, cid]
    );
    res.json(rows[0]);

    // Статус сменился — уведомляем водителя в Telegram (после ответа, чтобы не задерживать CRM)
    if (newStatus !== t.status) {
      notifyTicketStatus(rows[0], newStatus).catch(err =>
        console.error('[api] notify error:', err.message));
    }
  } catch (err) {
    console.error('[api] update ticket error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tickets/:id', auth, async (req, res) => {
  await db.query('DELETE FROM tickets WHERE id = $1 AND company_id = $2',
    [req.params.id, req.account.company_id]);
  res.json({ ok: true });
});

module.exports = { router, auth };
