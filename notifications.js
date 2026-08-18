// notifications.js — какие уведомления получает водитель.
//
// Настройки хранятся у компании (companies.notifications) и читаются
// перед каждой отправкой. Значения по умолчанию — всё включено, чтобы
// поведение не менялось у тех, кто ничего не настраивал.
'use strict';
const db = require('./db');

// Описание событий — по нему CRM строит список переключателей
const EVENTS = [
  { key: 'ticket_status',     name: 'Смена статуса заявки',
    hint: 'Заявка перешла в работу, ожидание или выполнена' },
  { key: 'ticket_urgent',     name: 'Заявка стала срочной',
    hint: 'Приоритет повысился автоматически из-за простоя' },
  { key: 'ticket_comment',    name: 'Комментарий диспетчера',
    hint: 'Водитель получит текст и сможет ответить прямо из мессенджера' },
  { key: 'ticket_contractor', name: 'Назначен исполнитель',
    hint: 'Контакты подрядчика: телефон, адрес, часы работы' },
  { key: 'docs_expiring',     name: 'Истекают документы',
    hint: 'Напоминание о водительском удостоверении, медсправке, ОСАГО и техосмотре' },
  { key: 'service_due',       name: 'Приближается ТО',
    hint: 'Напоминание о плановом обслуживании автомобиля' },
];

const DEFAULTS = {
  ticket_status: true,
  ticket_urgent: true,
  ticket_comment: true,
  ticket_contractor: true,
  docs_expiring: true,
  service_due: true,
  docs_days: 14,          // за сколько дней предупреждать
  quiet_enabled: false,   // не беспокоить ночью
  quiet_from: '21:00',
  quiet_to: '08:00',
};

// Небольшой кэш: настройки читаются на каждое уведомление
const cache = new Map();
const TTL_MS = 60000;

async function getSettings(companyId) {
  if (!companyId) return { ...DEFAULTS };

  const hit = cache.get(companyId);
  if (hit && hit.until > Date.now()) return hit.value;

  let value = { ...DEFAULTS };
  try {
    const { rows } = await db.query('SELECT notifications FROM companies WHERE id = $1', [companyId]);
    value = { ...DEFAULTS, ...(rows[0]?.notifications || {}) };
  } catch (err) {
    console.error('[notifications] read error:', err.message);
  }
  cache.set(companyId, { value, until: Date.now() + TTL_MS });
  return value;
}

const invalidate = (companyId) => cache.delete(companyId);

// «Тихие часы» могут переходить через полночь: 21:00 → 08:00
function inQuietHours(settings, now = new Date()) {
  if (!settings.quiet_enabled) return false;

  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  // Считаем по московскому времени — им живёт большинство автопарков
  const msk = new Date(now.getTime() + (3 * 60 + now.getTimezoneOffset()) * 60000);
  const current = msk.getHours() * 60 + msk.getMinutes();
  const from = toMinutes(settings.quiet_from);
  const to   = toMinutes(settings.quiet_to);

  return from <= to ? (current >= from && current < to)
                    : (current >= from || current < to);
}

// Срочное доходит всегда — иначе смысл срочности теряется
const ALWAYS_DELIVER = new Set(['ticket_urgent']);

async function shouldSend(companyId, event) {
  if (!event) return true;                       // событие не размечено — шлём
  const settings = await getSettings(companyId);

  if (settings[event] === false) return false;
  if (ALWAYS_DELIVER.has(event)) return true;
  if (inQuietHours(settings)) return false;

  return true;
}

module.exports = { EVENTS, DEFAULTS, getSettings, shouldSend, invalidate, inQuietHours };
