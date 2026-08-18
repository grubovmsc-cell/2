// conversation.js — сценарии диалога с водителем.
//
// Модуль ничего не знает про Telegram и MAX: на входе — обезличенное
// событие, на выходе — список ответов. Адаптеры (bot.js, max-bot.js)
// переводят это в формат своего мессенджера.
//
// Благодаря этому логика бота живёт в одном месте: добавили шаг —
// он сразу работает в обоих мессенджерах.
'use strict';
const db = require('./db');
const { TICKET_TYPES, BY_KEY } = require('./ticket-types');

// ─── Кнопки главного меню ──────────────────────────────────────────────────
const MENU = [
  { text: '📝 Новая заявка', action: 'new_ticket'  },
  { text: '📋 Мои заявки',   action: 'my_tickets'  },
  { text: '🚗 Мой кабинет',  action: 'cabinet'     },
  { text: '👤 Мой профиль',  action: 'profile'     },
  { text: 'ℹ️ Помощь',       action: 'help'        },
];

const MENU_BY_TEXT = Object.fromEntries(MENU.map(m => [m.text, m.action]));

const STATUS_ICONS = { NEW: '🆕', IN_PROGRESS: '🔧', WAITING: '⏳', DONE: '✅', CANCELLED: '❌' };

const PROFILE_FIELDS = {
  phone:            '📞 Телефон',
  license_number:   '🪪 Номер водительского удостоверения',
  license_category: '🔤 Категория ВУ (например: B, C, D, CE)',
  license_expires:  '📅 Срок действия ВУ (ДД.ММ.ГГГГ)',
  medical_expires:  '🏥 Срок мед. справки (ДД.ММ.ГГГГ)',
  tachograph:       '📟 Серийный номер тахографа',
  briefing_date:    '📋 Дата последнего инструктажа (ДД.ММ.ГГГГ)',
};

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : '—';

// ─── Ответы ────────────────────────────────────────────────────────────────
// reply  — обычное сообщение (menu: true — показать главное меню)
// edit   — заменить текст сообщения с кнопками, если мессенджер это умеет
const reply = (text, opts = {}) => ({ kind: 'reply', text, ...opts });
const edit  = (text, opts = {}) => ({ kind: 'edit',  text, ...opts });

// ─── Опознание водителя ────────────────────────────────────────────────────
// Сессия живёт в памяти и теряется при перезапуске, поэтому пользователя
// всегда можно восстановить из базы: по идентификатору мессенджера,
// а при первом входе — по нику из карточки водителя в CRM.
async function identify(input) {
  const { channel, userId: extId, username } = input;

  const byId = channel === 'max'
    ? await db.getUserByMaxId(extId)
    : await db.getUserByTelegramId(extId);
  if (byId) return { user: byId, justLinked: false };

  if (username) {
    const byName = channel === 'max'
      ? await db.getUserByMaxUsername(username)
      : await db.getUserByTelegramUsername(username);
    if (byName) {
      if (channel === 'max') await db.linkMax(byName.id, extId, username);
      else await db.linkTelegram(byName.id, extId, username);
      return { user: byName, justLinked: true };
    }
  }
  return { user: null, justLinked: false };
}

