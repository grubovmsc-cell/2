// bot.js — единый бот на все компании (мультитенантность по данным пользователя)
'use strict';
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const db = require('./db');

const T = {
  welcome_unlinked: (name) =>
    `👋 Привет, ${name}!\n\nЯ бот FleetDesk — системы управления автопарком.\n\n` +
    `Не нашёл вас по Telegram-нику в базе. Введите ваш рабочий e-mail для привязки аккаунта:`,
  linked: (name) =>
    `✅ Аккаунт привязан! Добро пожаловать, ${name}.\n\nВыберите действие в меню ниже:`,
  linked_auto: (name) =>
    `✅ Узнал вас по Telegram-аккаунту! Добро пожаловать, ${name}.\n\nВыберите действие в меню ниже:`,
  already_linked: (name) =>
    `👋 С возвращением, ${name}! Выберите действие:`,
  email_not_found:
    `❌ Пользователь с таким e-mail не найден в системе.\n` +
    `Попробуйте ещё раз или обратитесь к вашему диспетчеру.`,
  choose_action: 'Выберите действие:',
};

function mainMenu() {
  return Markup.keyboard([
    ['📝 Новая заявка',  '📋 Мои заявки'],
    ['👤 Мой профиль',  'ℹ️ Помощь'],
  ]).resize();
}

const DEFAULT_SESSION = () => ({
  step: null,
  userId: null,
  companyId: null,
  pendingTicket: {},
  editingField: null,
});

