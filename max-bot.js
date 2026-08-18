// max-bot.js — адаптер мессенджера MAX.
//
// Логика диалога та же, что в Telegram (conversation.js) — здесь только
// работа с HTTP API MAX: получение событий и отправка сообщений.
// Документация: https://dev.max.ru/docs-api
'use strict';
const fs    = require('fs');
const path  = require('path');
const tls   = require('tls');
const https = require('https');
const conversation = require('./conversation');

const API_BASE = process.env.MAX_API_BASE || 'https://platform-api2.max.ru';

// ─── Сертификаты ───────────────────────────────────────────────────────────
// API MAX работает по сертификату удостоверяющего центра Минцифры, которого
// нет в стандартном наборе Node. Кладём файлы .pem или .crt в папку certs/ —
// они добавятся к системным корневым сертификатам.
function buildAgent() {
  const dir = path.join(__dirname, 'certs');
  let extra = [];
  try {
    extra = fs.readdirSync(dir)
      .filter(f => /\.(pem|crt|cer)$/i.test(f))
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (_) { /* папки нет — работаем на системных сертификатах */ }

  if (extra.length) {
    console.log(`[max] Загружено дополнительных сертификатов: ${extra.length}`);
    return new https.Agent({ ca: [...tls.rootCertificates, ...extra], keepAlive: true });
  }
  return new https.Agent({ keepAlive: true });
}

const agent = buildAgent();

// Запрос через https напрямую — так можно передать свои сертификаты
function httpsRequest(url, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent, timeout: timeout || 60000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Превышено время ожидания ответа')); });
    if (body) req.write(body);
    req.end();
  });
}

// Сессии держим в памяти, как и в Telegram: при перезапуске водитель
// восстанавливается из базы по идентификатору аккаунта
const sessions = new Map();
const getSession = (userId) => {
  if (!sessions.has(userId)) sessions.set(userId, conversation.newSession());
  return sessions.get(userId);
};

class MaxBot {
  constructor(token) {
    this.token = token;
    this.marker = null;       // позиция в очереди событий
    this.running = false;
    this.info = null;
  }

  async request(method, endpoint, { query = {}, body } = {}) {
    const url = new URL(API_BASE + endpoint);
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    const payload = body ? JSON.stringify(body) : null;
    let res;
    try {
      res = await httpsRequest(url, {
        method,
        headers: {
          'Authorization': this.token,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        body: payload,
        // long polling ждёт события до 30 секунд — даём запас
        timeout: endpoint === '/updates' ? 60000 : 20000,
      });
    } catch (err) {
      const hint = err.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
        ? ' — нет доверия к сертификату MAX. Положите сертификаты Минцифры в папку certs/'
        : '';
      throw new Error(`${err.code || ''} ${err.message}${hint} (${url.host})`.trim());
    }

    let data = null;
    try { data = res.text ? JSON.parse(res.text) : null; } catch (_) {}

    if (res.status < 200 || res.status >= 300) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  getMe() { return this.request('GET', '/me'); }

  // ─── Отправка ────────────────────────────────────────────────────────────
  // В MAX нет постоянной клавиатуры внизу экрана, поэтому главное меню
  // показываем кнопками под сообщением
  async sendMessage(userId, text, { markdown, buttons, menu } = {}) {
    const attachments = [];

    let keyboard = buttons;
    if (!keyboard && menu) {
      keyboard = [];
      for (let i = 0; i < conversation.MENU.length; i += 2) {
        keyboard.push(conversation.MENU.slice(i, i + 2)
          .map(m => ({ text: m.text, data: `menu:${m.action}` })));
      }
    }

    if (keyboard && keyboard.length) {
      attachments.push({
        type: 'inline_keyboard',
        payload: {
          buttons: keyboard.map(row => row.map(b => b.url
            ? { type: 'link', text: b.text, url: b.url }
            : { type: 'callback', text: b.text, payload: b.data })),
        },
      });
    }

    const body = { text: text.slice(0, 4000) };
    if (markdown) body.format = 'markdown';
    if (attachments.length) body.attachments = attachments;

    return this.request('POST', '/messages', { query: { user_id: userId }, body });
  }

  // Ответ на нажатие кнопки: можно заменить текст исходного сообщения
  async answerCallback(callbackId, edited) {
    const body = {};
    if (edited) body.message = edited;
    return this.request('POST', '/answers', { query: { callback_id: callbackId }, body })
      .catch(err => console.error('[max] answer error:', err.message));
  }

  // ─── Обработка события ───────────────────────────────────────────────────
  async handleUpdate(update) {
    const type = update.update_type;

    if (type === 'bot_started' || type === 'message_created' || type === 'message_callback') {
      const isCallback = type === 'message_callback';
      const from = isCallback
        ? (update.callback && update.callback.user)
        : (update.message ? update.message.sender : update.user);
      if (!from || from.is_bot) return;

      const userId = from.user_id;
      const session = getSession(userId);

      const text = isCallback ? '' : (update.message?.body?.text || '');
      const isStart = type === 'bot_started' || /^\/start\b/.test(text);

      const input = {
        channel:   'max',
        userId,
        username:  from.username,
        firstName: from.name ? String(from.name).split(' ')[0] : null,
        text:      isStart ? '' : text,
        callback:  isCallback ? update.callback.payload : null,
        isStart,
        session,
      };

      if (isStart) sessions.set(userId, conversation.newSession());
      const replies = await conversation.handle({ ...input, session: getSession(userId) });

      // Первый ответ на callback отправляем как замену сообщения —
      // так диалог не засоряется дублями кнопок
      let answered = false;
      for (const r of replies) {
        if (isCallback && !answered && r.kind === 'edit') {
          await this.answerCallback(update.callback.callback_id, this.toMessageBody(r));
          answered = true;
          continue;
        }
        await this.sendMessage(userId, r.text, r).catch(err =>
          console.error('[max] send error:', err.message));
      }
      if (isCallback && !answered) await this.answerCallback(update.callback.callback_id);
      return;
    }

    // Пользователь остановил бота — забываем его сессию
    if (type === 'bot_stopped' && update.user) sessions.delete(update.user.user_id);
  }

  toMessageBody(r) {
    const body = { text: r.text.slice(0, 4000) };
    if (r.markdown) body.format = 'markdown';
    if (r.buttons && r.buttons.length) {
      body.attachments = [{
        type: 'inline_keyboard',
        payload: {
          buttons: r.buttons.map(row => row.map(b => b.url
            ? { type: 'link', text: b.text, url: b.url }
            : { type: 'callback', text: b.text, payload: b.data })),
        },
      }];
    }
    return body;
  }

  // ─── Получение событий ───────────────────────────────────────────────────
  // Long polling: для нашего объёма достаточно и не требует публичного
  // адреса с сертификатом, как webhook
  async poll() {
    while (this.running) {
      try {
        const res = await this.request('GET', '/updates', {
          query: { timeout: 30, limit: 50, marker: this.marker },
        });
        this.marker = res && res.marker != null ? res.marker : this.marker;

        for (const update of (res && res.updates) || []) {
          try {
            await this.handleUpdate(update);
          } catch (err) {
            console.error('[max] update error:', err.message);
          }
        }
      } catch (err) {
        console.error('[max] polling error:', err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async launch() {
    this.info = await this.getMe();
    this.running = true;
    this.poll();
    return this.info;
  }

  stop() { this.running = false; }
}

module.exports = { MaxBot };
