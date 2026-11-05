// Reminder server: stores reminders and sends a push notification when each is due.
// One Durable Object holds every reminder and wakes itself up (an "alarm")
// exactly when the next one is due.

import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const MAX_ATTEMPTS = 5;

export class Scheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS reminders (
      key TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sub TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )`);
  }

  async schedule({ key, at, title, body, subscription }) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO reminders (key, at, title, body, sub, attempts) VALUES (?, ?, ?, ?, ?, 0)`,
      key, at, title, body, JSON.stringify(subscription),
    );
    await this.updateAlarm();
  }

  async cancel(key) {
    this.ctx.storage.sql.exec(`DELETE FROM reminders WHERE key = ?`, key);
    await this.updateAlarm();
  }

  async alarm() {
    const due = this.ctx.storage.sql.exec(`SELECT * FROM reminders WHERE at <= ?`, Date.now() + 1000).toArray();
    for (const r of due) {
      let res;
      try {
        res = await sendPush(JSON.parse(r.sub), { title: r.title, body: r.body, tag: r.key }, this.vapid());
      } catch (err) {
        console.error('push error', err);
      }
      const retry = !res || res.status === 429 || res.status >= 500;
      if (retry && r.attempts + 1 < MAX_ATTEMPTS) {
        this.ctx.storage.sql.exec(
          `UPDATE reminders SET at = ?, attempts = attempts + 1 WHERE key = ?`,
          Date.now() + 60_000, r.key,
        );
      } else {
        if (res && !res.ok) console.error('push rejected', res.status, await res.text());
        this.ctx.storage.sql.exec(`DELETE FROM reminders WHERE key = ?`, r.key);
      }
    }
    await this.updateAlarm();
  }

  async updateAlarm() {
    const [next] = this.ctx.storage.sql.exec(`SELECT MIN(at) AS at FROM reminders`).toArray();
    if (next && next.at != null) await this.ctx.storage.setAlarm(Math.max(next.at, Date.now()));
    else await this.ctx.storage.deleteAlarm();
  }

  vapid() {
    return { privateJwk: this.env.VAPID_PRIVATE_KEY, subject: this.env.VAPID_SUBJECT };
  }

  async sendNow(subscription, data) {
    const res = await sendPush(subscription, data, this.vapid());
    return { status: res.status, text: res.ok ? '' : await res.text() };
  }
}

async function reminderKey(endpoint, id) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}:${id}`;
}

function validSubscription(s) {
  return s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.keys?.p256dh && s.keys?.auth;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/') return json({ ok: true, service: 'todo-reminders' });
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName('main'));

    if (pathname === '/schedule') {
      const { id, at, title, body, subscription } = input;
      if (!id || !Number.isFinite(at) || !validSubscription(subscription)) return json({ error: 'bad request' }, 400);
      await scheduler.schedule({
        key: await reminderKey(subscription.endpoint, String(id)),
        at,
        title: String(title || 'Reminder').slice(0, 120),
        body: String(body || '').slice(0, 500),
        subscription,
      });
      return json({ ok: true });
    }

    if (pathname === '/cancel') {
      const { id, endpoint } = input;
      if (!id || typeof endpoint !== 'string') return json({ error: 'bad request' }, 400);
      await scheduler.cancel(await reminderKey(endpoint, String(id)));
      return json({ ok: true });
    }

    if (pathname === '/test') {
      if (!validSubscription(input.subscription)) return json({ error: 'bad request' }, 400);
      const result = await scheduler.sendNow(input.subscription, {
        title: 'Notifications are working ✅',
        body: 'You will get reminders like this one.',
        tag: 'test',
      });
      return json(result, result.status < 300 ? 200 : 502);
    }

    return json({ error: 'not found' }, 404);
  },
};
