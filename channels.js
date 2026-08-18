// channels.js — реестр каналов связи с водителем.
//
// Чтобы добавить новый мессенджер, достаточно:
//   1) описать его здесь,
//   2) зарегистрировать отправителя в notifier.registerSender(),
//   3) написать адаптер, который зовёт conversation.handle() с этим ключом.
// Остальная система — заявки, уведомления, CRM — подхватит его сама.
'use strict';

const CHANNELS = {
  telegram: {
    key:       'telegram',
    name:      'Telegram',
    idField:   'telegram_id',        // где в users хранится идентификатор
    nameField: 'telegram_username',
    isBot:     true,                 // канал двусторонний, умеет принимать ответы
  },
  max: {
    key:       'max',
    name:      'MAX',
    idField:   'max_id',
    nameField: 'max_username',
    isBot:     true,
  },
  cabinet: {
    key:   'cabinet',
    name:  'Личный кабинет',
    isBot: false,                    // отправлять сюда нельзя, только пометка
  },
  crm: {
    key:   'crm',
    name:  'CRM',
    isBot: false,
  },
};

const BOT_CHANNELS = Object.values(CHANNELS).filter(c => c.isBot);

// Каналы, к которым водитель реально подключён
function availableFor(user) {
  return BOT_CHANNELS.filter(c => user && user[c.idField]);
}

const label = (key) => (CHANNELS[key] && CHANNELS[key].name) || key || '—';

module.exports = { CHANNELS, BOT_CHANNELS, availableFor, label };
