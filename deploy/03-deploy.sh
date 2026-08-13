#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  FleetDesk — Deploy Code to VM
#  Запускать ЛОКАЛЬНО из папки fleetdesk-bot/
#  Использование: bash deploy/03-deploy.sh <SERVER_IP>
# ═══════════════════════════════════════════════════════════

set -euo pipefail

SERVER_IP="${1:-}"
SSH_USER="ubuntu"
REMOTE_DIR="/opt/fleetdesk"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

[ -z "$SERVER_IP" ] && error "Укажите IP: bash deploy/03-deploy.sh <IP>"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FleetDesk — Deploying to $SERVER_IP             "
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Проверяем .env ────────────────────────────────────────
[ -f "$LOCAL_DIR/.env" ] || error ".env файл не найден в $LOCAL_DIR\nСоздайте из шаблона: cp .env.example .env && nano .env"

# ── Копируем файлы ────────────────────────────────────────
info "Копируем код на сервер..."
rsync -avz --progress \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='deploy/.yc-config' \
  --exclude='.env' \
  "$LOCAL_DIR/" \
  "${SSH_USER}@${SERVER_IP}:${REMOTE_DIR}/"

# Копируем .env отдельно (он не в git)
info "Копируем .env..."
scp "$LOCAL_DIR/.env" "${SSH_USER}@${SERVER_IP}:${REMOTE_DIR}/.env"

# ── Устанавливаем зависимости и запускаем ─────────────────
info "Устанавливаем зависимости и перезапускаем бот..."
ssh "${SSH_USER}@${SERVER_IP}" bash <<'REMOTE'
set -e
cd /opt/fleetdesk

# Создаём папку логов
sudo mkdir -p /var/log/fleetdesk
sudo chown ubuntu:ubuntu /var/log/fleetdesk

# npm install
npm install --omit=dev

# Копируем PM2 ecosystem конфиг
cp deploy/ecosystem.config.js /opt/fleetdesk/ecosystem.config.js

# Перезапускаем через PM2
if pm2 list | grep -q 'fleetdesk-bot'; then
  pm2 reload ecosystem.config.js --update-env
  echo "Бот перезапущен через PM2"
else
  pm2 start ecosystem.config.js
  pm2 save
  echo "Бот запущен впервые через PM2"
fi

# Настраиваем автозапуск при перезагрузке сервера
pm2 startup | grep 'sudo' | bash || true

echo ""
echo "Статус:"
pm2 status
REMOTE

info "Деплой завершён!"

# ── Проверяем health ──────────────────────────────────────
sleep 3
echo ""
info "Проверяем /health..."
HEALTH=$(curl -sf "http://${SERVER_IP}:3001/health" 2>/dev/null || echo "не доступен")
echo "  /health → $HEALTH"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Деплой завершён!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  🌐 Бот API: http://$SERVER_IP:3001"
echo "  📊 Логи:    ssh ubuntu@$SERVER_IP 'pm2 logs fleetdesk-bot'"
echo "  🔄 Рестарт: ssh ubuntu@$SERVER_IP 'pm2 restart fleetdesk-bot'"
echo ""
echo "  Если домен уже привязан, настройте SSL:"
echo "    ssh ubuntu@$SERVER_IP"
echo "    sudo certbot --nginx -d api.ВАШ_ДОМЕН"
echo ""
