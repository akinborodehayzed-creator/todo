// Steps: today's count from Apple Health (sent by a Shortcut to the server),
// plus treadmill sessions and other steps you add by hand.
(() => {
  const core = window.TodoCore;
  const x = window.TodoExtras;
  const { h, sheet, plural, dayKey, today, atTime, fromDayKey, DAY_LETTERS } = x;
  const { serverUrl } = window.TODO_CONFIG;
  const KEY = 'todo.steps.v1';
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString();
  const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(Math.round(n)));

  const defaults = {
    goal: 10000,
    heightCm: 170,
    imperial: false,
    remind: '',
    key: '',
    health: {}, // 'YYYY-MM-DD' -> steps from Apple Health
    healthAt: 0, // time of the newest Health reading we have
    manual: [], // { id, day, at, steps, kind: 'treadmill'|'manual', minutes, speed, distanceKm }
  };
  let data = load();
  function load() {
    const d = { ...defaults, ...core.read(KEY, {}) };
    d.health = d.health || {};
    d.manual = d.manual || [];
    return d;
  }
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));

  // ---------- numbers ----------
  const healthOn = (day) => data.health[dayKey(day)] || 0;
  const manualOn = (day) => data.manual.filter((m) => m.day === dayKey(day));
  const totalOn = (day) => healthOn(day) + manualOn(day).reduce((n, m) => n + m.steps, 0);
  const metOn = (day) => totalOn(day) >= data.goal;

  // Walking stride is about 41.5% of height; it lengthens as you speed up into a run
  function strideM(speedKmh) {
    const factor = speedKmh == null || speedKmh < 7.5 ? 0.415 : Math.min(0.8, 0.475 + (speedKmh - 7.5) * 0.046);
    return (data.heightCm / 100) * factor;
  }
  const kmFor = (steps) => (steps * strideM()) / 1000;
  const fmtDistance = (km) => (data.imperial ? `${(km / 1.609).toFixed(1)} mi` : `${km.toFixed(1)} km`);

  function streak() {
    let d = today();
    if (!metOn(d)) d = core.addDays(d, -1);
    let n = 0;
    while (n < 3660 && metOn(d)) {
      n++;
      d = core.addDays(d, -1);
    }
    return n;
  }

  function bestStreak() {
    const days = new Set([...Object.keys(data.health), ...data.manual.map((m) => m.day)]);
    let best = 0;
    for (const k of days) {
      const d = fromDayKey(k);
      if (!metOn(d) || metOn(core.addDays(d, -1))) continue; // only count from the start of each run
      let n = 0;
      for (let e = d; metOn(e) && n < 3660; e = core.addDays(e, 1)) n++;
      best = Math.max(best, n);
    }
    return best;
  }

  // ---------- Apple Health, through the server ----------
  function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const shortcutLink = () => `${serverUrl}/steps/in?k=${data.key}&n=`;

  let fetching = null;
  let lastFetch = 0;
  async function fetchHealth(force = false) {
    if (!data.key) return false;
    if (!force && Date.now() - lastFetch < 60000) return false;
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const res = await core.api('/steps', { k: data.key, since: data.healthAt ? data.healthAt + 1 : 0 });
        lastFetch = Date.now();
        let changed = false;
        for (const e of res.entries || []) {
          // The newest reading of a day wins: Health's count only goes up during the day
          const day = e.day || dayKey(e.at);
          data.health[day] = e.n;
          data.healthAt = Math.max(data.healthAt, e.at);
          changed = true;
        }
        if (changed) {
          if (metOn(today()) && data.metNotified !== dayKey(today())) {
            data.metNotified = dayKey(today());
            core.toast(`🎉 Goal hit: ${fmt(totalOn(today()))} steps`);
          }
          save();
          syncReminder();
        }
        return changed;
      } catch (err) {
        console.warn('Could not fetch steps', err);
        return false;
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  // ---------- evening reminder ----------
  const reminderItem = { get serverIds() { return data.serverIds || []; }, set serverIds(v) { data.serverIds = v; } };
  function reminderTimes() {
    if (!data.remind) return [];
    const now = Date.now();
    const out = [];
    for (let i = 0; i < 60; i++) {
      const d = core.addDays(today(), i);
      if (i === 0 && metOn(d)) continue;
      const t = atTime(d, data.remind);
      if (t > now) out.push(t);
    }
    return out;
  }
  async function syncReminder() {
    const left = Math.max(0, data.goal - totalOn(today()));
    await x.syncReminders(reminderItem, [{
      id: 'steps',
      times: reminderTimes(),
      title: '👟 Steps check',
      body: left && totalOn(today()) ? `Goal ${fmt(data.goal)}. Last count: ${fmt(totalOn(today()))}. Go for a walk.` : `Your goal is ${fmt(data.goal)} steps. Get moving.`,
      url: './?page=steps',
    }]);
    data.synced = reminderItem.synced;
    data.syncedAt = reminderItem.syncedAt;
    save();
  }
  async function syncAll(force = false) {
    await fetchHealth(force);
    if (force || !data.synced || Date.now() - (data.syncedAt || 0) > 86400000) await syncReminder();
  }

  // ---------- adding steps ----------
  function addEntry(entry) {
    const item = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), at: Date.now(), day: dayKey(today()), ...entry };
    item.steps = Math.round(item.steps);
    const before = metOn(today());
    data.manual.push(item);
    save();
    core.haptic();
    if (!before && metOn(today())) {
      core.tickSound();
      data.metNotified = dayKey(today());
      save();
      core.toast(`🎉 Goal hit: ${fmt(totalOn(today()))} steps`);
    } else {
      core.toast(`Added ${fmt(item.steps)} steps`, () => removeEntry(item.id, true));
    }
    syncReminder();
    render();
  }

  function removeEntry(id, silent) {
    const i = data.manual.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [gone] = data.manual.splice(i, 1);
    save();
    syncReminder();
    render();
    if (!silent) {
      core.toast('Entry removed', () => {
        data.manual.splice(i, 0, gone);
        save();
        syncReminder();
        render();
      });
    }
  }

  function numberField(label, attrs) {
    const input = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', ...attrs });
    return { input, row: h('label', { class: 'row' }, label, input) };
  }

  function addSheet() {
    let mode = 'treadmill';
    const speedUnit = data.imperial ? 'mph' : 'km/h';
    const distUnit = data.imperial ? 'mi' : 'km';
    const minutes = numberField('Minutes', { placeholder: '30', max: '600' });
    const speed = numberField(`Speed, ${speedUnit}`, { placeholder: data.imperial ? '3.5' : '5.5', max: '30' });
    const dist = numberField(`Distance, ${distUnit}`, { placeholder: data.imperial ? '1.5' : '2.5', max: '100' });
    const count = numberField('Steps', { placeholder: '2500', inputmode: 'numeric', max: '100000' });
    const estimate = h('p', { class: 'st-estimate', 'aria-live': 'polite' });
    const treadmillBox = h('div', { class: 'group' }, minutes.row, speed.row, dist.row,
      h('p', { class: 'hint' }, 'Fill in time and speed, or just the distance the treadmill shows. Only add sessions your phone or Watch didn’t already count.'));
    const countBox = h('div', { class: 'group', hidden: true }, count.row,
      h('p', { class: 'hint' }, 'For steps from another tracker, or if you don’t use Apple Health.'));

    const toKm = (v) => (data.imperial ? v * 1.609 : v);
    function calc() {
      if (mode === 'manual') {
        const n = Number(count.input.value);
        return n > 0 ? { steps: n, kind: 'manual' } : null;
      }
      const mins = Number(minutes.input.value) || 0;
      let kmh = Number(speed.input.value) ? toKm(Number(speed.input.value)) : null;
      let km = Number(dist.input.value) ? toKm(Number(dist.input.value)) : null;
      if (km == null && kmh && mins) km = (kmh * mins) / 60;
      if (kmh == null && km && mins) kmh = km / (mins / 60);
      if (!km) return null;
      return { steps: (km * 1000) / strideM(kmh), kind: 'treadmill', minutes: mins || null, speed: kmh, distanceKm: km };
    }
    function update() {
      const r = calc();
      estimate.classList.toggle('empty', !r);
      estimate.classList.remove('err');
      estimate.textContent = r ? `≈ ${fmt(r.steps)} steps${r.kind === 'treadmill' ? ` · ${fmtDistance(r.distanceKm)}` : ''}` : mode === 'manual' ? 'Enter a step count' : 'Enter time and speed, or distance';
    }
    for (const f of [minutes, speed, dist, count]) f.input.addEventListener('input', update);

    const seg = h('div', { class: 'segmented wide st-mode' },
      ...[['treadmill', 'Treadmill'], ['manual', 'Step count']].map(([m, label]) => h('button', {
        type: 'button',
        class: m === mode ? 'on' : '',
        onclick: (e) => {
          mode = m;
          for (const b of seg.children) b.classList.toggle('on', b === e.currentTarget);
          treadmillBox.hidden = m !== 'treadmill';
          countBox.hidden = m !== 'manual';
          update();
          (m === 'manual' ? count : minutes).input.focus();
        },
      }, label)));
    update();
    sheet('Add steps', [seg, treadmillBox, countBox, estimate], {
      saveLabel: 'Add',
      onSave: () => {
        const r = calc();
        if (!r || r.steps < 1) {
          estimate.textContent = mode === 'manual' ? 'Enter a step count' : 'Enter time and speed, or distance';
          estimate.classList.add('err');
          return false;
        }
        addEntry(r);
        return true;
      },
    });
    setTimeout(() => minutes.input.focus(), 50);
  }

  // ---------- connect Apple Health ----------
  function healthSheet() {
    if (!data.key) {
      data.key = newKey();
      save();
    }
    const status = h('p', { class: 'hint st-status', 'aria-live': 'polite' });
    const showStatus = () => {
      status.textContent = data.healthAt
        ? `✅ Connected. Last reading ${new Date(data.healthAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
        : 'Not connected yet. Run the shortcut once, then tap Check.';
    };
    showStatus();
    const linkBox = h('input', { class: 'field-input st-link', readonly: true, value: shortcutLink(), 'aria-label': 'Shortcut link' });
    const copy = h('button', {
      type: 'button',
      class: 'add-btn full',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(shortcutLink());
          copy.textContent = 'Copied ✓';
        } catch {
          linkBox.select();
          copy.textContent = 'Select and copy the link above';
        }
        setTimeout(() => (copy.textContent = 'Copy link'), 2500);
      },
    }, 'Copy link');
    const check = h('button', {
      type: 'button',
      class: 'ghost-btn full',
      onclick: async () => {
        check.textContent = 'Checking…';
        await fetchHealth(true);
        check.textContent = 'Check connection';
        showStatus();
        render();
      },
    }, 'Check connection');
    const step = (n, html) => h('li', {}, h('span', { class: 'st-num' }, String(n)), h('div', { html }));

    const dialog = sheet('Apple Health', [
      h('p', { class: 'hint' }, 'Your iPhone (and Apple Watch) already count your steps all day. A Shortcut can send that count here. One-time setup, about 5 minutes.'),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, '1. Copy your link'),
        linkBox, copy,
        h('p', { class: 'hint' }, 'This link is private to you. Anyone with it could add steps to your count.')),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, '2. Make the shortcut'),
        h('ol', { class: 'st-guide' },
          step(1, 'Open the <b>Shortcuts</b> app, tap <b>+</b>, name it <b>Send Steps</b>.'),
          step(2, 'Add <b>Find Health Samples</b>. Set <b>Type</b> to <b>Steps</b> and <b>Start Date</b> to <b>is today</b>.'),
          step(3, 'Add <b>Calculate Statistics</b>. Choose <b>Sum</b> of <b>Health Samples</b>.'),
          step(4, 'Add <b>Get Contents of URL</b>. Paste your link into the URL, then tap right after <b>n=</b> and insert the <b>Statistics Result</b> variable.'),
          step(5, 'Tap ▶︎ to run it. Allow Health access and the connection when asked.'))),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, '3. Make it automatic'),
        h('ol', { class: 'st-guide' },
          step(1, 'In Shortcuts, go to <b>Automation</b> → <b>+</b> → <b>Time of Day</b>.'),
          step(2, 'Pick <b>9:00 PM</b>, <b>Daily</b>, and <b>Run Immediately</b>.'),
          step(3, 'Choose your <b>Send Steps</b> shortcut. Add more times (noon, 6 PM, 11:50 PM) for fresher counts.')),
        h('p', { class: 'hint' }, 'You can also run it any time from the Shortcuts widget, or ask Siri “Send Steps”.')),
      h('div', { class: 'group' }, status, check),
      h('button', {
        type: 'button',
        class: 'link-btn st-reset',
        onclick: () => {
          if (!confirm('Make a new private link? The old one stops working, so you will need to update your shortcut.')) return;
          data.key = newKey();
          data.healthAt = 0;
          save();
          linkBox.value = shortcutLink();
          showStatus();
        },
      }, 'Make a new link'),
    ]);
    return dialog;
  }

  // ---------- settings ----------
  function settingsSheet() {
    const goal = h('input', { type: 'number', inputmode: 'numeric', min: '500', max: '100000', step: '500', value: data.goal });
    const units = h('select', {}, h('option', { value: 'm' }, 'km, cm'), h('option', { value: 'i' }, 'miles, feet'));
    units.value = data.imperial ? 'i' : 'm';
    const cm = h('input', { type: 'number', inputmode: 'numeric', min: '100', max: '230', value: data.heightCm });
    const totalIn = Math.round(data.heightCm / 2.54);
    const ft = h('input', { type: 'number', inputmode: 'numeric', min: '3', max: '7', value: Math.floor(totalIn / 12), 'aria-label': 'Feet' });
    const inch = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '11', value: totalIn % 12, 'aria-label': 'Inches' });
    const cmRow = h('label', { class: 'row' }, 'Height (cm)', cm);
    const ftRow = h('div', { class: 'row' }, 'Height', h('span', { class: 'inline' }, ft, 'ft', inch, 'in'));
    const showUnits = () => {
      cmRow.hidden = units.value === 'i';
      ftRow.hidden = units.value !== 'i';
    };
    units.addEventListener('change', showUnits);
    showUnits();
    const remind = h('input', { type: 'time', value: data.remind || '' });
    sheet('Steps settings', [
      h('div', { class: 'group' },
        h('label', { class: 'row' }, 'Daily goal', goal),
        h('label', { class: 'row' }, 'Units', units),
        cmRow, ftRow,
        h('p', { class: 'hint' }, 'Height is used to estimate distance and treadmill steps.')),
      h('div', { class: 'group' },
        h('label', { class: 'row' }, 'Remind me at', remind),
        h('p', { class: 'hint' }, 'A nudge if you haven’t hit your goal yet. Leave empty for none.')),
    ], {
      onSave: () => {
        data.goal = Math.min(100000, Math.max(500, Math.round(Number(goal.value) || 10000)));
        data.imperial = units.value === 'i';
        const height = data.imperial ? ((Number(ft.value) || 0) * 12 + (Number(inch.value) || 0)) * 2.54 : Number(cm.value);
        if (height >= 100 && height <= 230) data.heightCm = Math.round(height);
        data.remind = remind.value || '';
        save();
        syncReminder();
        render();
        return true;
      },
    });
  }

  // ---------- page ----------
  const RING = 2 * Math.PI * 88;

  function render() {
    const page = $('page-steps');
    if (!page || page.hidden) return;
    const t = today();
    const total = totalOn(t);
    const left = Math.max(0, data.goal - total);
    const fraction = Math.min(1, total / data.goal);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<circle cx="100" cy="100" r="88" class="ring-bg"/><circle cx="100" cy="100" r="88" class="ring-fg${fraction >= 1 ? ' met' : ''}" stroke-dasharray="${RING}" stroke-dashoffset="${RING * (1 - fraction)}" transform="rotate(-90 100 100)"/>`;
    const ring = h('div', { class: 'ring-wrap st-ring', role: 'img', 'aria-label': `${fmt(total)} of ${fmt(data.goal)} steps today` }, svg,
      h('div', { class: 'ring-text' },
        h('div', { class: 'ring-label' }, 'Today'),
        h('div', { class: 'ring-time st-count' }, fmt(total)),
        h('div', { class: 'ring-sub' }, left ? `${fmt(left)} to go · goal ${short(data.goal)}` : 'Goal hit 🎉')));

    const s = streak();
    const stat = (v, l) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
    const stats = h('div', { class: 'stats' },
      stat(fmtDistance(kmFor(total)), 'distance'),
      stat(fmt(total * 0.04), 'kcal (est.)'),
      stat(s ? `🔥 ${s}` : '0', s === 1 ? 'day streak' : 'day streak'));

    // Where today's number comes from
    const connected = !!data.key && !!data.healthAt;
    const source = h('div', { class: 'st-source' },
      connected
        ? h('span', { class: 'st-source-text' }, `Apple Health: ${fmt(healthOn(t))} steps`,
          h('small', {}, `Updated ${dayKey(data.healthAt) === dayKey(t) ? 'today' : new Date(data.healthAt).toLocaleDateString([], { weekday: 'long' })} at ${core.fmtTime(data.healthAt)}`))
        : h('span', { class: 'st-source-text' }, 'Apple Health isn’t connected', h('small', {}, 'Get your real step count automatically')),
      h('button', { type: 'button', class: 'link-btn', onclick: () => (connected ? refresh() : healthSheet()) }, connected ? 'Refresh' : 'Connect'));

    async function refresh() {
      source.classList.add('busy');
      await fetchHealth(true);
      render();
    }

    const buttons = h('div', { class: 'focus-btns' },
      h('button', { type: 'button', class: 'big-btn', onclick: addSheet }, '+ Add steps'));

    // Last 7 days
    const week = Array.from({ length: 7 }, (_, i) => core.addDays(t, i - 6));
    const totals = week.map(totalOn);
    const max = Math.max(data.goal, ...totals);
    const goalPct = (data.goal / max) * 100;
    const avg = totals.reduce((a, b) => a + b, 0) / 7;
    const metDays = totals.filter((n) => n >= data.goal).length;
    const PLOT = 84; // px for the tallest bar
    const chart = h('div', { class: 'st-chart' },
      h('div', { class: 'st-plot' },
        h('div', { class: 'st-goal-line', style: `bottom:${Math.round(goalPct / 100 * PLOT)}px` }),
        ...week.map((d, i) => h('div', {
          class: 'st-col' + (i === 6 ? ' today' : '') + (totals[i] >= data.goal ? ' met' : ''),
          role: 'img',
          'aria-label': `${new Date(d).toLocaleDateString([], { weekday: 'long' })}: ${fmt(totals[i])} steps`,
        },
        h('em', {}, totals[i] ? short(totals[i]) : ''),
        h('div', { class: 'st-fill', style: `height:${Math.max(3, Math.round((totals[i] / max) * PLOT))}px` })))),
      h('div', { class: 'st-days' }, ...week.map((d, i) => h('span', { class: i === 6 ? 'now' : '' }, DAY_LETTERS[new Date(d).getDay()]))));
    const weekCard = h('div', { class: 'group' },
      h('div', { class: 'st-chart-head' },
        h('p', { class: 'group-title' }, 'Last 7 days'),
        h('span', { class: 'st-legend' }, h('i'), `goal ${short(data.goal)}`)),
      chart,
      h('div', { class: 'stats' },
        stat(fmt(avg), 'daily average'),
        stat(`${metDays}/7`, 'goal days'),
        stat(String(bestStreak()), 'best streak')));

    const entries = manualOn(t);
    const added = entries.length
      ? h('div', { class: 'group' },
        h('p', { class: 'group-title' }, 'Added today'),
        h('ul', { class: 'sessions' }, ...entries.slice().reverse().map((m) => h('li', {},
          h('span', {}, m.kind === 'treadmill'
            ? `🏃 Treadmill${m.minutes ? ` · ${m.minutes} min` : ''}${m.distanceKm ? ` · ${fmtDistance(m.distanceKm)}` : ''}`
            : '👟 Steps added'),
          h('span', { class: 'st-entry-right' }, fmt(m.steps),
            h('button', { type: 'button', class: 'del', 'aria-label': 'Remove entry', onclick: () => removeEntry(m.id) }, '×'))))))
      : null;

    const settingsRow = h('div', { class: 'btn-row st-links' },
      h('button', { type: 'button', class: 'ghost-btn', onclick: settingsSheet }, 'Goal & settings'),
      h('button', { type: 'button', class: 'ghost-btn', onclick: healthSheet }, 'Apple Health'));

    page.replaceChildren(h('div', { class: 'focus st-page' }, ring, stats, source, buttons, weekCard, added, settingsRow));
  }

  function reload() {
    data = load();
    data.synced = false;
    data.serverIds = [];
    save();
  }

  window.TodoSteps = { render, syncAll, reload };

  if (x.page === 'steps') render();
  // Fetch the latest Health count whenever the app comes back to the front
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (await fetchHealth())) render();
  });
  fetchHealth().then((changed) => changed && render());
})();
