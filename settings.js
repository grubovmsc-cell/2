// settings.js — раздел «Настройки»: реквизиты компании, свой профиль,
// команда и приглашения сотрудников.
'use strict';
const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const activity = require('./activity');
const { ROLES, DEFAULT_ROLE, can, level, requirePermission } = require('./roles');

const router = express.Router();

const CRM_BASE_URL = (process.env.CRM_BASE_URL || 'https://www.grubov.com').replace(/\/$/, '');
const INVITE_TTL_DAYS = 7;

const nz = (v) => (v === '' || v === undefined || v === null ? null : String(v).trim() || null);

// Те же правила хеширования, что и при регистрации
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

const initialsOf = (name) => String(name || '').trim().split(/\s+/)
  .map(w => w[0] || '').join('').toUpperCase().slice(0, 2);

// ─── Реквизиты компании ────────────────────────────────────────────────────
const COMPANY_FIELDS = ['name', 'legal_name', 'inn', 'kpp', 'ogrn',
  'legal_address', 'office_address', 'phone', 'email', 'website', 'director'];

router.get('/company', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, ${COMPANY_FIELDS.join(', ')}, created_at FROM companies WHERE id = $1`,
      [req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Компания не найдена' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[settings] company error:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить данные' });
  }
});

router.patch('/company', requirePermission('company:edit'), async (req, res) => {
  const b = req.body || {};
  const values = COMPANY_FIELDS.map(f => f === 'name' ? (nz(b.name) || 'Компания') : nz(b[f]));
  const sets = COMPANY_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  try {
    const { rows } = await db.query(
      `UPDATE companies SET ${sets} WHERE id = $${COMPANY_FIELDS.length + 1} RETURNING *`,
      [...values, req.account.company_id]
    );
    activity.log(req, 'company_update', { entity: 'company', details: rows[0].name });
    res.json(rows[0]);
  } catch (err) {
    console.error('[settings] company update error:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

// ─── Уведомления водителям ─────────────────────────────────────────────────
const notifications = require('./notifications');

router.get('/notifications', async (req, res) => {
  try {
    const value = await notifications.getSettings(req.account.company_id);
    res.json({ settings: value, events: notifications.EVENTS });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось загрузить настройки' });
  }
});

router.patch('/notifications', requirePermission('company:edit'), async (req, res) => {
  const b = req.body || {};
  // Принимаем только известные ключи — мусор в базу не пускаем
  const clean = {};
  notifications.EVENTS.forEach(e => { clean[e.key] = b[e.key] !== false; });
  clean.docs_days     = Math.min(Math.max(parseInt(b.docs_days, 10) || 14, 1), 90);
  clean.quiet_enabled = !!b.quiet_enabled;
  clean.quiet_from    = /^\d{2}:\d{2}$/.test(b.quiet_from) ? b.quiet_from : '21:00';
  clean.quiet_to      = /^\d{2}:\d{2}$/.test(b.quiet_to)   ? b.quiet_to   : '08:00';

  try {
    await db.query('UPDATE companies SET notifications = $1 WHERE id = $2',
      [JSON.stringify(clean), req.account.company_id]);
    notifications.invalidate(req.account.company_id);
    activity.log(req, 'notifications_update');
    res.json({ settings: clean });
  } catch (err) {
    console.error('[settings] notifications error:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

// ─── Свой профиль ──────────────────────────────────────────────────────────
router.patch('/profile', async (req, res) => {
  const b = req.body || {};
  try {
    // Почта — логин, поэтому проверяем, что она свободна
    if (b.email) {
      const busy = await db.query(
        'SELECT 1 FROM accounts WHERE LOWER(email) = LOWER($1) AND id <> $2',
        [b.email, req.account.id]
      );
      if (busy.rows.length) return res.status(409).json({ error: 'Этот email уже занят' });
    }
    const { rows } = await db.query(
      `UPDATE accounts SET name = COALESCE($1, name), email = COALESCE($2, email),
         initials = $3
       WHERE id = $4 RETURNING id, name, email, initials, role`,
      [nz(b.name), nz(b.email), initialsOf(b.name || req.account.name), req.account.id]
    );
    activity.log(req, 'profile_update', { details: rows[0].email });
    res.json(rows[0]);
  } catch (err) {
    console.error('[settings] profile error:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

router.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Введите текущий и новый пароль' });
  if (String(newPassword).length < 6)
    return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });

  try {
    const { rows } = await db.query('SELECT password_hash FROM accounts WHERE id = $1', [req.account.id]);
    if (!rows[0] || !verifyPassword(currentPassword, rows[0].password_hash))
      return res.status(401).json({ error: 'Текущий пароль указан неверно' });

    await db.query('UPDATE accounts SET password_hash = $1 WHERE id = $2',
      [hashPassword(newPassword), req.account.id]);

    // Остальные сессии закрываем — на других устройствах нужно войти заново
    const token = req.headers.authorization.slice(7);
    await db.query('DELETE FROM sessions WHERE account_id = $1 AND token <> $2',
      [req.account.id, token]);

    activity.log(req, 'password_change');
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] password error:', err.message);
    res.status(500).json({ error: 'Не удалось сменить пароль' });
  }
});

// ─── Команда ───────────────────────────────────────────────────────────────
router.get('/team', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.name, a.email, a.role, a.initials, a.created_at, a.activated_at,
              a.invite_expires,
              (a.password_hash IS NULL) AS pending,
              (SELECT MAX(created_at) FROM activity_log
                 WHERE account_id = a.id AND action = 'login') AS last_login
       FROM accounts a WHERE a.company_id = $1
       ORDER BY CASE a.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                            WHEN 'dispatcher' THEN 2 ELSE 3 END, a.created_at`,
      [req.account.company_id]
    );
    res.json({ team: rows, roles: ROLES, me: { id: req.account.id, role: req.account.role } });
  } catch (err) {
    console.error('[settings] team error:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить команду' });
  }
});

