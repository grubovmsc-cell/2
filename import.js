// import.js — массовая загрузка водителей и автомобилей из таблицы.
// Фронтенд разбирает .xlsx у себя и присылает готовые строки, сервер
// проверяет их, обновляет существующие записи и создаёт новые.
'use strict';
const db = require('./db');

// ─── Описание колонок ──────────────────────────────────────────────────────
// Порядок и подписи используются и при выгрузке шаблона, и при разборе файла.
// key      — поле в БД
// title    — заголовок колонки в Excel
// hint     — подсказка под заголовком
// type     — как приводить значение
// options  — допустимые значения для выпадающего списка

const DRIVER_COLUMNS = [
  { key: 'name',             title: 'ФИО',                  hint: 'Обязательно. Иванов Иван Иванович', type: 'text', required: true },
  { key: 'phone',            title: 'Телефон',              hint: '+7 916 000-00-00',                  type: 'text' },
  { key: 'email',            title: 'E-mail',               hint: 'ivanov@company.ru',                 type: 'email' },
  { key: 'telegram',         title: 'Telegram',             hint: 'Ник без @ — по нему бот узнаёт водителя', type: 'telegram' },
  { key: 'max',              title: 'MAX',                  hint: 'Ник в мессенджере MAX, без @',       type: 'telegram' },
  { key: 'status',           title: 'Статус',               hint: 'На работе / В отпуске / Уволен',     type: 'enum',
    options: { 'на работе': 'active', 'в отпуске': 'vacation', 'уволен': 'fired' }, default: 'active' },
  { key: 'license_number',   title: 'Номер ВУ',             hint: '77 АА 123456',                      type: 'text' },
  { key: 'license_category', title: 'Категории ВУ',         hint: 'B или B, C',                        type: 'text' },
  { key: 'license_expires',  title: 'ВУ действует до',      hint: 'ДД.ММ.ГГГГ',                        type: 'date' },
  { key: 'medical_expires',  title: 'Медсправка до',        hint: 'ДД.ММ.ГГГГ',                        type: 'date' },
  { key: 'briefing_date',    title: 'Дата инструктажа',     hint: 'ДД.ММ.ГГГГ',                        type: 'date' },
  { key: 'has_tachograph',   title: 'Карта тахографа',      hint: 'Да / Нет',                          type: 'bool' },
  { key: 'has_waybill',      title: 'Путевой лист',         hint: 'Да / Нет',                          type: 'bool' },
  { key: 'fuel_card',        title: 'Топливная карта',      hint: 'Номер карты',                       type: 'text' },
  { key: 'assigned_plate',   title: 'Гос. номер авто',      hint: 'Закрепить машину — укажите её номер', type: 'text' },
];

const VEHICLE_COLUMNS = [
  { key: 'plate',             title: 'Гос. номер',        hint: 'Обязательно. А123БВ77',            type: 'text', required: true },
  { key: 'brand',             title: 'Марка',             hint: 'Toyota',                           type: 'text' },
  { key: 'model',             title: 'Модель',            hint: 'Camry',                            type: 'text' },
  { key: 'year',              title: 'Год выпуска',       hint: '2021',                             type: 'int' },
  { key: 'type',              title: 'Тип',               hint: 'Седан / Внедорожник / Фургон / Грузовик', type: 'enum',
    options: { 'седан': 'sedan', 'внедорожник': 'suv', 'фургон': 'van', 'микроавтобус': 'van', 'грузовик': 'truck' }, default: 'sedan' },
  { key: 'status',            title: 'Состояние',         hint: 'В работе / Ремонт / Простой',      type: 'enum',
    options: { 'в работе': 'active', 'ремонт': 'repair', 'простой': 'idle' }, default: 'active' },
  { key: 'vin',               title: 'VIN',               hint: '17 символов',                      type: 'text' },
  { key: 'color',             title: 'Цвет',              hint: 'Белый',                            type: 'text' },
  { key: 'mileage',           title: 'Пробег, км',        hint: '84200',                            type: 'int' },
  { key: 'location',          title: 'Местоположение',    hint: 'Офис, парковка А',                 type: 'text' },
  { key: 'insurance_until',   title: 'ОСАГО до',          hint: 'ДД.ММ.ГГГГ',                       type: 'date' },
  { key: 'inspection_until',  title: 'Техосмотр до',      hint: 'ДД.ММ.ГГГГ',                       type: 'date' },
  { key: 'next_service_date', title: 'Следующее ТО',      hint: 'ДД.ММ.ГГГГ',                       type: 'date' },
  { key: 'next_service_km',   title: 'ТО при пробеге, км', hint: '90000',                           type: 'int' },
  { key: 'tires_change_date', title: 'Смена резины',      hint: 'ДД.ММ.ГГГГ',                       type: 'date' },
  { key: 'fuel_card_number',  title: 'Топливная карта',   hint: 'Номер карты',                      type: 'text' },
  { key: 'insurance_policy',  title: 'Полис ОСАГО',       hint: 'Серия и номер',                    type: 'text' },
  { key: 'driver_phone',      title: 'Телефон водителя',  hint: 'Закрепить водителя — укажите его телефон', type: 'text' },
];

