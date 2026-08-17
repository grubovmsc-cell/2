// schema.js — создание и миграция схемы БД.
// Все ALTER-ы идемпотентны (IF NOT EXISTS), так что функцию
// безопасно вызывать при каждом старте сервера.
'use strict';
const db = require('./db');

async function addColumns(table, columns) {
  for (const [name, type] of Object.entries(columns)) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}

async function initSchema() {
  console.log('[schema] Initializing database schema...');

  // ── Компании ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT,
      bot_token  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // slug раньше был UNIQUE NOT NULL — для новых компаний он не нужен
  await db.query(`ALTER TABLE companies ALTER COLUMN slug DROP NOT NULL`).catch(() => {});

  // ── Аккаунты (вход в CRM) ───────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      initials      TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(LOWER(email))`);

  // ── Сессии (Bearer-токены) ──────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await addColumns('sessions', { last_used_at: 'TIMESTAMPTZ' });
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`);

  // ── Водители / сотрудники ───────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      role              TEXT NOT NULL DEFAULT 'EMPLOYEE',
      telegram_id       TEXT UNIQUE,
      telegram_username TEXT,
      license_number    TEXT,
      license_category  TEXT,
      license_expires   DATE,
      medical_expires   DATE,
      tachograph        TEXT,
      briefing_date     DATE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await addColumns('users', {
    initials:        'TEXT',
    color:           'TEXT',
    status:          "TEXT NOT NULL DEFAULT 'active'",
    medical_date:    'DATE',
    has_tachograph:  'BOOLEAN NOT NULL DEFAULT FALSE',
    has_waybill:     'BOOLEAN NOT NULL DEFAULT FALSE',
    fuel_card:       'TEXT',
    transponder:     'TEXT',
    assigned_vehicle:'UUID',
    driving_style:   'NUMERIC',
    fuel_per_100km:  'NUMERIC',
    fines_count:     'INTEGER NOT NULL DEFAULT 0',
    accidents_count: 'INTEGER NOT NULL DEFAULT 0',
  });
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_company  ON users(company_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_tg_username ON users(LOWER(telegram_username))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email))`);

  // ── Транспортные средства ───────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plate      TEXT NOT NULL,
      model      TEXT,
      brand      TEXT,
      year       SMALLINT,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await addColumns('vehicles', {
    color:              'TEXT',
    vin:                'TEXT',
    type:               "TEXT DEFAULT 'sedan'",
    length:             'INTEGER',
    width:              'INTEGER',
    height:             'INTEGER',
    max_mass:           'INTEGER',
    purchase_date:      'DATE',
    purchase_type:      'TEXT',
    lease_end:          'DATE',
    mileage:            'INTEGER',
    location:           'TEXT',
    next_service_km:    'INTEGER',
    next_service_date:  'DATE',
    insurance_until:    'DATE',
    inspection_until:   'DATE',
    tires_change_date:  'DATE',
    fuel_card_number:   'TEXT',
    fuel_card_code:     'TEXT',
    insurance_policy:   'TEXT',
    assigned_user_id:   'UUID',
    telematics:         'TEXT',
    tco_monthly:        'INTEGER',
    parking:            'TEXT',
    operation_mode:     'TEXT',
    availability_window:'TEXT',
    history:            "JSONB NOT NULL DEFAULT '[]'::jsonb",
  });
  await db.query(`CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id)`);

  // ── Подрядчики ──────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS contractors (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      phone      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await addColumns('contractors', {
    specializations: "JSONB NOT NULL DEFAULT '[]'::jsonb",
    contact_person:  'TEXT',
    email:           'TEXT',
    website:         'TEXT',
    address:         'TEXT',
    notes:           'TEXT',
    work_hours:      'TEXT',
  });
  await db.query(`CREATE INDEX IF NOT EXISTS idx_contractors_company ON contractors(company_id)`);

  // ── Заявки ──────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      num           TEXT NOT NULL,
      vehicle_id    UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'NEW',
      created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to   UUID REFERENCES users(id) ON DELETE SET NULL,
      contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await addColumns('tickets', {
    type_key: "TEXT NOT NULL DEFAULT 'other'",
    title:    'TEXT',
    priority: "TEXT NOT NULL DEFAULT 'MEDIUM'",
    due:      'DATE',
    comments: "JSONB NOT NULL DEFAULT '[]'::jsonb",
    history:  "JSONB NOT NULL DEFAULT '[]'::jsonb",
    closed_at:'TIMESTAMPTZ',
  });
  // created_by раньше был NOT NULL — заявку может создать диспетчер без привязки к водителю
  await db.query(`ALTER TABLE tickets ALTER COLUMN created_by DROP NOT NULL`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_company    ON tickets(company_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_contractor ON tickets(contractor_id)`);
  // Основная выборка — последние заявки компании
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_company_created ON tickets(company_id, created_at DESC)`);

  // ── Автообновление updated_at ───────────────────────────────
  await db.query(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `);
  await db.query(`DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets`);
  await db.query(`
    CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);

  console.log('[schema] ✅ Schema ready.');
}

module.exports = { initSchema };
