// backup.js — выгрузка и восстановление данных через админку.
//
// Нужен, потому что бэкап должен быть доступен без установки psql и
// прочих инструментов: администратор скачивает файл из браузера.
// Это не замена бэкапам на уровне хостинга, а страховка, которая
// работает всегда и не зависит от настроек хранилища.
'use strict';
const db = require('./db');

// Порядок важен: при восстановлении сначала идут таблицы, на которые
// ссылаются остальные. Сессии не выгружаем — после восстановления
// все всё равно входят заново.
const TABLES = [
  'companies',
  'admins',
  'accounts',
  'users',
  'vehicles',
  'contractors',
  'tickets',
];

// Журнал действий может быть большим — берём только последние записи
const LOG_LIMIT = 5000;

async function exportAll() {
  const data = {
    format: 'fleetdesk-backup',
    version: 1,
    created_at: new Date().toISOString(),
    tables: {},
  };

  for (const table of TABLES) {
    const { rows } = await db.query(`SELECT * FROM ${table}`);
    data.tables[table] = rows;
  }

  const log = await db.query(
    `SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ${LOG_LIMIT}`
  );
  data.tables.activity_log = log.rows;

  data.summary = Object.fromEntries(
    Object.entries(data.tables).map(([name, rows]) => [name, rows.length])
  );
  return data;
}

// Собирает INSERT по фактическим колонкам строки: если схема с момента
// выгрузки изменилась, лишние поля просто отбрасываются
function buildInsert(table, row, columns) {
  const keys = Object.keys(row).filter(k => columns.has(k));
  if (!keys.length) return null;

  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map(k => {
    const v = row[k];
    // JSONB приходит объектом — возвращаем его строкой
    return (v !== null && typeof v === 'object' && !(v instanceof Date))
      ? JSON.stringify(v) : v;
  });

  return {
    text: `INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(', ')})
           VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
    values,
  };
}

async function tableColumns(table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(rows.map(r => r.column_name));
}

// mode: 'merge' — дописать недостающее, 'replace' — заменить всё
async function importAll(data, mode = 'merge') {
  if (!data || data.format !== 'fleetdesk-backup')
    throw new Error('Файл не похож на резервную копию FleetDesk');

  const client = await db.pool.connect();
  const result = { restored: {}, skipped: {}, mode };

  try {
    await client.query('BEGIN');

    if (mode === 'replace') {
      // Обратный порядок — сначала зависимые таблицы.
      // Администраторов сервиса не трогаем: их удаление оборвало бы
      // сессию того, кто прямо сейчас выполняет восстановление.
      for (const table of [...TABLES].reverse()) {
        if (table === 'admins') continue;
        await client.query(`DELETE FROM ${table}`);
      }
      await client.query('DELETE FROM activity_log');
    }

    for (const table of [...TABLES, 'activity_log']) {
      const rows = (data.tables && data.tables[table]) || [];
      if (!rows.length) { result.restored[table] = 0; continue; }

      const columns = await tableColumns(table);
      let ok = 0, skip = 0;

      for (const row of rows) {
        const query = buildInsert(table, row, columns);
        if (!query) { skip++; continue; }
        try {
          const res = await client.query(query.text, query.values);
          if (res.rowCount) ok++; else skip++;
        } catch (err) {
          // Одна плохая строка не должна рушить всё восстановление
          console.error(`[backup] ${table}: ${err.message}`);
          skip++;
        }
      }
      result.restored[table] = ok;
      result.skipped[table] = skip;
    }

    // Сессии после восстановления недействительны
    await client.query('DELETE FROM sessions').catch(() => {});
    await client.query('DELETE FROM driver_sessions').catch(() => {});

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return result;
}

module.exports = { exportAll, importAll, TABLES };