// ─── Приведение значений ───────────────────────────────────────────────────

const YES = ['да', 'yes', 'true', '1', '+', 'есть'];

// Excel отдаёт даты по-разному: как текст ДД.ММ.ГГГГ, как ISO или как число
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);

  const raw = String(value).trim();
  if (!raw) return null;

  // ДД.ММ.ГГГГ или ДД/ММ/ГГГГ
  const ru = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (ru) {
    const [, d, m, y] = ru;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Уже ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  // Серийный номер даты Excel (отсчёт с 30.12.1899)
  if (/^\d+$/.test(raw)) {
    const serial = parseInt(raw, 10);
    if (serial > 20000 && serial < 60000) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 864e5).toISOString().slice(0, 10);
    }
  }

  return undefined;   // не смогли разобрать — сообщим пользователю
}

function castValue(column, raw) {
  const empty = raw === null || raw === undefined || String(raw).trim() === '';

  switch (column.type) {
    case 'int': {
      if (empty) return null;
      const n = parseInt(String(raw).replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'bool':
      return empty ? false : YES.includes(String(raw).trim().toLowerCase());
    case 'date':
      return parseDate(raw);
    case 'enum': {
      if (empty) return column.default || null;
      const key = String(raw).trim().toLowerCase();
      // принимаем и русскую подпись, и внутреннее значение
      if (column.options[key]) return column.options[key];
      if (Object.values(column.options).includes(key)) return key;
      return undefined;
    }
    case 'email': {
      if (empty) return null;
      const v = String(raw).trim().toLowerCase();
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : undefined;
    }
    case 'telegram':
      return empty ? null : String(raw).trim().replace(/^@/, '');
    default:
      return empty ? null : String(raw).trim().slice(0, 500);
  }
}

// Превращает строку файла в набор полей + список ошибок
function normalizeRow(columns, row) {
  const values = {};
  const errors = [];

  for (const col of columns) {
    const cast = castValue(col, row[col.key]);
    if (cast === undefined) {
      errors.push(`«${col.title}»: не удалось разобрать значение «${row[col.key]}»`);
      continue;
    }
    if (col.required && (cast === null || cast === '')) {
      errors.push(`«${col.title}» — обязательное поле`);
      continue;
    }
    values[col.key] = cast;
  }
  return { values, errors };
}

// ─── Загрузка водителей ────────────────────────────────────────────────────

async function importDrivers(companyId, rows) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  // Карта госномеров для привязки машины к водителю
  const { rows: vehicles } = await db.query(
    'SELECT id, plate FROM vehicles WHERE company_id = $1', [companyId]
  );
  const plateMap = new Map(vehicles.map(v => [String(v.plate).toUpperCase().replace(/\s/g, ''), v.id]));

  for (let i = 0; i < rows.length; i++) {
    const line = i + 2;   // строка 1 — заголовки
    const { values, errors } = normalizeRow(DRIVER_COLUMNS, rows[i]);

    if (errors.length) {
      result.errors.push({ line, name: rows[i].name || '', messages: errors });
      result.skipped++;
      continue;
    }

    // Привязка автомобиля по госномеру
    let assignedVehicle = null;
    if (values.assigned_plate) {
      const key = values.assigned_plate.toUpperCase().replace(/\s/g, '');
      assignedVehicle = plateMap.get(key) || null;
      if (!assignedVehicle) {
        result.errors.push({
          line, name: values.name,
          messages: [`Автомобиль «${values.assigned_plate}» не найден — водитель загружен без машины`],
        });
      }
    }

    try {
      // Ищем существующего: сначала по телефону, затем по почте, затем по ФИО
      let existing = null;
      if (values.phone) {
        const r = await db.query(
          `SELECT id FROM users WHERE company_id = $1
             AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')
             AND regexp_replace($2, '\\D', '', 'g') <> '' LIMIT 1`,
          [companyId, values.phone]
        );
        existing = r.rows[0] || null;
      }
      if (!existing && values.email) {
        const r = await db.query(
          'SELECT id FROM users WHERE company_id = $1 AND LOWER(email) = $2 LIMIT 1',
          [companyId, values.email]
        );
        existing = r.rows[0] || null;
      }
      if (!existing) {
        const r = await db.query(
          'SELECT id FROM users WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
          [companyId, values.name]
        );
        existing = r.rows[0] || null;
      }

      const fields = {
        name:              values.name,
        phone:             values.phone,
        email:             values.email,
        telegram_username: values.telegram,
        max_username:      values.max,
        status:            values.status,
        license_number:    values.license_number,
        license_category:  values.license_category,
        license_expires:   values.license_expires,
        medical_expires:   values.medical_expires,
        briefing_date:     values.briefing_date,
        has_tachograph:    values.has_tachograph,
        has_waybill:       values.has_waybill,
        fuel_card:         values.fuel_card,
        assigned_vehicle:  assignedVehicle,
      };

      // При обновлении не затираем заполненное поле пустой ячейкой
      const keys = Object.keys(fields).filter(k =>
        !existing || fields[k] !== null || k === 'has_tachograph' || k === 'has_waybill'
      );

      if (existing) {
        const sets = keys.map((k, idx) => `${k} = $${idx + 1}`).join(', ');
        await db.query(
          `UPDATE users SET ${sets} WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}`,
          [...keys.map(k => fields[k]), existing.id, companyId]
        );
        result.updated++;
      } else {
        const initials = String(values.name).trim().split(/\s+/)
          .map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
        const palette = ['#3b82f6', '#a855f7', '#22c55e', '#f97316', '#ef4444', '#10b981'];
        const color = palette[Math.floor(Math.random() * palette.length)];

        await db.query(
          `INSERT INTO users (company_id, initials, color, ${keys.join(', ')})
           VALUES ($1, $2, $3, ${keys.map((_, idx) => `$${idx + 4}`).join(', ')})`,
          [companyId, initials, color, ...keys.map(k => fields[k])]
        );
        result.created++;
      }
    } catch (err) {
      console.error('[import] driver row error:', err.message);
      result.errors.push({ line, name: values.name, messages: ['Ошибка сохранения: ' + err.message] });
      result.skipped++;
    }
  }

  return result;
}

// ─── Загрузка автомобилей ──────────────────────────────────────────────────

async function importVehicles(companyId, rows) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  const { rows: drivers } = await db.query(
    'SELECT id, phone FROM users WHERE company_id = $1', [companyId]
  );
  const phoneMap = new Map(
    drivers.filter(d => d.phone)
      .map(d => [String(d.phone).replace(/\D/g, ''), d.id])
  );

  for (let i = 0; i < rows.length; i++) {
    const line = i + 2;
    const { values, errors } = normalizeRow(VEHICLE_COLUMNS, rows[i]);

    if (errors.length) {
      result.errors.push({ line, name: rows[i].plate || '', messages: errors });
      result.skipped++;
      continue;
    }

    let assignedUser = null;
    if (values.driver_phone) {
      const digits = String(values.driver_phone).replace(/\D/g, '');
      assignedUser = phoneMap.get(digits) || null;
      if (!assignedUser) {
        result.errors.push({
          line, name: values.plate,
          messages: [`Водитель с телефоном «${values.driver_phone}» не найден — машина загружена без водителя`],
        });
      }
    }

    try {
      const r = await db.query(
        `SELECT id FROM vehicles WHERE company_id = $1
           AND UPPER(REPLACE(plate, ' ', '')) = UPPER(REPLACE($2, ' ', '')) LIMIT 1`,
        [companyId, values.plate]
      );
      const existing = r.rows[0] || null;

      const fields = {
        plate:             values.plate,
        brand:             values.brand,
        model:             values.model,
        year:              values.year,
        type:              values.type,
        status:            values.status,
        vin:               values.vin,
        color:             values.color,
        mileage:           values.mileage,
        location:          values.location,
        insurance_until:   values.insurance_until,
        inspection_until:  values.inspection_until,
        next_service_date: values.next_service_date,
        next_service_km:   values.next_service_km,
        tires_change_date: values.tires_change_date,
        fuel_card_number:  values.fuel_card_number,
        insurance_policy:  values.insurance_policy,
        assigned_user_id:  assignedUser,
      };

      const keys = Object.keys(fields).filter(k => !existing || fields[k] !== null);

      if (existing) {
        const sets = keys.map((k, idx) => `${k} = $${idx + 1}`).join(', ');
        await db.query(
          `UPDATE vehicles SET ${sets} WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}`,
          [...keys.map(k => fields[k]), existing.id, companyId]
        );
        result.updated++;
      } else {
        await db.query(
          `INSERT INTO vehicles (company_id, ${keys.join(', ')})
           VALUES ($1, ${keys.map((_, idx) => `$${idx + 2}`).join(', ')})`,
          [companyId, ...keys.map(k => fields[k])]
        );
        result.created++;
      }
    } catch (err) {
      console.error('[import] vehicle row error:', err.message);
      result.errors.push({ line, name: values.plate, messages: ['Ошибка сохранения: ' + err.message] });
      result.skipped++;
    }
  }

  return result;
}

// После массовой загрузки выравниваем связи водитель↔машина: в файле
// могли указать привязку только с одной стороны
async function syncAssignments(companyId) {
  try {
    await db.query(
      `UPDATE vehicles v SET assigned_user_id = u.id
       FROM users u
       WHERE u.company_id = $1 AND v.company_id = $1
         AND u.assigned_vehicle = v.id
         AND (v.assigned_user_id IS DISTINCT FROM u.id)`,
      [companyId]
    );
    await db.query(
      `UPDATE users u SET assigned_vehicle = v.id
       FROM vehicles v
       WHERE u.company_id = $1 AND v.company_id = $1
         AND v.assigned_user_id = u.id
         AND (u.assigned_vehicle IS DISTINCT FROM v.id)`,
      [companyId]
    );
  } catch (err) {
    console.error('[import] sync assignments error:', err.message);
  }
}

module.exports = { DRIVER_COLUMNS, VEHICLE_COLUMNS, importDrivers, importVehicles, syncAssignments };
