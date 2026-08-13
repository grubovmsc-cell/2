#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  FleetDesk — Yandex Cloud Infrastructure Setup
#  Запускать ЛОКАЛЬНО после установки yc CLI
#  Документация: https://cloud.yandex.ru/docs/cli/quickstart
# ═══════════════════════════════════════════════════════════

set -euo pipefail

# ── Настройки ──────────────────────────────────────────────
FOLDER_NAME="fleetdesk"
ZONE="ru-central1-a"
VM_NAME="fleetdesk-server"
SUBNET_RANGE="192.168.10.0/24"
DISK_SIZE=20   # GB
SSH_KEY="${HOME}/.ssh/id_rsa.pub"

# ── Цвета для вывода ───────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FleetDesk — Yandex Cloud Setup                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Проверки ───────────────────────────────────────────────
command -v yc &>/dev/null || error "yc CLI не установлен. Установите: curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash"
command -v jq &>/dev/null || error "jq не установлен. Установите: brew install jq"
[ -f "$SSH_KEY" ] || error "SSH ключ не найден: $SSH_KEY\nСоздайте: ssh-keygen -t rsa -b 4096"

# ── 1. Создать / получить Folder ───────────────────────────
info "Создаём папку '$FOLDER_NAME'..."
if yc resource-manager folder get --name "$FOLDER_NAME" &>/dev/null; then
  warn "Папка '$FOLDER_NAME' уже существует, используем её."
else
  yc resource-manager folder create --name "$FOLDER_NAME" --description "FleetDesk CRM + Bot"
fi
FOLDER_ID=$(yc resource-manager folder get --name "$FOLDER_NAME" --format json | jq -r '.id')
info "Folder ID: $FOLDER_ID"

# ── 2. Сеть и подсеть ─────────────────────────────────────
info "Создаём сеть fleetdesk-network..."
yc vpc network create \
  --name fleetdesk-network \
  --folder-id "$FOLDER_ID" 2>/dev/null || warn "Сеть уже существует"

info "Создаём подсеть в зоне $ZONE..."
yc vpc subnet create \
  --name fleetdesk-subnet \
  --network-name fleetdesk-network \
  --range "$SUBNET_RANGE" \
  --zone "$ZONE" \
  --folder-id "$FOLDER_ID" 2>/dev/null || warn "Подсеть уже существует"

# ── 3. Статический IP ─────────────────────────────────────
info "Выделяем статический IP адрес..."
yc vpc address create \
  --name fleetdesk-ip \
  --external-ipv4 zone="$ZONE" \
  --folder-id "$FOLDER_ID" 2>/dev/null || warn "IP уже выделен"
STATIC_IP=$(yc vpc address get --name fleetdesk-ip --folder-id "$FOLDER_ID" --format json | jq -r '.external_ipv4_address.address')
info "Статический IP: $STATIC_IP"

# ── 4. Группа безопасности ────────────────────────────────
info "Создаём группу безопасности..."
yc vpc security-group create \
  --name fleetdesk-sg \
  --network-name fleetdesk-network \
  --folder-id "$FOLDER_ID" \
  --rule "direction=ingress,protocol=tcp,port=22,v4-cidrs=[0.0.0.0/0]" \
  --rule "direction=ingress,protocol=tcp,port=80,v4-cidrs=[0.0.0.0/0]" \
  --rule "direction=ingress,protocol=tcp,port=443,v4-cidrs=[0.0.0.0/0]" \
  --rule "direction=egress,protocol=any,v4-cidrs=[0.0.0.0/0]" 2>/dev/null || warn "Группа безопасности уже существует"

# ── 5. Создать VM ─────────────────────────────────────────
info "Создаём VM '$VM_NAME' (Ubuntu 22.04, 2 CPU, 2 GB RAM)..."
yc compute instance create \
  --name "$VM_NAME" \
  --folder-id "$FOLDER_ID" \
  --zone "$ZONE" \
  --cores 2 \
  --memory 2 \
  --core-fraction 100 \
  --platform-id standard-v3 \
  --create-boot-disk image-folder-id=standard-images,image-family=ubuntu-2204-lts,size=${DISK_SIZE},type=network-ssd \
  --network-interface "subnet-name=fleetdesk-subnet,nat-address=$STATIC_IP,security-group-name=fleetdesk-sg" \
  --ssh-key "$SSH_KEY" \
  --metadata-from-file user-data=/dev/stdin <<EOF
