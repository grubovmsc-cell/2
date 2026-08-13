#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  FleetDesk — Upload CRM to Yandex Object Storage
#  Запускать ЛОКАЛЬНО
#  Требует: AWS CLI (brew install awscli)
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# Загружаем конфиг из предыдущего шага
CONFIG_FILE="$(dirname "$0")/.yc-config"
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"

BUCKET_NAME="${BUCKET_NAME:-}"
ACCESS_KEY="${ACCESS_KEY:-}"
SECRET_KEY="${SECRET_KEY:-}"
# Ищем CRM файл в нескольких местах
CRM_FILE="$(dirname "$0")/../fleetdesk_crm.html"
if [ ! -f "$CRM_FILE" ]; then
  CRM_FILE="$HOME/Downloads/fleetdesk_crm.html"
fi
if [ ! -f "$CRM_FILE" ]; then
  read -rp "Путь к fleetdesk_crm.html: " CRM_FILE
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

[ -z "$BUCKET_NAME" ] && read -rp "Bucket name: " BUCKET_NAME
[ -z "$ACCESS_KEY" ] && read -rp "Access Key: " ACCESS_KEY
[ -z "$SECRET_KEY" ] && { read -rsp "Secret Key: " SECRET_KEY; echo; }

[ -f "$CRM_FILE" ] || error "CRM файл не найден: $CRM_FILE"
command -v aws &>/dev/null || error "AWS CLI не установлен: brew install awscli"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FleetDesk — Загружаем CRM в Object Storage     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

YS3="--endpoint-url https://storage.yandexcloud.net --region ru-central1"

# Загружаем CRM как index.html
info "Загружаем fleetdesk_crm.html → index.html..."
AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
aws s3 cp "$CRM_FILE" "s3://$BUCKET_NAME/index.html" \
  $YS3 \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache, no-store, must-revalidate"

# Открываем публичный доступ
info "Настраиваем публичный доступ..."
AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
aws s3api put-bucket-acl \
  --bucket "$BUCKET_NAME" \
  --acl public-read \
  $YS3

AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
aws s3api put-object-acl \
  --bucket "$BUCKET_NAME" \
  --key index.html \
  --acl public-read \
  $YS3

info "CRM загружена!"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  CRM опубликована!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  🌐 Временный URL:"
echo "     https://$BUCKET_NAME.website.yandexcloud.net"
echo ""
echo "  Для своего домена добавьте CNAME запись:"
echo "     crm.ВАШ_ДОМЕН  CNAME  $BUCKET_NAME.website.yandexcloud.net"
echo ""
