// bot.js — адаптер Telegram.
// Вся логика диалога живёт в conversation.js, здесь только перевод
// событий Telegraf в общий формат и обратно.
'use strict';
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const conversation = require('./conversation');

// Главное меню — постоянная клавиатура внизу экрана
function mainMenu() {
  return Markup.keyboard([
    ['📝 Новая заявка', '📋 Мои заявки'],
    ['🚗 Мой кабинет',  '👤 Мой профиль'],
    ['ℹ️ Помощь'],
  ]).resize();
}

// Кнопки под сообщением: data → callback, url → ссылка
const inline = (buttons) => Markup.inlineKeyboard(
  buttons.map(row => row.map(b =>
    b.url ? Markup.button.url(b.text, b.url) : Markup.button.callback(b.text, b.data)
  ))
);

// Отправляет ответы, которые вернула общая логика
async function send(ctx, replies) {
  for (const r of replies) {
    const extra = {};
    if (r.markdown) extra.parse_mode = 'Markdown';
    if (r.buttons) Object.assign(extra, inline(r.buttons));
    else if (r.menu) Object.assign(extra, mainMenu());

    try {
      if (r.kind === 'edit' && ctx.updateType === 'callback_query') {
        await ctx.editMessageText(r.text, extra);
      } else {
        await ctx.reply(r.text, extra);
      }
    } catch (err) {
      // Сообщение могли удалить или оно не изменилось — не роняем диалог
      console.error('[bot] send error:', err.message);
      if (r.kind === 'edit') await ctx.reply(r.text, extra).catch(() => {});
    }
  }
}

function createBot(token) {
  const bot = new Telegraf(token);
  bot.use(session({ defaultSession: conversation.newSession }));

  // Без этого перехватчика одна ошибка останавливает polling для всех
  bot.catch((err, ctx) => {
    console.error('[bot] Ошибка при обработке', ctx?.updateType, '—', err.message);
    ctx?.reply?.('⚠️ Что-то пошло не так. Попробуйте ещё раз или наберите /menu.').catch(() => {});
  });

  const baseInput = (ctx) => ({
    channel:   'telegram',
    userId:    ctx.from.id,
    username:  ctx.from.username,
    firstName: ctx.from.first_name,
    session:   ctx.session,
  });

  bot.start(async (ctx) => {
    ctx.session = conversation.newSession();
    const replies = await conversation.handle({ ...baseInput(ctx), isStart: true });
    await send(ctx, replies);
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Выберите действие:', mainMenu());
  });

  bot.on('text', async (ctx) => {
    const replies = await conversation.handle({ ...baseInput(ctx), text: ctx.message.text });
    await send(ctx, replies);
  });

  bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const replies = await conversation.handle({
      ...baseInput(ctx), callback: ctx.callbackQuery.data,
    });
    await send(ctx, replies);
  });

  return bot;
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
