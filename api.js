// api.js — REST API для CRM. Все данные живут в PostgreSQL,
// изоляция между компаниями — по company_id из сессии.
'use strict';
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const { TICKET_TYPES } = require('./ticket-types');
const { notifyTicketStatus, notifyTicketComment, notifyTicketContractor } = require('./notifier');

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
const CONTRACTOR_FIELDS = ['name', 'phone', 'contact_person', 'email', 'website',
  'address', 'work_hours', 'notes', 'specializations'];

function contractorValues(body) {
  let site = String(body.website || '').trim();
  // Пользователь обычно пишет домен без схемы — добавим, чтобы ссылка работала
  if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
  return {
    name:            body.name || 'Без названия',
    phone:           nz(body.phone),
    contact_person:  nz(body.contact_person),
    email:           nz(body.email),
    website:         site || null,
    address:         nz(body.address),
    work_hours:      nz(body.work_hours),
    notes:           nz(body.notes),
    specializations: JSON.stringify(Array.isArray(body.specializations) ? body.specializations : []),
  };
}

router.post('/contractors', auth, async (req, res) => {
  const v = contractorValues(req.body || {});
  try {
    const { rows } = await db.query(
      `INSERT INTO contractors (company_id, ${CONTRACTOR_FIELDS.join(', ')})
       VALUES ($1, ${CONTRACTOR_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [req.account.company_id, ...CONTRACTOR_FIELDS.map(f => v[f])]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[api] create contractor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/contractors/:id', auth, async (req, res) => {
  const v = contractorValues(req.body || {});
  const sets = CONTRACTOR_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE contractors SET ${sets} WHERE id = $${CONTRACTOR_FIELDS.length + 1}
       AND company_id = $${CONTRACTOR_FIELDS.length + 2} RETURNING *`,
      [...CONTRACTOR_FIELDS.map(f => v[f]), req.params.id, req.account.company_id]
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

    // Уведомления шлём после ответа, чтобы не задерживать CRM
    if (newStatus !== t.status) {
      notifyTicketStatus(rows[0], newStatus).catch(err =>
        console.error('[api] notify error:', err.message));
    }

    // Новые комментарии диспетчера пересылаем водителю в Telegram.
    // Внутренние заметки и ответы самого водителя не отправляем.
    const wasCount = Array.isArray(t.comments) ? t.comments.length : 0;
    for (const c of comments.slice(wasCount)) {
      if (c.internal || c.fromDriver) continue;
      notifyTicketComment(rows[0], c).catch(err =>
        console.error('[api] comment notify error:', err.message));
    }

    // Назначили (или сменили) подрядчика — отправляем водителю его контакты
    if (rows[0].contractor_id && rows[0].contractor_id !== t.contractor_id) {
      notifyTicketContractor(rows[0], rows[0].contractor_id).catch(err =>
        console.error('[api] contractor notify error:', err.message));
    }
  } catch (err) {
    console.error('[api] update ticket error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Свежая версия заявки — CRM подтягивает её при открытии карточки,
// чтобы увидеть ответы водителя из бота
router.get('/tickets/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE id = $1 AND company_id = $2 LIMIT 1',
      [req.params.id, req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tickets/:id', auth, async (req, res) => {
  await db.query('DELETE FROM tickets WHERE id = $1 AND company_id = $2',
    [req.params.id, req.account.company_id]);
  res.json({ ok: true });
});

// ─── Демо-данные ───────────────────────────────────────────────────────────
// Наполняет компанию реалистичным набором записей, чтобы систему можно было
// посмотреть в работе. myTelegram — ник, который получит первый водитель,
// чтобы бот сразу узнавал владельца аккаунта по /start.
router.post('/seed-demo', auth, async (req, res) => {
  const cid = req.account.company_id;
  const myTelegram = String((req.body || {}).myTelegram || '').replace(/^@/, '').trim();

  try {
    const existing = await db.query('SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1', [cid]);
    if (existing.rows[0].n > 0)
      return res.status(409).json({ error: 'В компании уже есть данные — демо добавляется только в пустую' });

    const today = new Date();
    const plus  = (days) => new Date(today.getTime() + days * 864e5).toISOString().slice(0, 10);
    const minus = (days) => new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);

    // ── Автомобили ──
    const vehicles = [
      { plate:'А123БВ77', brand:'Toyota',   model:'Camry',        year:2021, color:'Белый',       type:'sedan', vin:'JT2BF22K1W0246816', status:'active', mileage:84200, location:'Офис, Парковка А', next_service_km:90000,  next_service_date:plus(50),  insurance_until:plus(160), inspection_until:plus(210), tires_change_date:plus(230), fuel_card_number:'4276 3001 1234 5678', fuel_card_code:'FC-001', insurance_policy:'ОСАГО ААА-1234567890', telematics:'Wialon GPS-трекер', tco_monthly:45000, parking:'Офис, Парковка А', operation_mode:'return', availability_window:'08:00–20:00', purchase_date:'2021-03-15', purchase_type:'buy', length:4885, width:1840, height:1445, max_mass:1720,
        history:[{date:minus(95),type:'maintenance',desc:'Замена масла и фильтров, ТО-80000',mileage:80200},{date:minus(266),type:'tires',desc:'Замена резины на зимнюю',mileage:71000}] },
      { plate:'В456ГД77', brand:'BMW',      model:'X5',           year:2022, color:'Чёрный',      type:'suv',   vin:'5UXCR6C55KLL56789', status:'repair', mileage:62100, location:'СТО Авторем',      next_service_km:65000,  next_service_date:plus(19),  insurance_until:plus(8),   inspection_until:plus(119), tires_change_date:plus(80),  fuel_card_number:'4276 3001 9876 5432', fuel_card_code:'FC-002', insurance_policy:'ОСАГО ААА-9876543210', telematics:'Wialon GPS-трекер', tco_monthly:95000, parking:'Офис, Парковка Б', operation_mode:'return', availability_window:'07:00–22:00', purchase_date:'2022-01-10', purchase_type:'lease', lease_end:'2027-01-10', length:4922, width:2004, height:1745, max_mass:2720,
        history:[{date:minus(2),type:'accident',desc:'Диагностика — не заводится (текущий ремонт)',mileage:62100},{date:minus(73),type:'maintenance',desc:'Плановое ТО-60000',mileage:60000}] },
      { plate:'Е789ЖЗ77', brand:'Kia',      model:'Sorento',      year:2020, color:'Серебристый', type:'suv',   vin:'KNAGH814XA5040001', status:'active', mileage:41800, location:'В пути',           next_service_km:45000,  next_service_date:plus(80),  insurance_until:plus(199), inspection_until:plus(41),  tires_change_date:plus(63),  fuel_card_number:'4276 3001 1111 2222', fuel_card_code:'FC-003', insurance_policy:'ОСАГО БББ-1112223334', telematics:'—', tco_monthly:38000, parking:'Склад № 2, Мытищи', operation_mode:'distributed', availability_window:'Круглосуточно', purchase_date:'2020-07-20', purchase_type:'buy', length:4685, width:1900, height:1700, max_mass:2550,
        history:[{date:minus(151),type:'maintenance',desc:'ТО-40000, замена масла, свечей',mileage:40000}] },
      { plate:'К012МН77', brand:'Mercedes', model:'Sprinter',     year:2019, color:'Белый',       type:'van',   vin:'WDB9066321R000001', status:'active', mileage:128000,location:'Склад № 1, Химки', next_service_km:130000, next_service_date:plus(7),   insurance_until:plus(109), inspection_until:plus(231), tires_change_date:plus(68),  fuel_card_number:'4276 3001 3333 4444', fuel_card_code:'FC-004', insurance_policy:'ОСАГО ВВВ-4445556667', telematics:'Wialon GPS-трекер', tco_monthly:62000, parking:'Склад № 1, Химки', operation_mode:'distributed', availability_window:'06:00–23:00', purchase_date:'2019-04-01', purchase_type:'buy', length:5910, width:1993, height:2350, max_mass:3500,
        history:[{date:minus(130),type:'maintenance',desc:'ТО-125000, замена масла, фильтров, ремня',mileage:125000},{date:minus(316),type:'repair',desc:'Замена передних амортизаторов',mileage:119000}] },
      { plate:'О345ПР77', brand:'Lada',     model:'Vesta',        year:2023, color:'Синий',       type:'sedan', vin:'XTA210900N0000001', status:'repair', mileage:33500, location:'СТО Авторем (ДТП)',next_service_km:35000,  next_service_date:plus(33),  insurance_until:plus(28),  inspection_until:plus(88),  tires_change_date:plus(230), fuel_card_number:'4276 3001 5555 6666', fuel_card_code:'FC-005', insurance_policy:'ОСАГО ГГГ-7778889990', telematics:'Wialon GPS-трекер', tco_monthly:25000, parking:'Офис, Парковка А', operation_mode:'return', availability_window:'09:00–18:00', purchase_date:'2023-05-10', purchase_type:'buy', length:4410, width:1764, height:1497, max_mass:1530,
        history:[{date:minus(2),type:'accident',desc:'ДТП на Садовом кольце, повреждён передний бампер',mileage:33500},{date:minus(193),type:'maintenance',desc:'ТО-30000',mileage:30000}] },
    ];

    const vIds = [];
    for (const v of vehicles) {
      const val = vehicleValues(v);
      const { rows } = await db.query(
        `INSERT INTO vehicles (company_id, ${VEHICLE_FIELDS.join(', ')})
         VALUES ($1, ${VEHICLE_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [cid, ...VEHICLE_FIELDS.map(f => val[f])]
      );
      vIds.push(rows[0].id);
    }

    // ── Водители ──
    const drivers = [
      { name:'Иванов Алексей',    color:'#3b82f6', telegram: myTelegram || 'ivanov_a', phone:'+7 916 100-11-22', email:'ivanov@fleet.ru',   status:'active',   license_number:'77 АА 123456', license_category:'B',       license_expires:plus(1000), medical_expires:plus(110), briefing_date:minus(210), medical_date:minus(74),  has_waybill:true,  has_tachograph:false, fuel_card:'4276 3001 1234 5678', transponder:'T-001-2023', driving_style:4.2, fuel_per_100km:9.1,  fines_count:1, accidents_count:0, assigned_vehicle:vIds[0] },
      { name:'Петрова Светлана',  color:'#a855f7', telegram:'petrova_s', phone:'+7 916 200-33-44', email:'petrova@fleet.ru',  status:'active',   license_number:'77 БВ 234567', license_category:'B',       license_expires:plus(365),  medical_expires:plus(33),  briefing_date:minus(246), medical_date:minus(156), has_waybill:true,  has_tachograph:false, fuel_card:'4276 3001 9876 5432', transponder:'T-002-2022', driving_style:4.7, fuel_per_100km:13.2, fines_count:0, accidents_count:0, assigned_vehicle:vIds[1] },
      { name:'Сидоров Дмитрий',   color:'#22c55e', telegram:'sidorov_d', phone:'+7 916 300-55-66', email:'sidorov@fleet.ru',  status:'active',   license_number:'50 ГД 345678', license_category:'B, C',    license_expires:plus(600),  medical_expires:plus(99),  briefing_date:minus(193), medical_date:minus(85),  has_waybill:true,  has_tachograph:true,  fuel_card:'4276 3001 1111 2222', transponder:null,         driving_style:3.5, fuel_per_100km:11.8, fines_count:2, accidents_count:0, assigned_vehicle:vIds[2] },
      { name:'Козлова Мария',     color:'#f97316', telegram:'kozlova_m', phone:'+7 916 400-77-88', email:'kozlova@fleet.ru',  status:'vacation', license_number:'77 ЕЖ 456789', license_category:'B, C, D', license_expires:plus(53),   medical_expires:plus(170), briefing_date:minus(271), medical_date:minus(195), has_waybill:false, has_tachograph:true,  fuel_card:'4276 3001 3333 4444', transponder:'T-004-2020', driving_style:4.9, fuel_per_100km:16.4, fines_count:0, accidents_count:0, assigned_vehicle:vIds[3] },
      { name:'Фёдоров Игорь',     color:'#ef4444', telegram:'fedorov_i', phone:'+7 916 500-99-00', email:'fedorov@fleet.ru',  status:'active',   license_number:'77 ЗИ 567890', license_category:'B',       license_expires:plus(1400), medical_expires:plus(2),   briefing_date:minus(165), medical_date:minus(179), has_waybill:true,  has_tachograph:false, fuel_card:'4276 3001 5555 6666', transponder:'T-005-2023', driving_style:3.8, fuel_per_100km:10.2, fines_count:1, accidents_count:1, assigned_vehicle:vIds[4] },
    ];

    const uIds = [];
    for (const d of drivers) {
      const val = driverValues(d);
      const { rows } = await db.query(
        `INSERT INTO users (company_id, ${DRIVER_FIELDS.join(', ')})
         VALUES ($1, ${DRIVER_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [cid, ...DRIVER_FIELDS.map(f => val[f])]
      );
      uIds.push(rows[0].id);
    }

    // Привязываем автомобили к водителям
    for (let i = 0; i < vIds.length; i++) {
      await db.query('UPDATE vehicles SET assigned_user_id = $1 WHERE id = $2', [uIds[i], vIds[i]]);
    }

    // ── Подрядчики ──
    const contractors = [
      { name:'СТО Авторем',     phone:'+7 495 100-11-22', specializations:['breakdown','maintenance','spare_parts'] },
      { name:'ШинМастер',       phone:'+7 495 200-33-44', specializations:['tires'] },
      { name:'АвтоДок Сервис',  phone:'+7 495 300-55-66', specializations:['documents','fines'] },
      { name:'Буксир-Экспресс', phone:'+7 495 400-77-88', specializations:['tow_truck'] },
      { name:'АвтоБлеск',       phone:'+7 495 500-99-00', specializations:['car_wash'] },
    ];
    const cIds = [];
    for (const c of contractors) {
      const { rows } = await db.query(
        `INSERT INTO contractors (company_id, name, phone, specializations)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [cid, c.name, c.phone, JSON.stringify(c.specializations)]
      );
      cIds.push(rows[0].id);
    }

    // ── Заявки ──
    const iso = (days, hours = 10) =>
      new Date(today.getTime() - days * 864e5).toISOString().slice(0, 11) +
      String(hours).padStart(2, '0') + ':00:00.000Z';

    const ticketsSeed = [
      { type:'breakdown',   title:'Не заводится BMW X5, остановился у офиса', desc:'Утром не смог завести машину. Возможно аккумулятор или стартер. Машина стоит на парковке офиса.', status:'NEW',         priority:'HIGH',   v:1, u:0, c:null, days:0, comments:[{ author:'Иванов Алексей', text:'Машина на парковке Б, место 12', time:iso(0,8), internal:false }] },
      { type:'tires',       title:'Замена летней резины на зимнюю — 3 автомобиля', desc:'Нужна замена резины на Toyota Camry, Kia Sorento и Lada Vesta. Резина уже куплена, лежит на складе.', status:'NEW',    priority:'MEDIUM', v:0, u:1, c:null, days:0, due:plus(4), comments:[] },
      { type:'fines',       title:'Штраф за превышение скорости — А123БВ77',  desc:'Пришёл штраф на 500 руб за превышение 20 км/ч.', status:'NEW',                                              priority:'LOW',    v:0, u:2, c:null, days:1, comments:[] },
      { type:'maintenance', title:'Плановое ТО — Mercedes Sprinter 128 000 км', desc:'Пробег достиг 128 000 км, необходима замена масла, фильтров. Заодно проверить тормозные колодки.', status:'IN_PROGRESS', priority:'MEDIUM', v:3, u:3, c:0, days:2, due:plus(4), comments:[{ author:'Диспетчер', text:'Записали в СТО Авторем на 14-е, 10:00', time:iso(2,14), internal:true }] },
      { type:'fuel',        title:'Не работает топливная карта на Kia Sorento', desc:'Пытался заправиться на АЗС, карта отклоняется. Сказали, что превышен лимит.', status:'IN_PROGRESS',          priority:'HIGH',   v:2, u:2, c:null, days:0, comments:[{ author:'Сидоров Дмитрий', text:'Застрял на заправке, нужна помощь', time:iso(0,12), internal:false },{ author:'Диспетчер', text:'Позвонил в банк, лимит восстановлен', time:iso(0,13), internal:false }] },
      { type:'accident',    title:'ДТП на Садовом кольце, Lada Vesta',        desc:'Небольшое ДТП, повреждён передний бампер. Оформили европротокол.', status:'IN_PROGRESS',                     priority:'URGENT', v:4, u:4, c:0, days:0, comments:[{ author:'Фёдоров Игорь', text:'Фото приложил, европротокол заполнен', time:iso(0,9), internal:false }] },
      { type:'car_wash',    title:'Мойка Toyota Camry после командировки',    desc:'Вернулся из командировки. Машина очень грязная, нужна полная мойка и химчистка салона.', status:'DONE',        priority:'LOW',    v:0, u:0, c:4, days:4, comments:[{ author:'Диспетчер', text:'Готово! Машина у входа', time:iso(3,15), internal:false }] },
      { type:'documents',   title:'Истекает страховка BMW X5',                desc:'ОСАГО на BMW X5 скоро заканчивается. Нужно продлить.', status:'DONE',                                        priority:'HIGH',   v:1, u:1, c:2, days:6, due:plus(8), comments:[{ author:'Диспетчер', text:'Страховка продлена, полис на email', time:iso(3,11), internal:false }] },
    ];

    let n = 0;
    for (const t of ticketsSeed) {
      n++;
      const createdAt = iso(t.days, 9 + (n % 8));
      const history = [{ from:null, to:'NEW', time:createdAt, who:null }];
      if (t.status !== 'NEW') history.push({ from:'NEW', to:t.status === 'DONE' ? 'IN_PROGRESS' : t.status, time:createdAt, who:null });
      if (t.status === 'DONE') history.push({ from:'IN_PROGRESS', to:'DONE', time:iso(Math.max(0, t.days - 1), 15), who:null });

      await db.query(
        `INSERT INTO tickets (company_id, num, type_key, title, description, status, priority,
           vehicle_id, created_by, contractor_id, due, comments, history, created_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [cid, 'TK-' + String(n).padStart(4, '0'), t.type, t.title, t.desc, t.status, t.priority,
         vIds[t.v], uIds[t.u], t.c != null ? cIds[t.c] : null, t.due || null,
         JSON.stringify(t.comments || []), JSON.stringify(history), createdAt,
         t.status === 'DONE' ? iso(Math.max(0, t.days - 1), 15) : null]
      );
    }

    res.json({ ok: true, vehicles: vIds.length, drivers: uIds.length, contractors: cIds.length, tickets: n });
  } catch (err) {
    console.error('[api] seed-demo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, auth };
