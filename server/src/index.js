// Reminder server: stores reminders and sends a push notification when each is due.
// One Durable Object holds every reminder and wakes itself up (an "alarm")
// exactly when the next one is due.
//
// A reminder has a list of upcoming times (the app works these out, so repeats
// follow the phone's own time zone) and an optional "nag" interval that keeps
// re-sending until the task is done or the next time comes round.

import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const MAX_ATTEMPTS = 5;
const MAX_TIMES = 100;
const MAX_NAGS = 12;

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
    // Columns added for repeats, nagging and notification links
    const columns = ctx.storage.sql.exec(`PRAGMA table_info(reminders)`).toArray().map((c) => c.name);
    const add = (name, type) => {
      if (!columns.includes(name)) ctx.storage.sql.exec(`ALTER TABLE reminders ADD COLUMN ${name} ${type}`);
    };
    add('times', `TEXT NOT NULL DEFAULT '[]'`);
    add('nag_every', 'INTEGER NOT NULL DEFAULT 0');
    add('nag_count', 'INTEGER NOT NULL DEFAULT 0');
    add('url', `TEXT NOT NULL DEFAULT ''`);
  }

  async schedule({ key, times, title, body, url, nagEvery, subscription }) {
    const [first, ...rest] = times;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO reminders (key, at, title, body, sub, attempts, times, nag_every, nag_count, url)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?)`,
      key, first, title, body, JSON.stringify(subscription), JSON.stringify(rest), nagEvery, url,
    );
    await this.updateAlarm();
  }

  async cancel(key) {
    this.ctx.storage.sql.exec(`DELETE FROM reminders WHERE key = ?`, key);
    await this.updateAlarm();
  }

  async alarm() {
    const now = Date.now();
    const due = this.ctx.storage.sql.exec(`SELECT * FROM reminders WHERE at <= ?`, now + 1000).toArray();
    for (const r of due) {
      const nagging = r.nag_count > 0;
      let res;
      try {
        res = await sendPush(
          JSON.parse(r.sub),
          { title: r.title, body: nagging ? `Still to do · ${r.body}`.replace(/ · $/, '') : r.body, tag: r.key, url: r.url },
          this.vapid(),
        );
      } catch (err) {
        console.error('push error', err);
      }
      const retry = !res || res.status === 429 || res.status >= 500;
      if (retry && r.attempts + 1 < MAX_ATTEMPTS) {
        this.ctx.storage.sql.exec(`UPDATE reminders SET at = ?, attempts = attempts + 1 WHERE key = ?`, now + 60_000, r.key);
        continue;
      }
      if (res && !res.ok) {
        console.error('push rejected', res.status, await res.text());
        // 404/410: the phone unsubscribed, so drop the reminder entirely
        if (res.status === 404 || res.status === 410) {
          this.ctx.storage.sql.exec(`DELETE FROM reminders WHERE key = ?`, r.key);
          continue;
        }
      }

      const times = JSON.parse(r.times).filter((t) => t > now);
      const nextNag = r.nag_every > 0 && r.nag_count < MAX_NAGS ? now + r.nag_every : null;
      if (nextNag && (!times.length || nextNag < times[0])) {
        this.ctx.storage.sql.exec(`UPDATE reminders SET at = ?, attempts = 0, nag_count = nag_count + 1 WHERE key = ?`, nextNag, r.key);
      } else if (times.length) {
        this.ctx.storage.sql.exec(
          `UPDATE reminders SET at = ?, times = ?, attempts = 0, nag_count = 0 WHERE key = ?`,
          times[0], JSON.stringify(times.slice(1)), r.key,
        );
      } else {
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
    try {
      const res = await sendPush(subscription, data, this.vapid());
      return { status: res.status, text: res.ok ? '' : await res.text() };
    } catch (err) {
      return { status: 502, text: String(err) };
    }
  }

  // For tests: what's stored for a key
  async inspect(key) {
    return this.ctx.storage.sql.exec(`SELECT at, times, nag_every, nag_count, url FROM reminders WHERE key = ?`, key).toArray()[0] || null;
  }
}

async function reminderKey(endpoint, id) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}:${id}`;
}

function validSubscription(s, env) {
  const local = env.ALLOW_INSPECT === 'true' && s?.endpoint?.startsWith('http://localhost');
  return s && typeof s.endpoint === 'string' && (s.endpoint.startsWith('https://') || local) && s.keys?.p256dh && s.keys?.auth;
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
      const { id, title, body, url, subscription } = input;
      // `times` (list) is current; a single `at` is still accepted from older app versions
      const times = (Array.isArray(input.times) ? input.times : [input.at])
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b)
        .slice(0, MAX_TIMES);
      if (!id || !times.length || !validSubscription(subscription, env)) return json({ error: 'bad request' }, 400);
      const nagMinutes = Math.min(Math.max(Number(input.nag) || 0, 0), 24 * 60);
      await scheduler.schedule({
        key: await reminderKey(subscription.endpoint, String(id)),
        times,
        title: String(title || 'Reminder').slice(0, 120),
        body: String(body || '').slice(0, 500),
        url: typeof url === 'string' ? url.slice(0, 500) : '',
        nagEvery: nagMinutes * 60_000,
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
      if (!validSubscription(input.subscription, env)) return json({ error: 'bad request' }, 400);
      const result = await scheduler.sendNow(input.subscription, {
        title: 'Notifications are working ✅',
        body: 'You will get reminders like this one.',
        tag: 'test',
      });
      return json(result, result.status < 300 ? 200 : 502);
    }

    if (pathname === '/inspect' && env.ALLOW_INSPECT === 'true') {
      const { id, endpoint } = input;
      return json(await scheduler.inspect(await reminderKey(endpoint, String(id))));
    }

    return json({ error: 'not found' }, 404);
  },
};