// Приглашение: создаём аккаунт без пароля и одноразовую ссылку
router.post('/team/invite', requirePermission('team:manage'), async (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'Укажите имя и email' });

  const newRole = ROLES[role] ? role : DEFAULT_ROLE;
  if (newRole === 'owner')
    return res.status(400).json({ error: 'Владелец в компании только один' });
  if (level(newRole) > level(req.account.role))
    return res.status(403).json({ error: 'Нельзя выдать роль выше собственной' });

  try {
    const busy = await db.query('SELECT 1 FROM accounts WHERE LOWER(email) = LOWER($1)', [email]);
    if (busy.rows.length) return res.status(409).json({ error: 'Этот email уже зарегистрирован' });

    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO accounts (company_id, email, name, initials, role,
         invite_token, invite_expires, invited_by)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '${INVITE_TTL_DAYS} days', $7)
       RETURNING id, email, name, role`,
      [req.account.company_id, email, name, initialsOf(name), newRole, token, req.account.id]
    );

    activity.log(req, 'team_invite', { entity: 'account', entityId: rows[0].id, details: email });

    // Пока почта не подключена — отдаём ссылку, её отправляет сам администратор
    res.json({
      ...rows[0],
      inviteLink: `${CRM_BASE_URL}/invite.html#${token}`,
      expiresInDays: INVITE_TTL_DAYS,
    });
  } catch (err) {
    console.error('[settings] invite error:', err.message);
    res.status(500).json({ error: 'Не удалось пригласить' });
  }
});

// Повторная ссылка, если прежняя потерялась или истекла
router.post('/team/:id/reinvite', requirePermission('team:manage'), async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await db.query(
      `UPDATE accounts SET invite_token = $1,
         invite_expires = NOW() + INTERVAL '${INVITE_TTL_DAYS} days'
       WHERE id = $2 AND company_id = $3 AND password_hash IS NULL
       RETURNING id, email, name`,
      [token, req.params.id, req.account.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Приглашение не найдено или уже принято' });
    res.json({ ...rows[0], inviteLink: `${CRM_BASE_URL}/invite.html#${token}` });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось обновить приглашение' });
  }
});

router.patch('/team/:id', requirePermission('team:manage'), async (req, res) => {
  const { role } = req.body || {};
  if (!ROLES[role]) return res.status(400).json({ error: 'Неизвестная роль' });
  if (role === 'owner') return res.status(400).json({ error: 'Владелец в компании только один' });
  if (req.params.id === req.account.id)
    return res.status(400).json({ error: 'Нельзя изменить собственную роль' });

  try {
    const target = await db.query(
      'SELECT role FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.account.company_id]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
    if (target.rows[0].role === 'owner')
      return res.status(403).json({ error: 'Роль владельца изменить нельзя' });
    if (level(role) > level(req.account.role))
      return res.status(403).json({ error: 'Нельзя выдать роль выше собственной' });

    const { rows } = await db.query(
      'UPDATE accounts SET role = $1 WHERE id = $2 AND company_id = $3 RETURNING id, email, role',
      [role, req.params.id, req.account.company_id]
    );
    activity.log(req, 'team_role_change', { entityId: rows[0].id, details: `${rows[0].email} → ${role}` });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Не удалось изменить роль' });
  }
});

router.delete('/team/:id', requirePermission('team:manage'), async (req, res) => {
  if (req.params.id === req.account.id)
    return res.status(400).json({ error: 'Нельзя удалить собственный аккаунт' });
  try {
    const target = await db.query(
      'SELECT role, email FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.account.company_id]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' });
    if (target.rows[0].role === 'owner')
      return res.status(403).json({ error: 'Владельца компании удалить нельзя' });

    await db.query('DELETE FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.account.company_id]);
    activity.log(req, 'team_remove', { details: target.rows[0].email });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось удалить' });
  }
});

module.exports = { router, hashPassword, verifyPassword, INVITE_TTL_DAYS };
