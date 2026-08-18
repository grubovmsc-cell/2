// activity.js — журнал действий пользователей.
// Пишется в фоне: если запись не удалась, основная операция не страдает.
'use strict';
const db = require('./db');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;
}

// req — чтобы взять компанию, аккаунт и IP; остальное описывает само действие
function log(req, action, { entity = null, entityId = null, details = null } = {}) {
  const acc = req.account || {};
  db.query(
    `INSERT INTO activity_log (company_id, account_id, actor, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [acc.company_id || null, acc.id || null, acc.name || acc.email || null,
     action, entity, entityId ? String(entityId) : null,
     details ? String(details).slice(0, 500) : null, clientIp(req)]
  ).catch(err => console.error('[activity]', err.message));
}

// Отдельно — вход, там req.account ещё не заполнен
function logLogin(req, account, ok) {
  db.query(
    `INSERT INTO activity_log (company_id, account_id, actor, action, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [account?.company_id || null, account?.id || null,
     account?.name || account?.email || (req.body || {}).email || null,
     ok ? 'login' : 'login_failed', null, clientIp(req)]
  ).catch(err => console.error('[activity]', err.message));
}

// Человеческие названия действий — используются в админке
const ACTION_LABELS = {
  login:            'Вход в систему',
  login_failed:     'Неудачный вход',
  logout:           'Выход',
  register:         'Регистрация компании',
  driver_create:    'Добавлен водитель',
  driver_update:    'Изменён водитель',
  driver_delete:    'Удалён водитель',
  vehicle_create:   'Добавлен автомобиль',
  vehicle_update:   'Изменён автомобиль',
  vehicle_delete:   'Удалён автомобиль',
  contractor_create:'Добавлен подрядчик',
  contractor_update:'Изменён подрядчик',
  contractor_delete:'Удалён подрядчик',
  ticket_create:    'Создана заявка',
  ticket_update:    'Изменена заявка',
  ticket_delete:    'Удалена заявка',
  import_drivers:   'Загрузка водителей из файла',
  import_vehicles:  'Загрузка автомобилей из файла',

  // Действия администратора сервиса
  admin_company_update:   'Админ: изменена компания',
  admin_company_block:    'Админ: компания заблокирована',
  admin_company_unblock:  'Админ: компания разблокирована',
  admin_company_delete:   'Админ: компания удалена',
  admin_account_create:   'Админ: создан аккаунт',
  admin_account_update:   'Админ: изменён аккаунт',
  admin_account_delete:   'Админ: удалён аккаунт',
  admin_password_reset:   'Админ: сброшен пароль',
  admin_driver_create:    'Админ: добавлен водитель',
  admin_driver_update:    'Админ: изменён водитель',
  admin_driver_delete:    'Админ: удалён водитель',
  admin_vehicle_create:   'Админ: добавлен автомобиль',
  admin_vehicle_update:   'Админ: изменён автомобиль',
  admin_vehicle_delete:   'Админ: удалён автомобиль',
  admin_contractor_create:'Админ: добавлен подрядчик',
  admin_contractor_delete:'Админ: удалён подрядчик',
  admin_ticket_delete:    'Админ: удалена заявка',
};

module.exports = { log, logLogin, ACTION_LABELS, clientIp };