// ─── Главный обработчик ────────────────────────────────────────────────────
// input: { channel, userId, username, firstName, text, callback, session }
// Возвращает массив ответов; session меняется по месту.
async function handle(input) {
  const s = input.session;
  const text = (input.text || '').trim();
  const cb   = input.callback || null;

  // Восстанавливаем привязку, если сессия пустая
  if (!s.userId) {
    const { user, justLinked } = await identify(input);
    if (user) {
      s.userId = user.id;
      s.companyId = user.company_id;
      s.step = null;
      if (justLinked || input.isStart) {
        return [reply(
          justLinked
            ? `✅ Узнал вас по аккаунту! Добро пожаловать, ${user.name}.\n\nВыберите действие в меню ниже:`
            : `👋 С возвращением, ${user.name}! Выберите действие:`,
          { menu: true }
        )];
      }
    }
  }

  // Кнопка меню всегда прерывает текущий диалог
  const menuAction = MENU_BY_TEXT[text] || (cb && cb.startsWith('menu:') ? cb.slice(5) : null);
  if (menuAction) {
    s.step = null; s.editingField = null; s.replyTicketId = null;
  }

  // ── Не нашли водителя: просим e-mail ──
  if (!s.userId) {
    if (s.step === 'await_email') return linkByEmail(input, s, text);
    if (input.isStart || !text) {
      s.step = 'await_email';
      return [reply(
        `👋 Привет, ${input.firstName || 'Водитель'}!\n\n` +
        `Я бот FleetDesk — системы управления автопарком.\n\n` +
        `Не нашёл вас по нику в базе. Проверьте у диспетчера, что в вашей карточке ` +
        `указан ник ${input.username ? '@' + input.username : 'вашего аккаунта'}, ` +
        `либо введите рабочий e-mail для привязки:`
      )];
    }
    s.step = 'await_email';
    return linkByEmail(input, s, text);
  }

  // ── Начало работы ──
  if (input.isStart) {
    const u = await db.query('SELECT name FROM users WHERE id = $1', [s.userId]);
    return [reply(`👋 С возвращением, ${u.rows[0]?.name || ''}! Выберите действие:`, { menu: true })];
  }

  // ── Кнопки под сообщениями ──
  if (cb) {
    if (cb.startsWith('tt:'))    return chooseVehicle(s, cb.slice(3));
    if (cb === 'veh_all')        return listVehicles(s, false);
    if (cb.startsWith('veh:'))   return describeTicket(s, cb.slice(4));
    if (cb.startsWith('edit:'))  return askProfileValue(s, cb.slice(5));
    if (cb.startsWith('reply:')) return askReply(s, cb.slice(6));
    if (cb === 'cancel') {
      s.step = null; s.pendingTicket = {};
      return [edit('❌ Действие отменено.'), reply('Выберите действие:', { menu: true })];
    }
  }

  // ── Шаги диалога ──
  if (s.step === 'new_ticket_desc')  return createTicket(s, text);
  if (s.step === 'profile_value')    return saveProfileValue(s, text);
  if (s.step === 'reply_comment')    return saveReply(s, text);

  // ── Пункты меню ──
  switch (menuAction) {
    case 'new_ticket': return startNewTicket(s);
    case 'my_tickets': return showTickets(s);
    case 'profile':    return showProfile(s);
    case 'cabinet':    return showCabinet(s);
    case 'help':       return [reply(helpText(), { markdown: true, menu: true })];
  }

  return [reply('Выберите действие:', { menu: true })];
}

// ─── Привязка по e-mail ────────────────────────────────────────────────────
async function linkByEmail(input, s, text) {
  const user = await db.getUserByEmail(text.toLowerCase());
  if (!user) {
    return [reply(
      `❌ Пользователь с таким e-mail не найден в системе.\n` +
      `Попробуйте ещё раз или обратитесь к вашему диспетчеру.`
    )];
  }
  if (input.channel === 'max') await db.linkMax(user.id, input.userId, input.username);
  else await db.linkTelegram(user.id, input.userId, input.username);

  s.userId = user.id;
  s.companyId = user.company_id;
  s.step = null;
  return [reply(`✅ Аккаунт привязан! Добро пожаловать, ${user.name}.\n\nВыберите действие в меню ниже:`, { menu: true })];
}

// ─── Новая заявка ──────────────────────────────────────────────────────────
function startNewTicket(s) {
  s.step = 'new_ticket_type';
  s.pendingTicket = {};
  const buttons = TICKET_TYPES.map(t => [{ text: `${t.icon} ${t.name}`, data: `tt:${t.key}` }]);
  buttons.push([{ text: '❌ Отмена', data: 'cancel' }]);
  return [reply('📝 *Новая заявка*\n\nВыберите тип заявки:', { markdown: true, buttons })];
}

