// ticket-types.js — единый справочник типов заявок для CRM и бота.
// Ключ (key) хранится в tickets.type_key, поэтому заявка, созданная
// в боте, корректно отображается в CRM и наоборот.
'use strict';

const TICKET_TYPES = [
  { key: 'breakdown',   name: 'Поломка / Неисправность', icon: '🔴', sort: 1 },
  { key: 'maintenance', name: 'Плановое ТО',             icon: '🔧', sort: 2 },
  { key: 'tires',       name: 'Шины / Резина',           icon: '🛞', sort: 3 },
  { key: 'fuel',        name: 'Топливо',                 icon: '⛽', sort: 4 },
  { key: 'documents',   name: 'Документы',               icon: '📄', sort: 5 },
  { key: 'fines',       name: 'Штрафы',                  icon: '💸', sort: 6 },
  { key: 'accident',    name: 'ДТП / Авария',            icon: '🚨', sort: 7 },
  { key: 'car_wash',    name: 'Мойка',                   icon: '🚿', sort: 8 },
  { key: 'replacement', name: 'Подменный автомобиль',    icon: '🏥', sort: 9 },
  { key: 'tow_truck',   name: 'Эвакуатор',               icon: '🚛', sort: 10 },
  { key: 'spare_parts', name: 'Запчасти',                icon: '🔩', sort: 11 },
  { key: 'other',       name: 'Прочее',                  icon: '❓', sort: 12 },
];

const BY_KEY = Object.fromEntries(TICKET_TYPES.map(t => [t.key, t]));

module.exports = { TICKET_TYPES, BY_KEY };
