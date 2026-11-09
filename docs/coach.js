// AI coach and voice input, both powered by the user's own Google Gemini key.
// The key stays on this phone; the app talks to Gemini directly.
(() => {
  const core = window.TodoCore;
  const x = window.TodoExtras;
  const { h, sheet, dayKey, today, atTime } = x;
  const KEY = 'todo.coach.v1';
  const API_KEY = 'todo.coach.key'; // kept out of backups
  const LAST_OPEN = 'todo.lastOpen';
  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const DAY = 86400000;
  const $ = (id) => document.getElementById(id);

  const defaults = {
    model: '',
    tone: 'brutal',
    about: '',
    morning: '08:00',
    askWhy: true,
    chat: [], // { role: 'user'|'model', text, at, hidden }
    morningText: '',
    morningMadeAt: 0,
    morningTarget: 0,
  };
  let coach = { ...defaults, ...core.read(KEY, {}) };
  const save = () => localStorage.setItem(KEY, JSON.stringify(coach));
  let apiKey = localStorage.getItem(API_KEY) || '';
  const ready = () => !!apiKey;

  // How long since the app was last opened (before this visit)
  const prevOpen = Number(localStorage.getItem(LAST_OPEN)) || 0;
  localStorage.setItem(LAST_OPEN, String(Date.now()));

  // =====================================================================
  // GEMINI
  // =====================================================================
  class AiError extends Error {}

  async function pickModel(key) {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(friendlyError(res.status, body));
    const usable = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini-/.test(n));
    const flash = usable.filter((n) => /flash/.test(n) && !/(lite|image|tts|audio|live|embed|thinking|exp|8b|learnlm)/.test(n));
    const version = (n) => Number((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const score = (n) => version(n) * 10 + (/preview/.test(n) ? 0 : 5) + (/latest/.test(n) ? 1 : 0);
    const best = (flash.length ? flash : usable).sort((a, b) => score(b) - score(a))[0];
    if (!best) throw new AiError('This key works, but no Gemini model is available to it.');
    return { best, all: usable };
  }

  function friendlyError(status, body) {
    const msg = body?.error?.message || '';
    if (status === 400 && /API key/i.test(msg)) return 'That Gemini key isn’t valid. Check it and paste it again.';
    if (status === 403) return 'This key isn’t allowed to use Gemini. Make a new key in Google AI Studio.';
    if (status === 429) return 'Gemini’s free limit is used up for now. Try again in a minute, or turn on billing in Google AI Studio.';
    if (status >= 500) return 'Gemini is having trouble right now. Try again shortly.';
    return msg || `Gemini said ${status}`;
  }

  async function gemini({ system, contents, json = false, maxTokens = 4096, temperature = 0.8 }) {
    if (!apiKey) throw new AiError('Add your Gemini key first.');
    if (!navigator.onLine) throw new AiError('You’re offline. Connect to the internet and try again.');
    if (!coach.model) {
      coach.model = (await pickModel(apiKey)).best;
      save();
    }
    const call = () => fetch(`${API}/models/${coach.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    let res = await call();
    // The saved model may have been retired: pick a fresh one and retry once
    if (res.status === 404) {
      coach.model = (await pickModel(apiKey)).best;
      save();
      res = await call();
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(friendlyError(res.status, body));
    const cand = body.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('').trim();
    if (!text) {
      if (cand?.finishReason === 'SAFETY' || body.promptFeedback?.blockReason) throw new AiError('Gemini declined to answer that one. Try wording it differently.');
      throw new AiError('Gemini sent back an empty answer. Try again.');
    }
    if (!json) return text;
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new AiError('Couldn’t read Gemini’s answer. Try again.');
    }
  }

  // =====================================================================
  // WHAT THE COACH SEES
  // =====================================================================
  const daysAgo = (ms) => Math.floor((today() - core.startOfDay(ms)) / DAY);
  const ago = (ms) => {
    const n = daysAgo(ms);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  };
  const PRIORITY = ['', 'low', 'medium', 'high'];
  const nowText = () => {
    const d = new Date();
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (local ISO ${core.toDateInput(d.getTime())}T${core.toTimeInput(d.getTime())})`;
  };

  function facts() {
    const tasks = core.tasks;
    const open = tasks.filter((t) => !t.done);
    const overdue = open.filter((t) => t.due != null && core.startOfDay(t.due) < today());
    const weekAgo = Date.now() - 7 * DAY;
    const done7 = tasks.filter((t) => t.done && t.doneAt >= weekAgo).length
      + tasks.reduce((n, t) => n + (t.completions || []).filter((c) => c >= weekAgo).length, 0);
    const postponed = open.reduce((n, t) => n + (t.postponed || 0), 0);
    return { open, overdue, done7, postponed };
  }

  function context() {
    const tasks = core.tasks;
    const listName = (id) => core.lists.find((l) => l.id === id)?.name;
    const { open, overdue, done7 } = facts();
    const lines = [`Now: ${nowText()}`];
    if (coach.about) lines.push(`About me and my big goals: ${coach.about}`);
    if (prevOpen && daysAgo(prevOpen) >= 1) lines.push(`Before today, I last opened this app ${ago(prevOpen)}.`);

    const describe = (t) => {
      const bits = [`"${t.text}"`];
      if (t.priority) bits.push(`${PRIORITY[t.priority]} priority`);
      if (t.list) bits.push(`list: ${listName(t.list)}`);
      bits.push(`created ${ago(t.createdAt)}`);
      if (t.due != null) {
        const d = daysAgo(t.due);
        bits.push(d > 0 ? `OVERDUE by ${d} day${d === 1 ? '' : 's'}` : `due ${core.fmtDue(t.due, t.allDay)}`);
      } else bits.push('no date');
      if (t.repeat) bits.push(`repeats (${window.Recur.describe(t.repeat)}), done ${(t.completions || []).filter((c) => c > Date.now() - 14 * DAY).length} times in last 14 days`);
      if (t.postponed) bits.push(`pushed back ${t.postponed}x`);
      if (t.snoozes) bits.push(`snoozed ${t.snoozes}x`);
      if (t.subtasks.length) bits.push(`steps ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}`);
      if (t.why) bits.push(`my reason: "${t.why}"`);
      return `- ${bits.join(' | ')}`;
    };
    const sorted = open.slice().sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
    lines.push('', `OPEN TASKS (${open.length}, ${overdue.length} overdue):`, ...sorted.slice(0, 45).map(describe));
    if (open.length > 45) lines.push(`…and ${open.length - 45} more`);

    const since = Date.now() - 14 * DAY;
    const done = tasks.filter((t) => t.done && t.doneAt >= since).sort((a, b) => b.doneAt - a.doneAt);
    lines.push('', `COMPLETED IN LAST 14 DAYS (${done.length}):`, ...done.slice(0, 30).map((t) => {
      const late = t.due != null ? daysAgo(t.due) - daysAgo(t.doneAt) : 0;
      return `- "${t.text}" done ${ago(t.doneAt)}${late > 0 ? `, ${late} day${late === 1 ? '' : 's'} late` : ''}${t.why ? ` | reason: "${t.why}"` : ''}`;
    }));
    const created = tasks.filter((t) => t.createdAt >= since).length;
    lines.push(`Created in last 14 days: ${created}. Completed in last 7 days (incl. repeats): ${done7}.`);

    const habits = core.read('todo.habits.v1', { habits: [], log: {} });
    if (habits.habits?.length) {
      lines.push('', 'HABITS (last 7 days):');
      for (const hb of habits.habits) {
        const log = habits.log?.[hb.id] || {};
        let doneDays = 0;
        let scheduled = 0;
        for (let i = 0; i < 7; i++) {
          const d = core.addDays(today(), -i);
          if (hb.days.includes(new Date(d).getDay())) scheduled++;
          if ((log[dayKey(d)] || 0) >= hb.goal) doneDays++;
        }
        lines.push(`- ${hb.name}: ${doneDays}/${scheduled} scheduled days done`);
      }
    }
    const focus = core.read('todo.focus.v1', { sessions: [] });
    const week = (focus.sessions || []).filter((s) => s.end >= Date.now() - 7 * DAY);
    lines.push('', `FOCUS TIMER: ${week.reduce((n, s) => n + s.minutes, 0)} minutes over the last 7 days (${week.length} sessions).`);
    const steps = core.read('todo.steps.v1', null);
    if (steps && (steps.key || steps.manual?.length)) {
      const total = (d) => (steps.health?.[dayKey(d)] || 0) + (steps.manual || []).filter((m) => m.day === dayKey(d)).reduce((n, m) => n + m.steps, 0);
      const days = Array.from({ length: 7 }, (_, i) => total(core.addDays(today(), -i)));
      lines.push(`STEPS: today ${days[0]}, 7-day average ${Math.round(days.reduce((a, b) => a + b, 0) / 7)}, goal ${steps.goal}.`);
    }
    return lines.join('\n');
  }

  const TONES = {
    gentle: 'Tone: warm and encouraging, but still honest. Praise real progress, name the problem kindly, keep them moving.',
    direct: 'Tone: firm and no-nonsense, like a good sports coach. No fluff, no sugar-coating, but not harsh.',
    brutal: 'Tone: BRUTALLY honest, like a tough drill-sergeant mentor who wants them to win. Short, punchy sentences. Do not soften anything. Call out avoidance bluntly with the evidence (e.g. "You said this would get you your first client. 9 days overdue. Pushed back 4 times. Nothing."). Make them feel the cost of carrying on like this: what it means for the goals they wrote down and for their life if this becomes their pattern. Then demand action now.',
  };

  function coachSystem() {
    return [
      'You are the user’s personal accountability mentor inside their to-do app. Below is their real data. Talk to them directly as "you".',
      TONES[coach.tone] || TONES.brutal,
      'Rules:',
      '- Be specific. Name tasks, days overdue, how often they pushed things back, and quote their own reasons back at them.',
      '- Spot patterns: doing easy tasks while avoiding the important ones, creating tasks and not finishing them, piles of overdue work, not opening the app, broken habits.',
      '- If they are genuinely doing well, say so plainly, then raise the bar.',
      '- Attack the behaviour and the excuses, never their worth, looks or intelligence. No slurs. No made-up facts: only use the data below.',
      '- No therapy-speak, no generic motivational quotes, no lists of tips.',
      '- If they say anything suggesting they are in crisis or might harm themselves, drop the tough act completely, respond with care, and encourage them to reach out to someone they trust or a local helpline.',
      '- Plain text. You may use **bold** for a task name. Keep verdicts under 150 words. Chat replies can be shorter.',
      '- End verdicts with a line starting "Do this now:" naming one task and the first small step they can start in the next 10 minutes.',
      '',
      'THEIR DATA:',
      context(),
    ].join('\n');
  }

  // =====================================================================
  // COACH CONVERSATION
  // =====================================================================
  let busy = false;
  let lastError = '';

  async function ask(text, { hidden = false } = {}) {
    if (busy) return;
    busy = true;
    lastError = '';
    coach.chat.push({ role: 'user', text, at: Date.now(), hidden });
    save();
    render();
    try {
      const recent = coach.chat.slice(-16);
      const contents = recent.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
      const reply = await gemini({ system: coachSystem(), contents });
      coach.chat.push({ role: 'model', text: reply, at: Date.now() });
      coach.chat = coach.chat.slice(-60);
      save();
      core.haptic();
    } catch (err) {
      lastError = err instanceof AiError ? err.message : 'Couldn’t reach Gemini. Check your connection and try again.';
      // Drop the unanswered question so it can be asked again
      coach.chat.pop();
      save();
      if (!hidden) composerDraft = text;
    } finally {
      busy = false;
      render();
    }
  }

  const VERDICT = 'Give me your honest verdict on how I am doing right now, based on my data.';
  const CHIPS = [
    ['New verdict', VERDICT, true],
    ['What do I do right now?', 'What exactly should I do right now? Pick one task and tell me how to start.'],
    ['Break down my hardest task', 'Pick the task I am avoiding most and break it into 3-5 tiny first steps I can start today.'],
    ['Plan my day', 'Plan the rest of my day from my open tasks. Be realistic, in order, with rough times.'],
  ];

  // Escape, then allow **bold** and paragraphs
  function rich(text) {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^\s*[*-] /gm, '• ')
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  let composerDraft = '';

  function render() {
    const page = $('page-coach');
    if (!page || page.hidden) return;
    if (!ready()) {
      page.replaceChildren(setupView());
      return;
    }
    const { open, overdue, done7, postponed } = facts();
    const stat = (v, l, warn) => h('div', { class: 'stat' + (warn ? ' warn' : '') }, h('b', {}, String(v)), h('span', {}, l));
    const stats = h('div', { class: 'stats coach-stats' },
      stat(open.length, 'open'),
      stat(overdue.length, 'overdue', overdue.length > 0),
      stat(done7, 'done in 7 days'),
      stat(postponed, 'pushed back', postponed > 2));

    const toneSeg = h('div', { class: 'segmented coach-tone', role: 'radiogroup', 'aria-label': 'Coach tone' },
      ...[['gentle', 'Gentle'], ['direct', 'Direct'], ['brutal', 'Brutal']].map(([t, label]) => h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(coach.tone === t),
        class: coach.tone === t ? 'on' : '',
        onclick: () => {
          coach.tone = t;
          coach.morningMadeAt = 0; // remake the morning message in the new tone
          save();
          render();
        },
      }, label)));
    const head = h('div', { class: 'coach-head' }, toneSeg,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Coach settings', onclick: settingsSheet, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17v2h6v-2H3ZM3 5v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6-4h2V7h4V5h-4V3h-2v6Z"/></svg>' }));

    const thread = h('div', { class: 'coach-thread', 'aria-live': 'polite' });
    const visible = coach.chat.filter((m) => !m.hidden);
    if (!visible.length && !busy) {
      thread.append(h('div', { class: 'coach-empty' },
        h('p', {}, h('b', {}, 'Ready when you are.'), h('br'), 'Your coach reads your tasks, what you finished, what you keep pushing back and why you said each one matters.'),
        h('button', { type: 'button', class: 'big-btn coach-go', onclick: () => ask(VERDICT, { hidden: true }) }, 'Get my verdict')));
    }
    for (const m of visible) {
      thread.append(m.role === 'model'
        ? h('div', { class: 'msg coach' }, h('div', { class: 'msg-who' }, `Coach · ${core.fmtTime(m.at)}${daysAgo(m.at) ? `, ${ago(m.at)}` : ''}`), h('div', { class: 'msg-body', html: rich(m.text) }))
        : h('div', { class: 'msg me' }, m.text));
    }
    if (busy) thread.append(h('div', { class: 'msg coach typing', 'aria-label': 'Coach is thinking' }, h('i'), h('i'), h('i')));
    if (lastError) thread.append(h('p', { class: 'coach-error', role: 'alert' }, lastError));

    const chips = h('div', { class: 'chips' }, ...CHIPS.map(([label, prompt, hidden]) =>
      h('button', { type: 'button', class: 'chip', disabled: busy, onclick: () => ask(prompt, { hidden: !!hidden }) }, label)));

    const input = h('textarea', { class: 'coach-input', rows: '1', placeholder: 'Reply to your coach…', 'aria-label': 'Message your coach', maxlength: '1000' });
    input.value = composerDraft;
    const send = h('button', { type: 'submit', class: 'send-btn', 'aria-label': 'Send', disabled: busy, html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>' });
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    input.addEventListener('input', () => {
      composerDraft = input.value;
      grow();
    });
    const composer = h('form', {
      class: 'composer',
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || busy) return;
        composerDraft = '';
        ask(text);
      },
    }, input, send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        composer.requestSubmit();
      }
    });

    page.replaceChildren(h('div', { class: 'coach-page' }, head, stats, thread, chips, composer));
    grow();
    if (visible.length || busy) thread.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- first-time setup ----------
  function setupView() {
    const keyInput = h('input', { class: 'field-input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste your Gemini API key', 'aria-label': 'Gemini API key' });
    const msg = h('p', { class: 'hint', role: 'status' });
    let tone = coach.tone;
    const seg = h('div', { class: 'segmented coach-tone' },
      ...[['gentle', 'Gentle'], ['direct', 'Direct'], ['brutal', 'Brutal']].map(([t, label]) => h('button', {
        type: 'button',
        class: tone === t ? 'on' : '',
        onclick: (e) => {
          tone = t;
          for (const b of seg.children) b.classList.toggle('on', b === e.currentTarget);
        },
      }, label)));
    const saveBtn = h('button', {
      type: 'button',
      class: 'big-btn coach-go',
      onclick: async () => {
        const key = keyInput.value.trim();
        if (!key) {
          msg.textContent = 'Paste your key first.';
          return keyInput.focus();
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Checking key…';
        try {
          const { best } = await pickModel(key);
          apiKey = key;
          localStorage.setItem(API_KEY, key);
          coach.model = best;
          coach.tone = tone;
          save();
          core.toast('Coach is ready');
          render();
          syncAll(true);
        } catch (err) {
          msg.textContent = err instanceof AiError ? err.message : 'Couldn’t reach Google. Check your connection.';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save and start';
        }
      },
    }, 'Save and start');
    const step = (n, html) => h('li', {}, h('span', { class: 'st-num' }, String(n)), h('div', { html }));
    return h('div', { class: 'coach-page' },
      h('div', { class: 'coach-hero' },
        h('h2', {}, 'Your AI coach'),
        h('p', {}, 'It reads what you finish, what you keep pushing back and why each task matters to you, then tells you straight. It also turns your voice into tasks.')),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, 'Connect Google Gemini'),
        h('ol', { class: 'st-guide' },
          step(1, 'Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with Google.'),
          step(2, 'Tap <b>Create API key</b> and copy it.'),
          step(3, 'Paste it below.')),
        keyInput, msg),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, 'How hard should it push you?'),
        seg,
        h('p', { class: 'hint' }, 'Brutal calls out every excuse. You can change this any time.')),
      saveBtn,
      h('p', { class: 'hint center' }, 'Your key stays on this phone. Your task list is sent to Google Gemini each time the coach answers. On Gemini’s free tier, Google may use that data to improve its products; turning on billing in AI Studio stops that.'));
  }

  // ---------- settings ----------
  async function settingsSheet() {
    const about = h('textarea', { class: 'field-input', rows: '3', placeholder: 'e.g. I’m building a design business. I want 5 paying clients by March and to be fit enough to run 10 km.', 'aria-label': 'About you and your goals' });
    about.value = coach.about;
    const morning = h('input', { type: 'time', value: coach.morning || '' });
    const askWhy = h('input', { type: 'checkbox', checked: coach.askWhy });
    const model = h('select', {}, h('option', { value: coach.model }, coach.model || 'Automatic'));
    pickModel(apiKey).then(({ all }) => {
      model.replaceChildren(...all.map((n) => h('option', { value: n }, n)));
      model.value = coach.model;
    }).catch(() => {});
    const dialog = sheet('Coach settings', [
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, 'About you'),
        about,
        h('p', { class: 'hint' }, 'Your big goals. The coach holds every task up against them.')),
      h('div', { class: 'group' },
        h('label', { class: 'row' }, 'Morning message', morning),
        h('p', { class: 'hint' }, 'A daily notification from your coach. Leave empty to turn off. Needs reminders turned on.'),
        h('label', { class: 'check-row' }, askWhy, 'Ask “What do you want to achieve?” when I add a task')),
      h('div', { class: 'group' },
        h('label', { class: 'row' }, 'Gemini model', model),
        h('div', { class: 'btn-row' },
          h('button', {
            type: 'button',
            class: 'ghost-btn',
            onclick: () => {
              if (!confirm('Clear the whole conversation with your coach?')) return;
              coach.chat = [];
              save();
              render();
              dialog.close();
            },
          }, 'Clear chat'),
          h('button', {
            type: 'button',
            class: 'ghost-btn danger-text',
            onclick: () => {
              if (!confirm('Remove your Gemini key from this phone? The coach and voice input stop until you add one again.')) return;
              apiKey = '';
              localStorage.removeItem(API_KEY);
              coach.model = '';
              save();
              cancelMorning();
              dialog.close();
              render();
            },
          }, 'Remove key'))),
    ], {
      onSave: () => {
        coach.about = about.value.trim().slice(0, 1000);
        coach.morning = morning.value || '';
        coach.askWhy = askWhy.checked;
        if (model.value) coach.model = model.value;
        coach.morningMadeAt = 0;
        save();
        render();
        syncAll(true);
        return true;
      },
    });
  }

  // =====================================================================
  // MORNING NOTIFICATIONS
  // =====================================================================
  const morningItem = {
    get serverIds() { return coach.serverIds || []; },
    set serverIds(v) { coach.serverIds = v; },
  };

  function nextMorning() {
    if (!coach.morning) return null;
    let t = atTime(today(), coach.morning);
    if (t < Date.now() + 15 * 60000) t = atTime(core.addDays(today(), 1), coach.morning);
    return t;
  }

  // If the app isn't opened again, these go out on the following days
  function absentMessages(first) {
    const { open, overdue } = facts();
    const lines = {
      brutal: (n) => `${n} days without opening your list. ${open.length} tasks waiting, ${overdue.length} already overdue. Is this really how you want to live? Open it.`,
      direct: (n) => `${n} days since you checked your list. ${open.length} tasks are waiting. Open it and pick one.`,
      gentle: (n) => `It’s been ${n} days. ${open.length} tasks are waiting for you. Open the app and start with one small thing.`,
    };
    const line = lines[coach.tone] || lines.brutal;
    return [1, 2, 3].map((i) => ({
      id: `coach-${i}`,
      times: [core.addDays(first, i)],
      title: 'Coach',
      body: line(daysAgo(Date.now()) + i + 1),
      url: './?page=coach',
    }));
  }

  let morningBusy = false;
  async function syncMorning(force) {
    if (!ready() || !coach.morning || morningBusy) return;
    const target = nextMorning();
    // Remake the message at most every 6 hours, or when the target day changes
    const fresh = coach.morningTarget === target && Date.now() - coach.morningMadeAt < 6 * 3600000;
    if (fresh && !force && coach.synced) return;
    morningBusy = true;
    try {
      if (!fresh || !coach.morningText) {
        const when = new Date(target).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        coach.morningText = await gemini({
          system: coachSystem(),
          contents: [{ role: 'user', parts: [{ text: `Write the push notification I will read on ${when} at ${coach.morning}. Max 170 characters. Plain text, no quotation marks, no hashtags. Name the one task that matters most that day and push me to start it.` }] }],
          maxTokens: 2048,
        });
        coach.morningText = coach.morningText.replace(/\s+/g, ' ').slice(0, 220);
        coach.morningTarget = target;
        coach.morningMadeAt = Date.now();
        save();
      }
      await x.syncReminders(morningItem, [
        { id: 'coach-0', times: [target], title: 'Coach', body: coach.morningText, url: './?page=coach' },
        ...absentMessages(target),
      ]);
      coach.synced = morningItem.synced;
      save();
    } catch (err) {
      console.warn('Morning message not made', err);
    } finally {
      morningBusy = false;
    }
  }

  async function cancelMorning() {
    await x.syncReminders(morningItem, []);
    coach.morningText = '';
    coach.morningTarget = 0;
    save();
  }

  async function syncAll(force = false) {
    if (!ready()) return;
    if (!coach.morning) {
      if ((coach.serverIds || []).length) await cancelMorning();
      return;
    }
    await syncMorning(force);
  }

  // =====================================================================
  // "WHAT DO YOU WANT TO ACHIEVE?" after adding a task
  // =====================================================================
  let whyCard = null;
  function askWhy(task) {
    if (!ready() || !coach.askWhy || task.why) return;
    whyCard?.remove();
    const input = h('input', { class: 'field-input', placeholder: 'e.g. Get my first paying client', maxlength: '200', enterkeyhint: 'done', 'aria-label': 'What do you want to achieve with this task' });
    const close = () => {
      whyCard?.remove();
      whyCard = null;
    };
    whyCard = h('form', {
      class: 'why-card',
      onsubmit: (e) => {
        e.preventDefault();
        const why = input.value.trim();
        if (why) core.updateTask(task.id, (t) => (t.why = why));
        close();
        if (why) core.toast('Saved. Your coach will hold you to it.');
      },
    },
    h('p', {}, 'What do you want to achieve with ', h('b', {}, `“${task.text.slice(0, 60)}”`), '?'),
    input,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'ghost-btn', onclick: close }, 'Skip'),
      h('button', { type: 'submit', class: 'add-btn' }, 'Save')));
    $('add').after(whyCard);
  }
  document.addEventListener('todo:added', (e) => askWhy(e.detail));

  // =====================================================================
  // VOICE: speak, Gemini turns it into tasks, asks for a deadline if needed
  // =====================================================================
  const AUDIO_RATE = 16000;
  const MAX_SECONDS = 90;

  // Record from the mic until stop() is called
  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' }));
      };
    });
    rec.start(250);
    return { stop: () => rec.state !== 'inactive' && rec.stop(), done };
  }

  // Any recording → 16 kHz mono WAV, which Gemini always accepts
  async function toWavBase64(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    const length = Math.ceil(decoded.duration * AUDIO_RATE);
    const off = new OfflineAudioContext(1, length, AUDIO_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, AUDIO_RATE, true); v.setUint32(28, AUDIO_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), seconds: decoded.duration };
  }

  // A ready-made calendar so the AI never has to work out which date a weekday falls on
  function calendarText() {
    const rows = [];
    for (let i = 0; i < 21; i++) {
      const d = new Date(core.addDays(today(), i));
      const name = d.toLocaleDateString('en-GB', { weekday: 'long' });
      const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
      rows.push(`${name} ${core.toDateInput(d.getTime())}${label}`);
    }
    return rows.join('\n');
  }

  function voiceSystem() {
    const lists = core.lists.map((l) => l.name);
    return [
      'You turn what the user says into tasks for their to-do app. Understand casual, messy speech in any accent.',
      `Current local date and time: ${nowText()}.`,
      'Calendar for the next 3 weeks. ALWAYS take dates from this table, never calculate weekdays yourself:',
      calendarText(),
      'Weekday rules: "Monday", "on Monday", "this Monday" and "next Monday" all mean the first Monday AFTER today in the table. "Monday after next" means the second one. "This weekend" means the coming Saturday. "Next week" with no day means the coming Monday. Each task goes on the day they said for it; different tasks can have different days.',
      `GROUPS (their task lists): ${lists.length ? lists.join(', ') : 'none'}.`,
      'Put EVERY task in the group it fits best. Family = spouse, children, parents, relatives, home and household jobs, family events. Work = their job or business: clients, meetings, colleagues, reports, invoices, emails, projects. Personal goals = their own growth: health, fitness, steps, gym, learning, reading, study, faith, money and savings goals, habits, hobbies. If they say a group by name ("for work", "family stuff"), use it. Only leave it empty if it truly fits none.',
      'Return ONLY JSON in this shape:',
      '{"transcript": "what they said, cleaned up",',
      ' "tasks": [{"title": "short clear task title, max 80 chars, starts with a verb when natural",',
      '   "date": "YYYY-MM-DD or empty", "time": "HH:MM 24-hour or empty",',
      '   "repeat": "empty, or one of: every day | weekdays | every week | every 2 weeks | every month | every year | every mon and thu (any days) | every 3 days",',
      '   "list": "the group this task belongs to: exactly one of their existing groups (see GROUPS above), or a new short name only if they named a group that does not exist",',
      '   "priority": 0-3 (3 = urgent/important, 0 = not said),',
      '   "why": "what they want to achieve with it, if they said, else empty",',
      '   "steps": ["sub-steps if they listed parts of one task"],',
      '   "notes": "other useful detail, else empty"}],',
      ' "question": "if any task has no date, ONE short friendly question asking when they want to do it or what the deadline is, naming the task; else empty"}',
      'Rules: resolve relative dates (tomorrow, next Friday, end of the month, in 2 weeks) against the current date. "By Friday" means the deadline is Friday. A time with no date means today if still ahead, otherwise tomorrow. Split into separate tasks only when they are clearly different things. Never invent details they did not say. If the audio has no usable speech, return {"transcript": "", "tasks": [], "question": ""}.',
    ].join('\n');
  }

  function toFields(t) {
    const P = window.Parse;
    let due = null;
    let allDay = true;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) {
      const [y, m, d] = t.date.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      if (/^\d{1,2}:\d{2}$/.test(t.time || '')) {
        const [hh, mm] = t.time.split(':').map(Number);
        date.setHours(hh, mm, 0, 0);
        allDay = false;
      }
      due = date.getTime();
    }
    let repeat = null;
    if (t.repeat && P) {
      const parsed = P.parse(`x ${t.repeat}`, Date.now());
      if (parsed.repeat) {
        repeat = parsed.repeat;
        if (due == null) {
          due = parsed.due ?? today();
          allDay = parsed.due == null ? true : parsed.allDay;
        }
        if (repeat.days && window.Recur) due = window.Recur.firstOnOrAfter(repeat, due);
        repeat.anchor = due;
      }
    }
    return {
      text: String(t.title || '').trim().slice(0, 300),
      due,
      allDay,
      repeat,
      listName: String(t.list || '').trim().slice(0, 40) || null,
      priority: Math.max(0, Math.min(3, Number(t.priority) || 0)),
      why: String(t.why || '').trim().slice(0, 200),
      steps: (Array.isArray(t.steps) ? t.steps : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
      notes: String(t.notes || '').trim().slice(0, 1000),
      tags: [],
    };
  }

  // The voice sheet: record → review → (answer the deadline question) → add
  function voiceSheet() {
    if (!ready()) {
      core.toast('Add your Gemini key to use voice');
      x.showPage('coach');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      core.toast('Voice recording isn’t available here. Use the keyboard’s mic instead.');
      return;
    }
    let history = []; // Gemini conversation for follow-up answers
    let result = null; // { transcript, tasks: [fields], question }
    let recorder = null;
    let timer = null;
    let started = 0;

    const body = h('div', { class: 'voice' });
    const dialog = sheet('Speak your tasks', body, {});
    const ok = dialog.querySelector('.sheet-head button[type=submit]');
    ok.textContent = 'Close';
    dialog.addEventListener('close', () => {
      recorder?.stop();
      clearInterval(timer);
    });

    const micButton = (label, onTap, recording) => h('button', {
      type: 'button',
      class: 'voice-mic' + (recording ? ' rec' : ''),
      'aria-label': label,
      onclick: onTap,
      html: recording
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2Z"/></svg>',
    });

    function showIdle(hint) {
      body.replaceChildren(
        micButton('Start recording', () => record(false)),
        h('p', { class: 'voice-title' }, 'Tap and say what you need to do'),
        h('p', { class: 'hint center' }, hint || 'e.g. “Send the invoice to Tolu by Friday, call mum tomorrow evening, and gym every Monday and Thursday at 6.”'));
    }

    async function record(answering) {
      try {
        recorder = await startRecording();
      } catch {
        showIdle('Microphone access was blocked. Allow it in Settings → Safari → Microphone, or type instead.');
        return;
      }
      started = Date.now();
      const clock = h('p', { class: 'voice-clock', 'aria-live': 'off' }, '0:00');
      body.replaceChildren(
        micButton('Stop recording', () => recorder.stop(), true),
        h('p', { class: 'voice-title' }, answering ? 'Listening for your answer…' : 'Listening…'),
        clock,
        h('p', { class: 'hint center' }, 'Tap the square when you’re done.'));
      core.haptic();
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s >= MAX_SECONDS) recorder.stop();
      }, 250);
      const blob = await recorder.done;
      clearInterval(timer);
      recorder = null;
      if (!dialog.open) return;
      if (Date.now() - started < 700) {
        if (answering) showReview();
        else showIdle('That was too short. Tap the mic and speak.');
        return;
      }
      thinking(answering ? 'Updating your tasks…' : 'Working out your tasks…');
      try {
        const { b64 } = await toWavBase64(blob);
        const audio = { inlineData: { mimeType: 'audio/wav', data: b64 } };
        await analyze(answering
          ? { role: 'user', parts: [audio, { text: 'This is my answer to your question. Return the full updated JSON for all tasks.' }] }
          : { role: 'user', parts: [audio, { text: 'Turn this into tasks.' }] });
      } catch (err) {
        failed(err, answering);
      }
    }

    function thinking(text) {
      body.replaceChildren(h('div', { class: 'voice-wait' }, h('div', { class: 'msg coach typing' }, h('i'), h('i'), h('i')), h('p', { class: 'voice-title' }, text)));
    }

    function failed(err, answering) {
      const text = err instanceof AiError ? err.message : 'Couldn’t understand the recording. Try again.';
      if (answering && result) {
        showReview(text);
      } else showIdle(text);
    }

    async function analyze(userTurn) {
      history.push(userTurn);
      const out = await gemini({ system: voiceSystem(), contents: history, json: true, temperature: 0.2 });
      history.push({ role: 'model', parts: [{ text: JSON.stringify(out) }] });
      const tasks = (out.tasks || []).map(toFields).filter((t) => t.text);
      if (!tasks.length) {
        history = [];
        showIdle(out.transcript ? `I heard “${out.transcript}” but couldn’t find a task in it. Try again.` : 'I didn’t catch that. Tap the mic and try again.');
        return;
      }
      result = { transcript: out.transcript || '', tasks, question: tasks.some((t) => t.due == null) ? String(out.question || '') : '' };
      showReview();
    }

    async function answerText(text) {
      thinking('Updating your tasks…');
      try {
        await analyze({ role: 'user', parts: [{ text: `My answer: ${text}\nReturn the full updated JSON for all tasks.` }] });
      } catch (err) {
        failed(err, true);
      }
    }

    // Quick answers set the date on every undated task without another AI call
    function quickWhen(phrase) {
      const parsed = window.Parse.parse(`x ${phrase}`, Date.now());
      for (const t of result.tasks) {
        if (t.due != null || phrase === 'none') continue;
        t.due = parsed.due;
        t.allDay = parsed.allDay;
      }
      result.question = '';
      showReview();
    }

    // Set a date (and optional time) from the pickers on one task or every undated one
    function setWhen(targets, dateStr, timeStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
      const [y, m, d] = dateStr.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const timed = /^\d{1,2}:\d{2}$/.test(timeStr || '');
      if (timed) {
        const [hh, mm] = timeStr.split(':').map(Number);
        date.setHours(hh, mm, 0, 0);
      }
      for (const t of targets) {
        t.due = date.getTime();
        t.allDay = !timed;
        if (t.repeat) t.repeat.anchor = t.due;
      }
      return true;
    }

    function pickerRow(t, onSet) {
      const dateIn = h('input', { type: 'date', class: 'field-input', min: core.toDateInput(today()), value: t && t.due != null ? core.toDateInput(t.due) : '', 'aria-label': 'Date' });
      const timeIn = h('input', { type: 'time', class: 'field-input', value: t && t.due != null && !t.allDay ? core.toTimeInput(t.due) : '', 'aria-label': 'Time (optional)' });
      const setBtn = h('button', {
        type: 'button',
        class: 'chip on',
        onclick: () => {
          if (!dateIn.value) {
            dateIn.focus();
            dateIn.showPicker?.();
            return;
          }
          onSet(dateIn.value, timeIn.value);
        },
      }, 'Set');
      return h('div', { class: 'voice-pick' },
        h('label', {}, h('span', {}, 'Date'), dateIn),
        h('label', {}, h('span', {}, 'Time (optional)'), timeIn),
        setBtn);
    }

    let editing = -1; // which task card has its date picker open

    // Which group (Family, Work, ...) a task goes in; tap to change
    function groupPicker(t) {
      const known = core.lists.find((l) => l.name.toLowerCase() === (t.listName || '').toLowerCase());
      const sel = h('select', {
        class: 'pill pill-select' + (t.listName ? '' : ' muted'),
        'aria-label': `Group for ${t.text}`,
        onchange: (e) => {
          t.listName = e.target.value || null;
          showReview();
        },
      },
      h('option', { value: '' }, 'No group'),
      ...core.lists.map((l) => h('option', { value: l.name }, core.listLabel(l))),
      t.listName && !known ? h('option', { value: t.listName }, `${t.listName} (new)`) : null);
      sel.value = known ? known.name : t.listName || '';
      return sel;
    }

    function whenText(t) {
      if (t.due == null) return 'No date';
      const d = new Date(t.due);
      const days = Math.round((core.startOfDay(t.due) - today()) / DAY);
      const rel = days === 0 ? 'Today, ' : days === 1 ? 'Tomorrow, ' : '';
      let s = rel + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      if (!t.allDay) s += ` · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      return t.repeat ? `${s} · ${window.Recur.describe(t.repeat)}` : s;
    }

    function showReview(error) {
      const cards = result.tasks.map((t, i) => {
        const title = h('input', { class: 'voice-task-title', value: t.text, maxlength: '300', 'aria-label': 'Task title', oninput: (e) => (t.text = e.target.value) });
        const pills = [whenText(t)];
        if (t.priority) pills.push(['', 'Low', 'Medium', 'High'][t.priority]);
        if (t.steps.length) pills.push(`${t.steps.length} steps`);
        const why = h('input', { class: 'field-input voice-why', value: t.why, placeholder: 'What do you want to achieve with this?', maxlength: '200', oninput: (e) => (t.why = e.target.value) });
        return h('li', { class: 'voice-task' + (t.due == null ? ' undated' : '') },
          h('div', { class: 'voice-task-top' }, title,
            h('button', {
              type: 'button',
              class: 'del',
              'aria-label': `Remove ${t.text}`,
              onclick: () => {
                result.tasks.splice(i, 1);
                if (!result.tasks.length) {
                  history = [];
                  result = null;
                  showIdle();
                } else showReview();
              },
            }, '×')),
          h('div', { class: 'preview' },
            h('button', {
              type: 'button',
              class: 'pill pill-btn' + (t.due == null ? ' muted' : ''),
              'aria-expanded': String(editing === i),
              'aria-label': `Change date for ${t.text}: ${pills[0]}`,
              onclick: () => {
                editing = editing === i ? -1 : i;
                showReview();
              },
            }, `${pills[0]} ▾`),
            groupPicker(t),
            ...pills.slice(1).map((p) => h('span', { class: 'pill' }, p))),
          editing === i ? h('div', { class: 'voice-card-pick' },
            pickerRow(t, (date, time) => {
              setWhen([t], date, time);
              editing = -1;
              if (!result.tasks.some((x2) => x2.due == null)) result.question = '';
              showReview();
            }),
            t.due != null ? h('button', {
              type: 'button',
              class: 'link-btn',
              onclick: () => {
                t.due = null;
                t.allDay = true;
                editing = -1;
                showReview();
              },
            }, 'Remove date') : null) : null,
          t.steps.length ? h('ul', { class: 'voice-steps' }, ...t.steps.map((s) => h('li', {}, s))) : null,
          why);
      });

      const parts = [];
      if (result.transcript) parts.push(h('p', { class: 'voice-heard' }, h('span', {}, 'You said'), `“${result.transcript}”`));
      parts.push(h('ul', { class: 'voice-tasks' }, ...cards));

      if (result.question) {
        const input = h('input', { class: 'field-input', placeholder: 'Type an answer…', enterkeyhint: 'send', 'aria-label': 'Your answer' });
        parts.push(h('div', { class: 'voice-question' },
          h('p', {}, h('b', {}, result.question)),
          h('div', { class: 'chips' },
            ...[['Today', 'today 6pm'], ['Tonight', 'tonight'], ['Tomorrow', 'tomorrow 9am'], ['This weekend', 'saturday 10am'], ['Next week', 'next monday 9am'], ['No deadline', 'none']].map(([label, phrase]) =>
              h('button', { type: 'button', class: 'chip', onclick: () => quickWhen(phrase) }, label))),
          h('p', { class: 'voice-pick-head' }, 'Or pick a date'),
          pickerRow(null, (date, time) => {
            setWhen(result.tasks.filter((t) => t.due == null), date, time);
            result.question = '';
            showReview();
          }),
          h('form', {
            class: 'composer',
            onsubmit: (e) => {
              e.preventDefault();
              if (input.value.trim()) answerText(input.value.trim());
            },
          }, input,
          h('button', { type: 'button', class: 'send-btn mic', 'aria-label': 'Answer by voice', onclick: () => record(true), html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2Z"/></svg>' }))));
      }
      if (error) parts.push(h('p', { class: 'coach-error', role: 'alert' }, error));

      const n = result.tasks.length;
      parts.push(h('button', {
        type: 'button',
        class: 'big-btn coach-go',
        onclick: () => {
          const added = result.tasks.filter((t) => t.text.trim()).map((t) => core.addTask({ ...t, text: t.text.trim(), why: t.why.trim() }));
          core.tickSound();
          core.haptic();
          dialog.close();
          core.toast(added.length === 1 ? `Added “${added[0].text.slice(0, 40)}”` : `Added ${added.length} tasks`);
          if (x.page !== 'tasks') x.showPage('tasks');
        },
      }, n === 1 ? 'Add task' : `Add ${n} tasks`));
      parts.push(h('button', {
        type: 'button',
        class: 'link-btn st-reset',
        onclick: () => {
          history = [];
          result = null;
          record(false);
        },
      }, 'Start over'));
      body.replaceChildren(...parts);
    }

    showIdle();
    record(false);
  }

  $('voice-add').addEventListener('click', voiceSheet);
  $('open-coach').addEventListener('click', () => x.showPage('coach'));

  function reload() {
    coach = { ...defaults, ...core.read(KEY, {}) };
    coach.serverIds = [];
    coach.synced = false;
    save();
  }

  window.TodoCoach = { render, syncAll, reload };
  if (x.page === 'coach') render();
})();