function createBot(token) {
  const bot = new Telegraf(token);
  bot.use(session({ defaultSession: DEFAULT_SESSION }));

  // Общий перехватчик: без него любая необработанная ошибка в хендлере
  // останавливает polling и бот перестаёт отвечать всем пользователям
  bot.catch((err, ctx) => {
    console.error('[bot] Ошибка при обработке', ctx?.updateType, '—', err.message);
    ctx?.reply?.('⚠️ Что-то пошло не так. Попробуйте ещё раз или наберите /menu.')
      .catch(() => {});
  });

  bot.start(async (ctx) => {
    const tgId       = ctx.from.id;
    const tgUsername = ctx.from.username;
    const tgName     = ctx.from.first_name || 'Водитель';
    ctx.session = DEFAULT_SESSION();
    try {
      let user = await db.getUserByTelegramId(tgId);
      if (user) {
        ctx.session.userId    = user.id;
        ctx.session.companyId = user.company_id;
        ctx.session.step      = null;
        await ctx.reply(T.already_linked(user.name), mainMenu());
        return;
      }

      // Компания заранее не известна — узнаём водителя по Telegram-нику,
      // который диспетчер указал в его карточке в CRM.
      if (tgUsername) {
        user = await db.getUserByTelegramUsername(tgUsername);
        if (user) {
          await db.linkTelegram(user.id, tgId, tgUsername);
          ctx.session.userId    = user.id;
          ctx.session.companyId = user.company_id;
          ctx.session.step      = null;
          await ctx.reply(T.linked_auto(user.name), mainMenu());
          return;
        }
      }

      ctx.session.step = 'await_email';
      await ctx.reply(T.welcome_unlinked(tgName));
    } catch (err) {
      console.error('[bot] /start error:', err.message);
      await ctx.reply('⚠️ Ошибка сервера. Попробуйте позже.');
    }
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply(T.choose_action, mainMenu());
  });

  bot.on('text', async (ctx) => {
    const text    = ctx.message.text.trim();
    const tgId    = ctx.from.id;
    const session = ctx.session;

    if (session.step === 'await_email') {
      const email = text.toLowerCase();
      try {
        const user = await db.getUserByEmail(email);
        if (!user) { await ctx.reply(T.email_not_found); return; }
        await db.linkTelegram(user.id, tgId, ctx.from.username);
        session.userId    = user.id;
        session.companyId = user.company_id;
        session.step      = null;
        await ctx.reply(T.linked(user.name), mainMenu());
      } catch (err) {
        console.error('[bot] email link error:', err.message);
        await ctx.reply('⚠️ Ошибка. Попробуйте позже.');
      }
      return;
    }

    if (!session.userId) {
      session.step = 'await_email';
      await ctx.reply('Введите ваш рабочий e-mail для привязки аккаунта:');
      return;
    }

    if (session.step === 'new_ticket_desc') {
      session.pendingTicket.description = text;
      try {
        const num    = await db.getNextTicketNum(session.companyId);
        const ticket = await db.createTicket({
          company_id:  session.companyId,
          type_key:    session.pendingTicket.typeKey,
          title:       text.slice(0, 80),
          vehicle_id:  session.pendingTicket.vehicleId,
          description: text,
          created_by:  session.userId,
          num,
        });
        session.step          = null;
        session.pendingTicket = {};
        await ctx.reply(
          `✅ Заявка ${ticket.num} создана!\n\nДиспетчер получит уведомление и назначит исполнителя.`,
          mainMenu()
        );
      } catch (err) {
        console.error('[bot] createTicket error:', err.message);
        await ctx.reply('⚠️ Не удалось создать заявку. Попробуйте позже.');
      }
      return;
    }

    if (session.step === 'profile_value' && session.editingField) {
      const fieldMap = {
        phone: 'Телефон', license_number: 'Номер ВУ',
        license_category: 'Категория ВУ', license_expires: 'Срок действия ВУ',
        medical_expires: 'Срок мед. справки', tachograph: 'Тахограф (серийный №)',
        briefing_date: 'Дата инструктажа',
      };
      const field = session.editingField;
      try {
        await db.updateUserProfile(session.userId, { [field]: text });
        session.step = null; session.editingField = null;
        await ctx.reply(`✅ ${fieldMap[field] || field} обновлено: ${text}`, mainMenu());
        await showProfile(ctx, session.userId);
      } catch (err) {
        console.error('[bot] updateProfile error:', err.message);
        await ctx.reply('⚠️ Ошибка при сохранении.');
      }
      return;
    }

    if (text === '📝 Новая заявка') { await startNewTicket(ctx, session.companyId, session); return; }
    if (text === '📋 Мои заявки')   { await showMyTickets(ctx, session.userId, session.companyId); return; }
    if (text === '👤 Мой профиль')  { await showProfile(ctx, session.userId); return; }
    if (text === 'ℹ️ Помощь') {
      await ctx.reply(
        `ℹ️ *FleetDesk Bot — помощь*\n\n` +
        `📝 *Новая заявка* — создать заявку на ТО, ремонт, шины и т.д.\n` +
        `📋 *Мои заявки* — список ваших активных и последних заявок.\n` +
        `👤 *Мой профиль* — просмотр и редактирование данных водителя.\n\n` +
        `По вопросам: обращайтесь к диспетчеру.`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }
    await ctx.reply(T.choose_action, mainMenu());
  });

  bot.on('callback_query', async (ctx) => {
    const data    = ctx.callbackQuery.data;
    const session = ctx.session;
    await ctx.answerCbQuery();

    if (data.startsWith('tt:')) {
      session.pendingTicket.typeKey = data.split(':')[1];
      session.step = 'new_ticket_vehicle';
      await askVehicle(ctx, session, { onlyAssigned: true });
      return;
    }

    // «Другой автомобиль» — показываем весь парк компании
    if (data === 'veh_all') {
      await askVehicle(ctx, session, { onlyAssigned: false });
      return;
    }

    if (data.startsWith('veh:')) {
      const vehicleId = data.split(':')[1];
      session.pendingTicket.vehicleId = vehicleId;
      session.step = 'new_ticket_desc';
      // editMessageText принимает только inline-клавиатуру, поэтому просто
      // убираем кнопки, передавая пустой inline_keyboard
      await ctx.editMessageText('✏️ Опишите проблему или задачу (текстом):');
      return;
    }

    if (data.startsWith('edit:')) {
      const field = data.split(':')[1];
      session.editingField = field; session.step = 'profile_value';
      const labels = {
        phone: '📞 Телефон', license_number: '🪪 Номер водительского удостоверения',
        license_category: '🔤 Категория ВУ (например: B, C, D, CE)',
        license_expires: '📅 Срок действия ВУ (ДД.ММ.ГГГГ)',
        medical_expires: '🏥 Срок мед. справки (ДД.ММ.ГГГГ)',
        tachograph: '📟 Серийный номер тахографа',
        briefing_date: '📋 Дата последнего инструктажа (ДД.ММ.ГГГГ)',
      };
      await ctx.editMessageText(`${labels[field] || field}\n\nВведите новое значение:`);
      return;
    }

    if (data === 'cancel') {
      session.step = null; session.pendingTicket = {};
      await ctx.editMessageText('❌ Действие отменено.');
      await ctx.reply(T.choose_action, mainMenu());
      return;
    }
  });

  return bot;
}

// Спрашивает автомобиль для заявки. Если за водителем закреплена машина —
// предлагаем сразу её, оставляя возможность выбрать любую другую.
async function askVehicle(ctx, session, { onlyAssigned }) {
  const label = (v) => `🚛 ${v.plate}${v.brand || v.model ? ' — ' + [v.brand, v.model].filter(Boolean).join(' ') : ''}`;
  try {
    if (onlyAssigned) {
      const mine = await db.getAssignedVehicle(session.userId);
      if (mine) {
        await ctx.editMessageText(
          `🚛 За вами закреплён *${mine.plate}*${mine.brand ? ' — ' + [mine.brand, mine.model].filter(Boolean).join(' ') : ''}.\n\nОформляем заявку на него?`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback(`✅ Да, ${mine.plate}`, `veh:${mine.id}`)],
              [Markup.button.callback('🔄 Другой автомобиль', 'veh_all')],
              [Markup.button.callback('❌ Отмена', 'cancel')],
            ]),
          }
        );
        return;
      }
    }

    const vehicles = await db.getVehiclesByCompany(session.companyId);
    if (!vehicles.length) {
      await ctx.editMessageText('⚠️ В компании нет зарегистрированных ТС. Обратитесь к диспетчеру.');
      session.step = null;
      return;
    }
    const buttons = vehicles.map(v => [Markup.button.callback(label(v), `veh:${v.id}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
    await ctx.editMessageText('🚛 Выберите транспортное средство:', Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('[bot] vehicles load error:', err.message);
    await ctx.editMessageText('⚠️ Ошибка загрузки ТС.');
  }
}

async function startNewTicket(ctx, companyId, session) {
  try {
    const types = await db.getTicketTypesByCompany(companyId);
    if (!types.length) {
      await ctx.reply('⚠️ Типы заявок не настроены. Обратитесь к диспетчеру.');
      return;
    }
    session.step = 'new_ticket_type'; session.pendingTicket = {};
    const buttons = types.map(t =>
      [Markup.button.callback(`${t.icon || '📋'} ${t.name}`, `tt:${t.key}`)]
    );
    buttons.push([Markup.button.callback('❌ Отмена', 'cancel')]);
    await ctx.reply('📝 *Новая заявка*\n\nВыберите тип заявки:',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) {
    console.error('[bot] startNewTicket error:', err.message);
    await ctx.reply('⚠️ Ошибка. Попробуйте позже.');
  }
}

async function showMyTickets(ctx, userId, companyId) {
  try {
    const tickets = await db.getTicketsByUser(userId, companyId, 10);
    if (!tickets.length) { await ctx.reply('📋 У вас пока нет заявок.', mainMenu()); return; }
    const STATUS_ICONS = { NEW: '🆕', IN_PROGRESS: '🔧', WAITING: '⏳', DONE: '✅', CANCELLED: '❌' };
    const lines = tickets.map(t =>
      `${STATUS_ICONS[t.status] || '📋'} *${t.num}* — ${t.type_icon || ''} ${t.type_name || 'Заявка'}\n` +
      `   🚛 ${t.vehicle_plate || '—'}  │  ${formatDate(t.created_at)}\n` +
      `   ${t.description ? t.description.slice(0, 60) + (t.description.length > 60 ? '…' : '') : '—'}`
    );
    await ctx.reply(
      `📋 *Мои заявки* (последние ${tickets.length}):\n\n` + lines.join('\n\n'),
      { parse_mode: 'Markdown', ...mainMenu() }
    );
  } catch (err) {
    console.error('[bot] showMyTickets error:', err.message);
    await ctx.reply('⚠️ Не удалось загрузить заявки.');
  }
}

async function showProfile(ctx, userId) {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u) { await ctx.reply('⚠️ Профиль не найден.'); return; }
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('ru-RU') : '—';
    const text =
      `👤 *Мой профиль*\n\n` +
      `*Имя:* ${u.name || '—'}\n*Телефон:* ${u.phone || '—'}\n` +
      `*E-mail:* ${u.email || '—'}\n*Telegram:* @${u.telegram_username || '—'}\n\n` +
      `🪪 *Водительское удостоверение*\nНомер: ${u.license_number || '—'}\n` +
      `Категория: ${u.license_category || '—'}\nДействует до: ${fmtDate(u.license_expires)}\n\n` +
      `🏥 *Мед. справка до:* ${fmtDate(u.medical_expires)}\n` +
      `📟 *Тахограф:* ${u.tachograph || '—'}\n` +
      `📋 *Последний инструктаж:* ${fmtDate(u.briefing_date)}\n`;
    const editButtons = Markup.inlineKeyboard([
      [Markup.button.callback('📞 Телефон', 'edit:phone'),
       Markup.button.callback('🪪 Номер ВУ', 'edit:license_number')],
      [Markup.button.callback('🔤 Категория ВУ', 'edit:license_category'),
       Markup.button.callback('📅 Срок ВУ', 'edit:license_expires')],
      [Markup.button.callback('🏥 Срок мед.', 'edit:medical_expires'),
       Markup.button.callback('📟 Тахограф', 'edit:tachograph')],
      [Markup.button.callback('📋 Инструктаж', 'edit:briefing_date')],
    ]);
    await ctx.reply(text, { parse_mode: 'Markdown', ...editButtons });
  } catch (err) {
    console.error('[bot] showProfile error:', err.message);
    await ctx.reply('⚠️ Ошибка загрузки профиля.');
  }
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

if (require.main === module) {
  const token = process.env.BOT_TOKEN;
  if (!token) { console.error('BOT_TOKEN not set in .env'); process.exit(1); }
  const bot = createBot(token);
  bot.launch()
    .then(() => console.log('[bot] Started (единый бот на все компании)'))
    .catch((err) => { console.error('[bot] Launch error:', err.message); process.exit(1); });
  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { createBot };
