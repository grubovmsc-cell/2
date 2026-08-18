// escalation.js — автоматическое повышение приоритета.
//
// Если по заявке нет движения дольше заданного времени, она становится
// срочной: диспетчер видит её красной, а водитель получает уведомление.
// Работает на сервере, поэтому не зависит от того, открыта ли CRM.
'use strict';
const db = require('./db');
const notifier = require('./notifier');

const STALE_HOURS   = parseInt(process.env.ESCALATE_AFTER_HOURS || '12', 10);
const CHECK_MINUTES = 30;

async function escalateStaleTickets() {
  try {
    // Движением считаем и смену статуса, и комментарий — поэтому смотрим
    // на updated_at, который триггер обновляет при любой правке
    const { rows } = await db.query(
      `UPDATE tickets SET priority = 'URGENT'
       WHERE status NOT IN ('DONE', 'CANCELLED')
         AND priority <> 'URGENT'
         AND updated_at < NOW() - INTERVAL '${STALE_HOURS} hours'
       RETURNING id, num, company_id, created_by, channel, title, type_key`
    );

    if (!rows.length) return;
    console.log(`[escalation] Повышен приоритет у заявок: ${rows.length}`);

    for (const t of rows) {
      if (!t.created_by) continue;
      const text =
        `🔥 *Заявка ${t.num} стала срочной*\n\n` +
        `По ней больше ${STALE_HOURS} часов нет движения.\n` +
        `${t.title || ''}\n\n` +
        `Диспетчер уведомлён.`;
      notifier.sendToUser(t.created_by, text, { prefer: t.channel })
        .catch(err => console.error('[escalation] notify error:', err.message));
    }
  } catch (err) {
    console.error('[escalation] error:', err.message);
  }
}

function startEscalation() {
  if (!STALE_HOURS) return;
  console.log(`[escalation] Проверка застоявшихся заявок каждые ${CHECK_MINUTES} мин (порог ${STALE_HOURS} ч)`);
  // Первый прогон — через минуту после старта, чтобы не мешать запуску
  setTimeout(escalateStaleTickets, 60000).unref?.();
  setInterval(escalateStaleTickets, CHECK_MINUTES * 60000).unref?.();
}

module.exports = { startEscalation, escalateStaleTickets, STALE_HOURS };
