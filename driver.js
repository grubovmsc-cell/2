// driver.js — личный кабинет водителя.
// Регистрации нет: ссылку с одноразовым токеном выдаёт бот, где личность
// водителя уже подтверждена Telegram. Токен даёт доступ только к своим данным.
'use strict';
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const { TICKET_TYPES, BY_KEY } = require('./ticket-types');

const router = express.Router();

const SESSION_TTL_DAYS = 90;   // кабинет открывают редко, срок больше, чем у CRM
const CRM_BASE_URL = (process.env.CRM_BASE_URL || 'https://www.grubov.com').replace(/\/$/, '');

// Выдаёт водителю ссылку на кабинет. Вызывается из бота.
async function createDriverLink(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    'INSERT INTO driver_sessions (token, user_id, last_used_at) VALUES ($1, $2, NOW())',
    [token, userId]
  );
  // Чистим старые ссылки этого водителя, чтобы не копились
  await db.query(
    `DELETE FROM driver_sessions
     WHERE user_id = $1 AND token <> $2
       AND COALESCE(last_used_at, created_at) < NOW() - INTERVAL '1 day'`,
    [userId, token]
  ).catch(() => {});
  return `${CRM_BASE_URL}/driver.html#${token}`;
}

// ─── Авторизация по токену кабинета ────────────────────────────────────────
async function driverAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Нет доступа' });

  try {
    const { rows } = await db.query(
      `SELECT u.*, ds.last_used_at AS session_used_at, c.name AS company_name
       FROM driver_sessions ds
       JOIN users u ON u.id = ds.user_id
       JOIN companies c ON c.id = u.company_id
       WHERE ds.token = $1
         AND COALESCE(ds.last_used_at, ds.created_at) > NOW() - INTERVAL '${SESSION_TTL_DAYS} days'
       LIMIT 1`,
      [token]
    );
    if (!rows[0])
      return res.status(401).json({ error: 'Ссылка устарела. Откройте кабинет заново через бота.' });

    req.driver = rows[0];

    const last = rows[0].session_used_at ? new Date(rows[0].session_used_at).getTime() : 0;
    if (Date.now() - last > 3600_000) {
      db.query('UPDATE driver_sessions SET last_used_at = NOW() WHERE token = $1', [token]).catch(() => {});
    }
    next();
  } catch (err) {
    console.error('[driver] auth error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ─── Данные кабинета ───────────────────────────────────────────────────────
router.get('/me', driverAuth, async (req, res) => {
  const u = req.driver;
  try {
    const [vehicleRes, ticketsRes] = await Promise.all([
      db.query(
        `SELECT * FROM vehicles
         WHERE company_id = $1 AND status <> 'decommissioned'
           AND (id = $2 OR assigned_user_id = $3) LIMIT 1`,
        [u.company_id, u.assigned_vehicle, u.id]
      ),
      db.query(
        `SELECT t.*, v.plate AS vehicle_plate, c.name AS contractor_name, c.phone AS contractor_phone
         FROM tickets t
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN contractors c ON c.id = t.contractor_id
         WHERE t.company_id = $1 AND (t.created_by = $2 OR t.assigned_to = $2)
         ORDER BY t.created_at DESC LIMIT 30`,
        [u.company_id, u.id]
      ),
    ]);

    const v = vehicleRes.rows[0] || null;

    res.json({
      company: { name: u.company_name },
      driver: {
        id: u.id,
        name: u.name,
        phone: u.phone,
        email: u.email,
        status: u.status,
        license_number:   u.license_number,
        license_category: u.license_category,
        license_expires:  dateOnly(u.license_expires),
        medical_expires:  dateOnly(u.medical_expires),
        briefing_date:    dateOnly(u.briefing_date),
        has_tachograph:   u.has_tachograph,
        fuel_card:        u.fuel_card,
      },
      vehicle: v && {
        id: v.id, plate: v.plate, brand: v.brand, model: v.model, year: v.year,
        color: v.color, vin: v.vin, mileage: v.mileage, status: v.status,
        location: v.location,
        insurance_until:   dateOnly(v.insurance_until),
        inspection_until:  dateOnly(v.inspection_until),
        next_service_date: dateOnly(v.next_service_date),
        next_service_km:   v.next_service_km,
        tires_change_date: dateOnly(v.tires_change_date),
        insurance_policy:  v.insurance_policy,
        fuel_card_number:  v.fuel_card_number,
      },
      tickets: ticketsRes.rows.map(t => ({
        id: t.id, num: t.num, title: t.title, description: t.description,
        status: t.status, priority: t.priority,
        type: t.type_key,
        type_name: (BY_KEY[t.type_key] || BY_KEY.other).name,
        type_icon: (BY_KEY[t.type_key] || BY_KEY.other).icon,
        vehicle_plate: t.vehicle_plate,
        contractor_name: t.contractor_name,
        contractor_phone: t.contractor_phone,
        created_at: t.created_at,
        comments: Array.isArray(t.comments) ? t.comments : [],
      })),
      ticketTypes: TICKET_TYPES,
    });
  } catch (err) {
    console.error('[driver] me error:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить данные' });
  }
});

// ─── Свои данные ───────────────────────────────────────────────────────────
router.patch('/profile', driverAuth, async (req, res) => {
  const b = req.body || {};
  const nz = (v) => (v === '' || v === undefined ? null : v);
  try {
    const { rows } = await db.query(
      `UPDATE users SET phone = $1, email = $2, license_number = $3, license_category = $4,
         license_expires = $5, medical_expires = $6, fuel_card = $7
       WHERE id = $8 RETURNING id`,
      [nz(b.phone), nz(b.email), nz(b.license_number), nz(b.license_category),
       nz(b.license_expires), nz(b.medical_expires), nz(b.fuel_card), req.driver.id]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('[driver] profile error:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

// ─── Пробег ────────────────────────────────────────────────────────────────
router.post('/mileage', driverAuth, async (req, res) => {
  const mileage = parseInt((req.body || {}).mileage, 10);
  if (!Number.isFinite(mileage) || mileage < 0)
    return res.status(400).json({ error: 'Укажите пробег числом' });

  try {
    const { rows } = await db.query(
      `SELECT * FROM vehicles WHERE company_id = $1 AND (id = $2 OR assigned_user_id = $3) LIMIT 1`,
      [req.driver.company_id, req.driver.assigned_vehicle, req.driver.id]
    );
    const v = rows[0];
    if (!v) return res.status(404).json({ error: 'За вами не закреплён автомобиль' });

    // Пробег не может уменьшаться — почти всегда это опечатка
    if (v.mileage && mileage < v.mileage)
      return res.status(400).json({
        error: `Пробег меньше текущего (${v.mileage.toLocaleString('ru-RU')} км). Проверьте число.`,
      });

    const entry = {
      date: new Date().toISOString().slice(0, 10),
      type: 'mileage',
      desc: `Водитель ${req.driver.name} указал пробег`,
      mileage,
    };
    await db.query(
      `UPDATE vehicles SET mileage = $1,
         history = COALESCE(history, '[]'::jsonb) || $2::jsonb
       WHERE id = $3`,
      [mileage, JSON.stringify([entry]), v.id]
    );

    res.json({ ok: true, mileage });
  } catch (err) {
    console.error('[driver] mileage error:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить пробег' });
  }
});

// ─── Заявка из кабинета ────────────────────────────────────────────────────
router.post('/tickets', driverAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim())
    return res.status(400).json({ error: 'Опишите проблему' });

  try {
    const num = await db.getNextTicketNum(req.driver.company_id);
    const { rows: veh } = await db.query(
      `SELECT id FROM vehicles WHERE company_id = $1 AND (id = $2 OR assigned_user_id = $3) LIMIT 1`,
      [req.driver.company_id, req.driver.assigned_vehicle, req.driver.id]
    );

    const ticket = await db.createTicket({
      company_id:  req.driver.company_id,
      type_key:    BY_KEY[b.type] ? b.type : 'other',
      title:       String(b.title).trim().slice(0, 200),
      description: String(b.description || b.title).trim().slice(0, 2000),
      vehicle_id:  veh[0] ? veh[0].id : null,
      created_by:  req.driver.id,
      num,
    });
    res.json({ ok: true, num: ticket.num, id: ticket.id });
  } catch (err) {
    console.error('[driver] ticket error:', err.message);
    res.status(500).json({ error: 'Не удалось создать заявку' });
  }
});

// ─── Комментарий к своей заявке ────────────────────────────────────────────
router.post('/tickets/:id/comment', driverAuth, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой комментарий' });

  try {
    const { rows } = await db.query(
      'SELECT id FROM tickets WHERE id = $1 AND company_id = $2 AND created_by = $3 LIMIT 1',
      [req.params.id, req.driver.company_id, req.driver.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Заявка не найдена' });

    await db.addTicketComment(req.params.id, {
      userId: req.driver.id,
      author: req.driver.name,
      text: text.slice(0, 2000),
      time: new Date().toISOString(),
      internal: false,
      fromDriver: true,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[driver] comment error:', err.message);
    res.status(500).json({ error: 'Не удалось отправить' });
  }
});

module.exports = { router, createDriverLink, CRM_BASE_URL };