#cloud-config
users:
  - default
  - name: fleetdesk
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh-authorized-keys:
      - $(cat "$SSH_KEY")
EOF

info "VM создана!"

# ── 6. Object Storage bucket для CRM ──────────────────────
BUCKET_NAME="fleetdesk-crm-${FOLDER_ID:0:8}"
info "Создаём Object Storage bucket '$BUCKET_NAME'..."

# Создаём сервисный аккаунт для Object Storage
yc iam service-account create \
  --name fleetdesk-storage-sa \
  --folder-id "$FOLDER_ID" 2>/dev/null || true

SA_ID=$(yc iam service-account get --name fleetdesk-storage-sa --folder-id "$FOLDER_ID" --format json | jq -r '.id')

# Выдаём роль editor на папку
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role storage.editor \
  --subject "serviceAccount:$SA_ID" 2>/dev/null || true

# Создаём статический ключ для доступа к Object Storage
info "Создаём ключ доступа к Object Storage..."
KEY_JSON=$(yc iam access-key create --service-account-id "$SA_ID" --format json)
ACCESS_KEY=$(echo "$KEY_JSON" | jq -r '.access_key.key_id')
SECRET_KEY=$(echo "$KEY_JSON" | jq -r '.secret')

# Создаём bucket через AWS CLI (Yandex Cloud совместим с S3 API)
if command -v aws &>/dev/null; then
  AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
  aws s3 mb "s3://$BUCKET_NAME" \
    --endpoint-url https://storage.yandexcloud.net \
    --region ru-central1

  # Включаем статический хостинг
  AWS_ACCESS_KEY_ID="$ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$SECRET_KEY" \
  aws s3 website "s3://$BUCKET_NAME" \
    --endpoint-url https://storage.yandexcloud.net \
    --region ru-central1 \
    --index-document index.html

  info "Bucket создан: $BUCKET_NAME"
else
  warn "AWS CLI не установлен — bucket создайте вручную в консоли Yandex Cloud"
  warn "https://console.cloud.yandex.ru/folders/$FOLDER_ID/storage"
fi

# ── Итог ──────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  FleetDesk — Инфраструктура создана!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  📍 Статический IP:    $STATIC_IP"
echo "  📁 Folder ID:         $FOLDER_ID"
echo "  🗄  Bucket CRM:        $BUCKET_NAME"
echo "  🔑 Object Storage:"
echo "     Access Key:        $ACCESS_KEY"
echo "     Secret Key:        $SECRET_KEY"
echo ""
echo "  ⚡ Следующий шаг:"
echo "     1. Добавьте DNS-записи для вашего домена:"
echo "        api.ВАШИ_ДОМЕН.  A    $STATIC_IP"
echo "        crm.ВАШ_ДОМЕН.   CNAME $BUCKET_NAME.website.yandexcloud.net"
echo ""
echo "     2. Подключитесь к серверу и настройте его:"
echo "        ssh ubuntu@$STATIC_IP"
echo "        bash <(curl -sL https://raw.githubusercontent.com/grubovmsc-cell/2/main/deploy/02-vm-setup.sh)"
echo ""
echo "  ⚠️  Сохраните Access Key и Secret Key — они показаны только раз!"
echo ""

# Сохраняем конфиг для следующих шагов
cat > "$(dirname "$0")/.yc-config" <<CONF
STATIC_IP=$STATIC_IP
FOLDER_ID=$FOLDER_ID
BUCKET_NAME=$BUCKET_NAME
ACCESS_KEY=$ACCESS_KEY
SECRET_KEY=$SECRET_KEY
VM_NAME=$VM_NAME
CONF

info "Конфиг сохранён в deploy/.yc-config"
