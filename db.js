// db.js — тонкая обёртка над pg Pool
'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'fleetdesk',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,

  // ── Единый бот на все компании ──────────────────────────────
  // Токена на компанию больше нет — пользователя (и его company_id)
  // ищем глобально: сначала по telegram_id, потом по нику из карточки
  // водителя в CRM, и только в крайнем случае — по e-mail.

  async getUserByTelegramId(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1 LIMIT 1',
      [String(telegramId)]
    );
    return rows[0] || null;
  },

  async getUserByTelegramUsername(username) {
    const clean = String(username || '').replace(/^@/, '').trim();
    if (!clean) return null;
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(telegram_username) = LOWER($1) LIMIT 1',
      [clean]
    );
    return rows[0] || null;
  },

  async getUserByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    return rows[0] || null;
  },

  // ── Синхронизация из CRM (карточки компаний/водителей) ──────

  async upsertCompany(id, name) {
    if (!id) return;
    await pool.query(
      `INSERT INTO companies (id, name, slug) VALUES ($1, $2, $1)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [id, name || id]
    );
  },

  // Апсерт водителя по данным из карточки CRM. Ищем существующую
  // запись в пределах компании по e-mail, а если не нашли — по
  // Telegram-нику, чтобы не плодить дубли при повторном сохранении.
  async upsertUserFromCrm(companyId, data) {
    const email    = (data.email || '').toLowerCase().trim() || null;
    const telegram = String(data.telegram || '').replace(/^@/, '').trim() || null;

    let existing = null;
    if (email) {
      const r = await pool.query(
        'SELECT id FROM users WHERE company_id = $1 AND LOWER(email) = $2 LIMIT 1',
        [companyId, email]
      );
      existing = r.rows[0] || null;
    }
    if (!existing && telegram) {
      const r = await pool.query(
        'SELECT id FROM users WHERE company_id = $1 AND LOWER(telegram_username) = LOWER($2) LIMIT 1',
        [companyId, telegram]
      );
      existing = r.rows[0] || null;
    }

    const fields = {
      name:              data.name || 'Без имени',
      email,
      phone:             data.phone || null,
      telegram_username: telegram,
      license_number:    data.license_number    || null,
      license_category:  data.license_category  || null,
      license_expires:   data.license_expires    || null,
      medical_expires:   data.medical_expires    || null,
      tachograph:        typeof data.tachograph === 'string' ? data.tachograph : null,
      briefing_date:     data.briefing_date      || null,
    };

    if (existing) {
      const keys = Object.keys(fields);
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const vals = keys.map(k => fields[k]);
      vals.push(existing.id);
      await pool.query(`UPDATE users SET ${sets} WHERE id = $${vals.length}`, vals);
      return { id: existing.id, created: false };
    }

    const { rows } = await pool.query(
      `INSERT INTO users (company_id, name, email, phone, telegram_username,
         license_number, license_category, license_expires, medical_expires, tachograph, briefing_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, fields.name, fields.email, fields.phone, fields.telegram_username,
       fields.license_number, fields.license_category, fields.license_expires,
       fields.medical_expires, fields.tachograph, fields.briefing_date]
    );
    return { id: rows[0].id, created: true };
  },

  async linkTelegram(userId, telegramId, telegramUsername) {
    await pool.query(
      'UPDATE users SET telegram_id = $1, telegram_username = $2 WHERE id = $3',
      [String(telegramId), telegramUsername || null, userId]
    );
  },

  async updateUserProfile(userId, fields) {
    const allowed = ['phone', 'license_number', 'license_category', 'license_expires', 'medical_expires', 'tachograph', 'briefing_date'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map(k => fields[k]);
    vals.push(userId);
    await pool.query(`UPDATE users SET ${sets} WHERE id = $${vals.length}`, vals);
  },

  async getTicketsByUser(userId, companyId, limit = 10) {
    const { rows } = await pool.query(
      `SELECT t.*, tt.name AS type_name, tt.icon AS type_icon, v.plate AS vehicle_plate
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.type_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       WHERE t.company_id = $1 AND (t.created_by = $2 OR t.assigned_to = $2)
       ORDER BY t.created_at DESC LIMIT $3`,
      [companyId, userId, limit]
    );
    return rows;
  },

  async getTicketById(ticketId, companyId) {
    const { rows } = await pool.query(
      `SELECT t.*, tt.name AS type_name, tt.icon AS type_icon, v.plate AS vehicle_plate,
              c.name AS contractor_name
       FROM tickets t
       LEFT JOIN ticket_types tt ON tt.id = t.type_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       LEFT JOIN contractors c ON c.id = t.contractor_id
       WHERE t.id = $1 AND t.company_id = $2 LIMIT 1`,
      [ticketId, companyId]
    );
    return rows[0] || null;
  },

  async getVehiclesByCompany(companyId) {
    const { rows } = await pool.query(
      "SELECT * FROM vehicles WHERE company_id = $1 AND status != 'decommissioned' ORDER BY plate",
      [companyId]
    );
    return rows;
  },

  async getTicketTypesByCompany(companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM ticket_types WHERE company_id IS NULL OR company_id = $1 ORDER BY sort_order',
      [companyId]
    );
    return rows;
  },

  async createTicket(data) {
    const { rows } = await pool.query(
      `INSERT INTO tickets (company_id, type_id, vehicle_id, description, status, created_by, num, created_at)
       VALUES ($1, $2, $3, $4, 'NEW', $5, $6, NOW())
       RETURNING *`,
      [data.company_id, data.type_id, data.vehicle_id, data.description, data.created_by, data.num]
    );
    return rows[0];
  },

  async getNextTicketNum(companyId) {
    const { rows } = await pool.query(
      "SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(num, '[^0-9]', '', 'g') AS INTEGER)), 0) + 1 AS next FROM tickets WHERE company_id = $1",
      [companyId]
    );
    return `#${rows[0].next}`;
  },
};