// Если за водителем закреплена машина — предлагаем сразу её
async function chooseVehicle(s, typeKey) {
  s.pendingTicket.typeKey = typeKey;
  s.step = 'new_ticket_vehicle';

  const mine = await db.getAssignedVehicle(s.userId);
  if (mine) {
    const name = [mine.brand, mine.model].filter(Boolean).join(' ');
    return [edit(
      `🚛 За вами закреплён *${mine.plate}*${name ? ' — ' + name : ''}.\n\nОформляем заявку на него?`,
      {
        markdown: true,
        buttons: [
          [{ text: `✅ Да, ${mine.plate}`, data: `veh:${mine.id}` }],
          [{ text: '🔄 Другой автомобиль', data: 'veh_all' }],
          [{ text: '❌ Отмена', data: 'cancel' }],
        ],
      }
    )];
  }
  return listVehicles(s, true);
}

async function listVehicles(s, asEdit) {
  const vehicles = await db.getVehiclesByCompany(s.companyId);
  if (!vehicles.length) {
    s.step = null;
    return [edit('⚠️ В компании нет зарегистрированных ТС. Обратитесь к диспетчеру.')];
  }
  const buttons = vehicles.map(v => [{
    text: `🚛 ${v.plate}${v.brand || v.model ? ' — ' + [v.brand, v.model].filter(Boolean).join(' ') : ''}`,
    data: `veh:${v.id}`,
  }]);
  buttons.push([{ text: '❌ Отмена', data: 'cancel' }]);
  const msg = { buttons };
  return [asEdit === false ? edit('🚛 Выберите транспортное средство:', msg)
                           : edit('🚛 Выберите транспортное средство:', msg)];
}

function describeTicket(s, vehicleId) {
  s.pendingTicket.vehicleId = vehicleId;
  s.step = 'new_ticket_desc';
  return [edit('✏️ Опишите проблему или задачу (текстом):')];
}

async function createTicket(s, text) {
  const num = await db.getNextTicketNum(s.companyId);
  const ticket = await db.createTicket({
    company_id:  s.companyId,
    type_key:    s.pendingTicket.typeKey,
    title:       text.slice(0, 80),
    vehicle_id:  s.pendingTicket.vehicleId,
    description: text,
    created_by:  s.userId,
    num,
  });
  s.step = null;
  s.pendingTicket = {};
  return [reply(
    `✅ Заявка ${ticket.num} создана!\n\nДиспетчер получит уведомление и назначит исполнителя.`,
    { menu: true }
  )];
}

// ─── Мои заявки ────────────────────────────────────────────────────────────
async function showTickets(s) {
  const tickets = await db.getTicketsByUser(s.userId, s.companyId, 10);
  if (!tickets.length) return [reply('📋 У вас пока нет заявок.', { menu: true })];

  const lines = tickets.map(t =>
    `${STATUS_ICONS[t.status] || '📋'} *${t.num}* — ${t.type_icon || ''} ${t.type_name || 'Заявка'}\n` +
    `   🚛 ${t.vehicle_plate || '—'}  │  ${fmtDate(t.created_at)}\n` +
    `   ${t.description ? t.description.slice(0, 60) + (t.description.length > 60 ? '…' : '') : '—'}`
  );
  return [reply(`📋 *Мои заявки* (последние ${tickets.length}):\n\n` + lines.join('\n\n'),
    { markdown: true, menu: true })];
}

