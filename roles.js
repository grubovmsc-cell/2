// roles.js — роли сотрудников компании и их права.
//
// Права заданы списком: так проще добавить роль, не переписывая проверки
// по всему коду. Уровень нужен для правила «нельзя трогать того, кто выше».
'use strict';

const ROLES = {
  owner: {
    key: 'owner', name: 'Владелец', level: 100,
    hint: 'Полный доступ, включая реквизиты компании и управление командой. Владельца нельзя удалить.',
    can: ['*'],
  },
  admin: {
    key: 'admin', name: 'Администратор', level: 80,
    hint: 'Всё то же, что у владельца: данные компании, команда, автопарк, заявки.',
    can: ['company:edit', 'team:manage', 'fleet:edit', 'tickets:edit', 'tickets:delete', 'contractors:edit'],
  },
  dispatcher: {
    key: 'dispatcher', name: 'Диспетчер', level: 50,
    hint: 'Ведёт заявки, водителей и автопарк. Не меняет реквизиты компании и состав команды.',
    can: ['fleet:edit', 'tickets:edit', 'contractors:edit'],
  },
  viewer: {
    key: 'viewer', name: 'Наблюдатель', level: 10,
    hint: 'Только просмотр: видит заявки и автопарк, но ничего не меняет.',
    can: [],
  },
};

const DEFAULT_ROLE = 'dispatcher';

function can(role, permission) {
  const r = ROLES[role] || ROLES[DEFAULT_ROLE];
  return r.can.includes('*') || r.can.includes(permission);
}

const level = (role) => (ROLES[role] || ROLES[DEFAULT_ROLE]).level;
const label = (role) => (ROLES[role] || ROLES[DEFAULT_ROLE]).name;

// Middleware: пускает дальше, только если у роли есть право
function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.account.role, permission)) {
      return res.status(403).json({
        error: 'Недостаточно прав. Обратитесь к администратору компании.',
      });
    }
    next();
  };
}

module.exports = { ROLES, DEFAULT_ROLE, can, level, label, requirePermission };
