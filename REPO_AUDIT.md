# Repository Audit Snapshot

Generated: 2026-08-17T14:30:51

Repository: `fleetdesk-bot`
Files scanned: **21**
Approx. code lines: **2,316**

## 1. Repository structure

```text
└── .env.example
└── api.js
└── bot-manager.js
└── bot.js
└── db.js
  └── 01-infra.sh
  └── 02-vm-setup.sh
  └── 03-deploy.sh
  └── 04-upload-crm.sh
  └── DEPLOY.md
  └── ecosystem.config.js
  └── nginx-domain.conf
└── index.html
└── notifier.js
└── package.json
└── push.sh
└── railway.toml
└── repo_audit.py
└── schema.js
└── schema.sql
└── ticket-types.js
```

## 2. Languages / file types

| Extension | Files |
|---|---|
| .js | 8 |
| .sh | 5 |
| .html | 1 |
| .sql | 1 |
| .toml | 1 |
| .json | 1 |
| .py | 1 |
| .example | 1 |
| .conf | 1 |
| .md | 1 |

## 3. Top-level module sizes

| Directory | Files | Code lines |
|---|---|---|
| (root) | 14 | 2279 |
| deploy | 7 | 37 |

## 4. Largest source files

| Lines | File |
|---|---|
| 626 | api.js |
| 493 | repo_audit.py |
| 427 | bot.js |
| 241 | db.js |
| 203 | schema.js |
| 159 | bot-manager.js |
| 107 | notifier.js |
| 37 | deploy/ecosystem.config.js |
| 23 | ticket-types.js |

## 5. Possible application entry points

_No obvious entry points detected._

## 6. Tests

Detected test/spec files: **0**

_No test files detected._

## 7. Frequently imported modules/packages

| Module / package | Import occurrences |
|---|---|
| dotenv | 3 |
| express | 2 |
| pg | 1 |
| telegraf | 1 |
| pathlib | 1 |
| collections | 1 |
| datetime | 1 |
| os | 1 |
| re | 1 |
| subprocess | 1 |
| crypto | 1 |

## 8. Git change hotspots

Files changed most frequently in the last ~500 commits.

| Changes | File |
|---|---|
| bot.js | 7 |
| db.js | 5 |
| bot-manager.js | 5 |
| api.js | 4 |
| notifier.js | 3 |
| schema.js | 2 |
| .env.example | 2 |
| ticket-types.js | 1 |
| deploy/01-infra.sh | 1 |
| deploy/02-vm-setup.sh | 1 |
| deploy/03-deploy.sh | 1 |
| deploy/04-upload-crm.sh | 1 |
| deploy/DEPLOY.md | 1 |
| deploy/ecosystem.config.js | 1 |
| deploy/nginx-domain.conf | 1 |
| index.html | 1 |
| push.sh | 1 |
| schema.sql | 1 |
| package.json | 1 |
| railway.toml | 1 |

## 9. TODO / FIXME / HACK

| File | Line | Text |
|---|---|---|
| repo_audit.py | 422 | "## 9. TODO / FIXME / HACK", |

## 10. Potential secret locations

Secret VALUES are intentionally not included. Only file locations are listed.

- `db.js`
- `deploy/01-infra.sh`
- `deploy/04-upload-crm.sh`
- `repo_audit.py`

## 11. Environment files

- `.env.example`

## 12. Dependency / configuration files

### `package.json`

```text
{
  "name": "fleetdesk-telegram-bot",
  "version": "1.0.0",
  "description": "FleetDesk — Telegram бот для водителей корпоративного автопарка",
  "main": "bot-manager.js",
  "scripts": {
    "start":  "node bot-manager.js",
    "dev":    "nodemon bot-manager.js",
    "single": "node bot.js"
  },
  "dependencies": {
    "telegraf": "^4.16.3",
    "pg":       "^8.11.5",
    "dotenv":   "^16.4.5",
    "express":  "^4.19.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.4"
  }
}

```

### `.env.example`

```text
# PostgreSQL — Railway подставит DATABASE_URL автоматически
DATABASE_URL=postgresql://user:pass@host:5432/fleetdesk

# Токен единого Telegram-бота (один на все компании).
# Получить у @BotFather → /newbot. Настраивается один раз здесь,
# в CRM токен больше не вводится.
BOT_TOKEN=123456:ABCDEFghijklmnopqrstuvwxyz

# Секрет для API между CRM и ботом
NOTIFY_SECRET=your_secret_here

# Порт для Express HTTP API (по умолчанию 3001)
NOTIFY_PORT=3001

```

## 13. Git contributors

```text
9	Грубов Геннадий <grubovgennadij@MacBook-Pro-Grubov.local>
```

## 14. Next step

Use this snapshot together with direct repository access for a full architecture review.
The snapshot is intentionally diagnostic, not a substitute for reading the source code.
