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

  async getCompanyByToken(botToken) {
    const { rows } = await pool.query(
      'SELECT * FROM companies WHERE bot_token = $1 LIMIT 1',
      [botToken]
    );
    return rows[0] || null;
  },

  async getAllCompaniesWithTokens() {
    const { rows } = await pool.query(
      "SELECT id, name, bot_token FROM companies WHERE bot_token IS NOT NULL AND bot_token <> ''"
    );
    return rows;
  },

  async getUserByTelegramId(telegramId, companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1 AND company_id = $2 LIMIT 1',
      [String(telegramId), companyId]
    );
    return rows[0] || null;
  },

  async getUserByEmail(email, companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND company_id = $2 LIMIT 1',
      [email, companyId]
    );
    return rows[0] || null;
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
