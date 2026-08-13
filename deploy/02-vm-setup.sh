#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  FleetDesk — VM Setup Script
#  Запускать НА СЕРВЕРЕ после ssh ubuntu@<IP>
#  Устанавливает: Node.js 20, PostgreSQL 16, nginx, PM2, certbot
# ═══════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
step()  { echo -e "\n${YELLOW}══ $1 ══${NC}"; }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FleetDesk — Server Bootstrap                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Обновление системы ─────────────────────────────────
step "1/7 Обновление системы"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get upgrade -y -qq
sudo apt-get install -y -qq curl git build-essential ufw software-properties-common

# ── 2. Node.js 20 ─────────────────────────────────────────
step "2/7 Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
info "Node.js $(node --version), npm $(npm --version)"

# PM2
sudo npm install -g pm2
info "PM2 установлен"

# ── 3. PostgreSQL 16 ──────────────────────────────────────
step "3/7 PostgreSQL 16"
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
info "PostgreSQL $(psql --version | awk '{print $3}')"

# Создаём БД и пользователя
DB_PASS=$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-20)
sudo -u postgres psql -c "CREATE USER fleetdesk WITH PASSWORD '$DB_PASS';" 2>/dev/null || \
  sudo -u postgres psql -c "ALTER USER fleetdesk WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "CREATE DATABASE fleetdesk OWNER fleetdesk;" 2>/dev/null || \
  warn "БД fleetdesk уже существует"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE fleetdesk TO fleetdesk;"
# Нужен gen_random_uuid()
sudo -u postgres psql -d fleetdesk -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>/dev/null || true

DATABASE_URL="postgresql://fleetdesk:${DB_PASS}@localhost:5432/fleetdesk"
info "БД создана. URL: $DATABASE_URL"

# ── 4. Папка приложения ───────────────────────────────────
step "4/7 Папка приложения"
sudo mkdir -p /opt/fleetdesk
sudo chown -R ubuntu:ubuntu /opt/fleetdesk
info "Папка: /opt/fleetdesk"

# ── 5. nginx ──────────────────────────────────────────────
step "5/7 nginx"
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx

# Базовый конфиг (будет заменён после настройки домена)
sudo tee /etc/nginx/sites-available/fleetdesk > /dev/null <<'NGINX'
server {
    listen 80 default_server;
    server_name _;

    location /health {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/fleetdesk /etc/nginx/sites-enabled/fleetdesk
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
info "nginx настроен"

# ── 6. Certbot (Let's Encrypt) ────────────────────────────
step "6/7 Certbot"
sudo apt-get install -y certbot python3-certbot-nginx
info "Certbot установлен (SSL настроим после привязки домена)"

# ── 7. Firewall ───────────────────────────────────────────
step "7/7 Firewall"
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
info "UFW настроен: 22, 80, 443"

# ── Сохраняем переменные ──────────────────────────────────
cat > /opt/fleetdesk/.env.template <<ENV
# База данных (уже настроена)
DATABASE_URL=$DATABASE_URL

# Секрет для API бот-менеджера (замените на свой)
NOTIFY_SECRET=changeme_$(openssl rand -hex 8)

# Порт HTTP API
NOTIFY_PORT=3001
ENV

info "Шаблон .env сохранён: /opt/fleetdesk/.env.template"

# ── Итог ──────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Сервер настроен!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  🔑 DATABASE_URL:"
echo "     $DATABASE_URL"
echo ""
echo "  ⚡ Следующие шаги (выполнить ЛОКАЛЬНО):"
echo ""
echo "  1. Скопировать код на сервер:"
echo "     cd ~/Desktop/fleetdesk-bot"
echo "     bash deploy/03-deploy.sh <ВАШ_IP>"
echo ""
echo "  2. Привязать SSL к домену:"
echo "     sudo certbot --nginx -d api.ВАШ_ДОМЕН"
echo ""
echo "  Сохраните DATABASE_URL — он нужен для .env"
echo ""