// ─── Профиль ───────────────────────────────────────────────────────────────
async function showProfile(s) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [s.userId]);
  const u = rows[0];
  if (!u) return [reply('⚠️ Профиль не найден.', { menu: true })];

  const text =
    `👤 *Мой профиль*\n\n` +
    `*Имя:* ${u.name || '—'}\n*Телефон:* ${u.phone || '—'}\n` +
    `*E-mail:* ${u.email || '—'}\n\n` +
    `🪪 *Водительское удостоверение*\nНомер: ${u.license_number || '—'}\n` +
    `Категория: ${u.license_category || '—'}\nДействует до: ${fmtDate(u.license_expires)}\n\n` +
    `🏥 *Мед. справка до:* ${fmtDate(u.medical_expires)}\n` +
    `📟 *Тахограф:* ${u.tachograph || '—'}\n` +
    `📋 *Последний инструктаж:* ${fmtDate(u.briefing_date)}`;

  return [reply(text, {
    markdown: true,
    buttons: [
      [{ text: '📞 Телефон', data: 'edit:phone' }, { text: '🪪 Номер ВУ', data: 'edit:license_number' }],
      [{ text: '🔤 Категория ВУ', data: 'edit:license_category' }, { text: '📅 Срок ВУ', data: 'edit:license_expires' }],
      [{ text: '🏥 Срок мед.', data: 'edit:medical_expires' }, { text: '📟 Тахограф', data: 'edit:tachograph' }],
      [{ text: '📋 Инструктаж', data: 'edit:briefing_date' }],
    ],
  })];
}

function askProfileValue(s, field) {
  s.editingField = field;
  s.step = 'profile_value';
  return [edit(`${PROFILE_FIELDS[field] || field}\n\nВведите новое значение:`)];
}

async function saveProfileValue(s, text) {
  const field = s.editingField;
  await db.updateUserProfile(s.userId, { [field]: text });
  s.step = null;
  s.editingField = null;
  const label = (PROFILE_FIELDS[field] || field).replace(/^[^\s]+\s/, '').split(' (')[0];
  return [reply(`✅ ${label} обновлено: ${text}`, { menu: true }), ...(await showProfile(s))];
}

// ─── Кабинет ───────────────────────────────────────────────────────────────
async function showCabinet(s) {
  const { createDriverLink } = require('./driver');
  const link = await createDriverLink(s.userId);
  return [reply(
    `🚗 *Ваш личный кабинет*\n\n` +
    `Здесь можно посмотреть данные своей машины, внести пробег и обновить документы.\n\n` +
    `Ссылка личная — не пересылайте её другим.`,
    { markdown: true, buttons: [[{ text: 'Открыть кабинет', url: link }]] }
  )];
}

// ─── Ответ на комментарий диспетчера ───────────────────────────────────────
function askReply(s, ticketId) {
  s.replyTicketId = ticketId;
  s.step = 'reply_comment';
  return [reply('✍️ Напишите ответ — я передам его диспетчеру:')];
}

async function saveReply(s, text) {
  const { rows } = await db.query('SELECT name FROM users WHERE id = $1', [s.userId]);
  const updated = await db.addTicketComment(s.replyTicketId, {
    userId: s.userId,
    author: rows[0]?.name || 'Водитель',
    text,
    time: new Date().toISOString(),
    internal: false,
    fromDriver: true,
  });
  s.step = null;
  s.replyTicketId = null;
  return [reply(
    updated ? `✅ Ответ отправлен диспетчеру по заявке ${updated.num}.` : '✅ Ответ отправлен.',
    { menu: true }
  )];
}

function helpText() {
  return `ℹ️ *FleetDesk Bot — помощь*\n\n` +
    `📝 *Новая заявка* — создать заявку на ТО, ремонт, шины и т.д.\n` +
    `📋 *Мои заявки* — список ваших активных и последних заявок.\n` +
    `🚗 *Мой кабинет* — данные автомобиля, пробег, документы.\n` +
    `👤 *Мой профиль* — просмотр и редактирование данных водителя.\n\n` +
    `По вопросам: обращайтесь к диспетчеру.`;
}

const newSession = () => ({
  step: null, userId: null, companyId: null,
  pendingTicket: {}, editingField: null, replyTicketId: null,
});

module.exports = { handle, newSession, MENU, MENU_BY_TEXT, BY_KEY };
