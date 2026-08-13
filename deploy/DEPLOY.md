# FleetDesk — Деплой в Yandex Cloud

## Архитектура

```
Ваш домен
├── api.ВАШ_ДОМЕН  →  VM (Yandex Compute Cloud)
│                      ├── nginx (443/80)
│                      ├── bot-manager.js (PM2, порт 3001)
│                      └── PostgreSQL 16 (внутренний, порт 5432)
│
└── crm.ВАШ_ДОМЕН  →  Yandex Object Storage (статический HTML)
```

**Стоимость:** ~800–1200 ₽/мес (VM) + копейки за Object Storage

---

## Шаг 1 — Регистрация в Yandex Cloud

1. Перейдите на **https://cloud.yandex.ru**
2. Нажмите **Войти** → войдите через Яндекс аккаунт
3. Перейдите в **Консоль** → нажмите **Создать платёжный аккаунт**
4. Введите данные карты (новые аккаунты получают 4000 ₽ бонусов на 60 дней)

---

## Шаг 2 — Установка yc CLI и jq

```bash
# macOS
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
brew install jq

# Перезапустите терминал, затем:
yc init
# Следуйте инструкциям: войдите через браузер, выберите облако и папку
```

---

## Шаг 3 — SSH ключ

```bash
# Проверьте наличие ключа:
ls ~/.ssh/id_rsa.pub

# Если нет — создайте:
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""
```

---

## Шаг 4 — Создать инфраструктуру

```bash
cd ~/Desktop/fleetdesk-bot
chmod +x deploy/01-infra.sh
bash deploy/01-infra.sh
```

Скрипт создаст:
- Папку `fleetdesk` в Yandex Cloud
- Сеть и подсеть
- Статический внешний IP
- VM с Ubuntu 22.04 (2 CPU, 2 GB RAM, 20 GB SSD)
- Object Storage bucket для CRM

В конце вы увидите статический IP — **запишите его**.

---

## Шаг 5 — Настроить DNS (у вашего регистратора домена)

Добавьте две A/CNAME записи:

| Тип  | Хост       | Значение                                        |
|------|------------|-------------------------------------------------|
| A    | api        | `<СТАТИЧЕСКИЙ_IP из шага 4>`                   |
| CNAME| crm        | `<BUCKET_NAME>.website.yandexcloud.net`         |

> DNS распространяется 5–30 минут. Можно продолжить пока не распространится.

---

## Шаг 6 — Настроить VM

```bash
# Подключитесь к серверу:
ssh ubuntu@<СТАТИЧЕСКИЙ_IP>

# Запустите настройку (прямо на сервере):
bash <(curl -sL https://raw.githubusercontent.com/grubovmsc-cell/2/main/deploy/02-vm-setup.sh)
```

Скрипт установит Node.js 20, PostgreSQL 16, nginx, PM2, certbot.
В конце вы увидите DATABASE_URL — **скопируйте его**.

---

## Шаг 7 — Создать .env файл

```bash
# На вашем компьютере, в папке fleetdesk-bot:
cp .env.example .env
nano .env
```

Заполните `.env`:
```env
DATABASE_URL=postgresql://fleetdesk:<ПАРОЛЬ>@localhost:5432/fleetdesk
NOTIFY_SECRET=ваш_секретный_ключ_сюда
NOTIFY_PORT=3001
```

> DATABASE_URL взять из вывода шага 6.
> NOTIFY_SECRET — любая случайная строка, например: `openssl rand -hex 16`

---

## Шаг 8 — Задеплоить код

```bash
# На вашем компьютере:
cd ~/Desktop/fleetdesk-bot
chmod +x deploy/03-deploy.sh
bash deploy/03-deploy.sh <СТАТИЧЕСКИЙ_IP>
```

Код скопируется на сервер, зависимости установятся, бот запустится через PM2.

---

## Шаг 9 — SSL сертификат

```bash
# Подождите пока DNS распространится, затем:
ssh ubuntu@<СТАТИЧЕСКИЙ_IP>

# Получите сертификат (замените ВАШ_ДОМЕН):
sudo certbot --nginx -d api.ВАШ_ДОМЕН
```

Certbot автоматически настроит nginx на HTTPS.

```bash
# Скопируйте финальный nginx конфиг (замените YOUR_DOMAIN):
sudo nano /etc/nginx/sites-available/fleetdesk
# Вставьте содержимое deploy/nginx-domain.conf (заменив YOUR_DOMAIN)
sudo nginx -t && sudo nginx -s reload
```

---

## Шаг 10 — Загрузить CRM

```bash
# Установите AWS CLI (нужен для загрузки в Object Storage):
brew install awscli

# Загрузите CRM:
cd ~/Desktop/fleetdesk-bot
bash deploy/04-upload-crm.sh
```

---

## Шаг 11 — Подключить CRM к боту

1. Откройте `crm.ВАШ_ДОМЕН` в браузере
2. Войдите в CRM
3. Перейдите в **⚙️ Настройки**
4. Введите URL: `https://api.ВАШ_ДОМЕН`
5. Введите NOTIFY_SECRET (который в .env)
6. Нажмите **Проверить связь** — должно показать зелёный статус
7. Перейдите в **🤖 Telegram Bot**
8. Введите токен бота и нажмите **Подключить**

---

## Полезные команды

```bash
# Логи бота:
ssh ubuntu@<IP> 'pm2 logs fleetdesk-bot --lines 50'

# Перезапустить бота:
ssh ubuntu@<IP> 'pm2 restart fleetdesk-bot'

# Обновить код (после изменений):
bash deploy/03-deploy.sh <IP>

# Статус сервисов:
ssh ubuntu@<IP> 'pm2 status && sudo nginx -t'

# Обновить CRM:
bash deploy/04-upload-crm.sh
```

---

## Стоимость

| Сервис                          | Цена/мес     |
|---------------------------------|--------------|
| VM (standard-v3, 2 vCPU, 2 GB) | ~700–900 ₽  |
| SSD 20 GB                       | ~60 ₽       |
| Статический IP                  | ~140 ₽      |
| Object Storage (CRM HTML)       | < 1 ₽       |
| **Итого**                       | **~900–1100 ₽** |
