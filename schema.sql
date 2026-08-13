-- FleetDesk — схема базы данных (совместима с bot.js / db.js)
-- Применить через Railway Dashboard: postgres → Data → Query

-- ── Компании ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  bot_token  TEXT,                        -- токен Telegram-бота
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Пользователи (водители, диспетчеры) ───────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  email              TEXT,
  phone              TEXT,
  role               TEXT NOT NULL DEFAULT 'EMPLOYEE',

  -- Telegram
  telegram_id        TEXT UNIQUE,
  telegram_username  TEXT,

  -- Водительские данные
  license_number     TEXT,
  license_category   TEXT,
  license_expires    DATE,
  medical_expires    DATE,
  tachograph         TEXT,
  briefing_date      DATE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_company    ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram   ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(LOWER(email));

-- ── Транспортные средства ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plate      TEXT NOT NULL,               -- гос. номер
  model      TEXT,
  brand      TEXT,
  year       SMALLINT,
  status     TEXT NOT NULL DEFAULT 'active',  -- active | decommissioned
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_company ON vehicles(company_id);

-- ── Типы заявок ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_types (
  id         SERIAL PRIMARY KEY,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = глобальный
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Базовые типы
INSERT INTO ticket_types (name, icon, sort_order) VALUES
  ('Поломка / Неисправность', '🔴', 1),
  ('Плановое ТО',              '🔧', 2),
  ('Шины / Резина',            '🛞', 3),
  ('Топливо',                  '⛽', 4),
  ('Документы',                '📄', 5),
  ('ДТП / Авария',             '🚨', 6),
  ('Мойка',                    '🚿', 7),
  ('Прочее',                   '❓', 8)
ON CONFLICT DO NOTHING;

-- ── Подрядчики ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contractors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Заявки ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  num           TEXT NOT NULL,            -- #1, #2, #3 ...
  type_id       INTEGER REFERENCES ticket_types(id),
  vehicle_id    UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'NEW',
  created_by    UUID NOT NULL REFERENCES users(id),
  assigned_to   UUID REFERENCES users(id),
  contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_company    ON tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);

-- ── Автообновление updated_at ──────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
