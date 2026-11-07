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

  // Add steps: one number is all you need. The treadmill helper is optional and fills it in for you.
  const PACES = [
    ['Easy walk', 4.5], ['Walk', 5.5], ['Brisk walk', 6.5], ['Jog', 8], ['Run', 10],
  ];
  function addSheet() {
    let day = 'today';
    let paceKmh = data.lastPace || 5.5;
    let fromTreadmill = null; // the estimate currently in the box, if any
    const distUnit = data.imperial ? 'mi' : 'km';
    const toKm = (v) => (data.imperial ? v * 1.609 : v);
    const paceLabel = (kmh) => (data.imperial ? `${(kmh / 1.609).toFixed(1)} mph` : `${kmh} km/h`);

    const count = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '100000', placeholder: '0', class: 'st-big-input', 'aria-label': 'Steps' });
    const hint = h('p', { class: 'st-estimate empty', 'aria-live': 'polite' }, 'How many steps?');
    const showHint = (text, kind) => {
      hint.textContent = text;
      hint.className = 'st-estimate' + (kind ? ` ${kind}` : '');
    };
    count.addEventListener('input', () => {
      fromTreadmill = null;
      showHint(Number(count.value) > 0 ? `${fmt(Number(count.value))} steps` : 'How many steps?', Number(count.value) > 0 ? '' : 'empty');
    });

    const quick = h('div', { class: 'chips st-quick' },
      ...[1000, 2500, 5000].map((n) => h('button', {
        type: 'button',
        class: 'chip',
        onclick: () => {
          count.value = String((Number(count.value) || 0) + n);
          count.dispatchEvent(new Event('input'));
        },
      }, `+${fmt(n)}`)));

    const daySeg = h('div', { class: 'segmented st-mode' },
      ...[['today', 'Today'], ['yesterday', 'Yesterday']].map(([d, label]) => h('button', {
        type: 'button',
        class: d === day ? 'on' : '',
        onclick: (e) => {
          day = d;
          for (const b of daySeg.children) b.classList.toggle('on', b === e.currentTarget);
        },
      }, label)));

    // Optional treadmill helper
    const minutes = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '600', placeholder: '30', class: 'field-input', 'aria-label': 'Minutes on the treadmill' });
    const dist = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', max: '100', placeholder: data.imperial ? '1.5' : '2.5', class: 'field-input', 'aria-label': `Distance in ${distUnit}` });
    const paces = h('div', { class: 'chips st-paces' },
      ...PACES.map(([label, kmh]) => h('button', {
        type: 'button',
        class: 'chip' + (kmh === paceKmh ? ' on' : ''),
        'aria-pressed': String(kmh === paceKmh),
        onclick: (e) => {
          paceKmh = kmh;
          for (const b of paces.children) {
            b.classList.toggle('on', b === e.currentTarget);
            b.setAttribute('aria-pressed', String(b === e.currentTarget));
          }
          estimate();
        },
      }, h('b', {}, label), h('span', {}, paceLabel(kmh)))));

    function estimate() {
      const mins = Number(minutes.value) || 0;
      const km = Number(dist.value) ? toKm(Number(dist.value)) : mins ? (paceKmh * mins) / 60 : 0;
      if (!km) return;
      const kmh = Number(dist.value) && mins ? km / (mins / 60) : paceKmh;
      const steps = Math.round((km * 1000) / strideM(kmh));
      fromTreadmill = { steps, kind: 'treadmill', minutes: mins || null, speed: kmh, distanceKm: km };
      count.value = String(steps);
      showHint(`≈ ${fmt(steps)} steps · ${fmtDistance(km)}`);
    }
    minutes.addEventListener('input', estimate);
    dist.addEventListener('input', estimate);

    const treadBox = h('div', { class: 'group st-tread', hidden: true },
      h('label', { class: 'st-field' }, h('span', {}, 'How many minutes?'), minutes),
      h('div', { class: 'st-field' }, h('span', {}, 'How fast?'), paces),
      h('details', { class: 'st-more' },
        h('summary', {}, 'Treadmill shows the distance?'),
        h('label', { class: 'st-field' }, h('span', {}, `Distance, ${distUnit}`), dist)),
      h('p', { class: 'hint' }, 'Only add walks your phone or Watch didn’t count, like when your phone was on the treadmill’s stand.'));
    const treadToggle = h('button', {
      type: 'button',
      class: 'link-btn st-tread-toggle',
      'aria-expanded': 'false',
      onclick: () => {
        treadBox.hidden = !treadBox.hidden;
        treadToggle.setAttribute('aria-expanded', String(!treadBox.hidden));
        treadToggle.textContent = treadBox.hidden ? 'On a treadmill? Work out my steps' : 'Hide treadmill helper';
        if (!treadBox.hidden) minutes.focus();
      },
    }, 'On a treadmill? Work out my steps');

    sheet('Add steps', [count, hint, quick, daySeg, treadToggle, treadBox], {
      saveLabel: 'Add',
      onSave: () => {
        const n = Math.round(Number(count.value));
        if (!(n > 0)) {
          showHint('Enter how many steps', 'err');
          count.focus();
          return false;
        }
        const entry = fromTreadmill && fromTreadmill.steps === n ? fromTreadmill : { steps: n, kind: 'manual' };
        if (fromTreadmill) {
          data.lastPace = paceKmh;
          save();
        }
        if (day === 'yesterday') entry.day = dayKey(core.addDays(today(), -1));
        addEntry(entry);
        return true;
      },
    });
    setTimeout(() => count.focus(), 50);
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

    const dialog = sheet('All-day steps', [
      h('p', { class: 'hint' }, 'Your iPhone counts your steps all day, even when this app is closed. A Shortcut sends that count here, so you never need to open the Health app. One-time setup, about 5 minutes.'),
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

  // ---------- live walk: count steps from the phone's motion sensor, right on the Steps page ----------
  // iPhone freezes web apps a few seconds after you switch away, so while you're in another app
  // nothing can be measured. When you come back mid-walk, the gap is filled in from your pace.
  const CHEERS = ['Keep going!', 'Nice pace!', 'You’re moving!', 'Every step counts!', 'Look at you go!', 'Don’t stop now!'];
  const MAX_AWAY_MIN = 90;
  let live = null;

  const liveEntry = () => live && data.manual.find((m) => m.id === live.entryId);
  const liveCadence = () => {
    const now = Date.now();
    while (live.recent.length && now - live.recent[0] > 30000) live.recent.shift();
    return live.recent.length > 8 ? live.recent.length * 2 : 0; // steps a minute over the last 30 s
  };

  async function keepAwake() {
    try {
      if (live && 'wakeLock' in navigator && !live.wakeLock && document.visibilityState === 'visible') {
        live.wakeLock = await navigator.wakeLock.request('screen');
        live.wakeLock.addEventListener('release', () => live && (live.wakeLock = null));
      }
    } catch {}
  }

  async function startLive() {
    if (live) return;
    if (!('DeviceMotionEvent' in window)) {
      core.toast('This phone doesn’t share motion data with the app');
      return;
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') {
          core.toast('Allow Motion & Orientation access to count steps live');
          return;
        }
      } catch {
        core.toast('Couldn’t get motion access. Try again.');
        return;
      }
    }
    const entry = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), at: Date.now(), day: dayKey(today()), steps: 0, kind: 'live', minutes: 0, estimated: 0 };
    data.manual.push(entry);
    save();
    live = {
      entryId: entry.id,
      detector: window.Pedometer.create(data.liveSens || 'normal'),
      activeMs: 0,
      lastTick: Date.now(),
      paused: false,
      gotMotion: false,
      recent: [],
      hiddenAt: 0,
      hiddenCadence: 0,
      away: null, // { steps, minutes } filled in after coming back
      cheer: '',
      wakeLock: null,
      els: null,
      dirty: false,
    };
    window.addEventListener('devicemotion', onMotion);
    live.tick = setInterval(onTick, 1000);
    keepAwake();
    core.haptic();
    render();
    setTimeout(() => {
      if (live && !live.gotMotion) {
        live.cheer = 'No motion data yet. Check Settings → Apps → Safari → Motion & Orientation Access.';
        liveUpdate();
      }
    }, 3000);
  }

  function stopLive() {
    if (!live) return;
    window.removeEventListener('devicemotion', onMotion);
    clearInterval(live.tick);
    live.wakeLock?.release().catch(() => {});
    const entry = liveEntry();
    const steps = entry ? entry.steps : 0;
    if (entry && !steps) data.manual = data.manual.filter((m) => m !== entry);
    live = null;
    save();
    syncReminder();
    render();
    if (steps) core.toast(`Walk saved: ${fmt(steps)} steps`);
  }

  function addLiveSteps(n, estimated) {
    const entry = liveEntry();
    if (!entry) return stopLive();
    const before = totalOn(today());
    entry.steps += n;
    if (estimated) entry.estimated = (entry.estimated || 0) + n;
    live.dirty = true;
    const total = before + n;
    if (before < data.goal && total >= data.goal) {
      live.cheer = `🎉 ${short(data.goal)}! You hit your goal!`;
      data.metNotified = dayKey(today());
      core.tickSound();
      core.haptic();
    } else if (!estimated && Math.floor(entry.steps / 500) > Math.floor((entry.steps - n) / 500)) {
      const left = Math.max(0, data.goal - total);
      live.cheer = `🔥 ${fmt(Math.floor(entry.steps / 500) * 500)} steps this walk.${left ? ` ${fmt(left)} to go.` : ''} ${CHEERS[Math.floor(entry.steps / 500) % CHEERS.length]}`;
      core.haptic();
    }
    liveUpdate();
  }

  function onMotion(e) {
    if (!live) return;
    live.gotMotion = true;
    if (live.paused) return;
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const found = live.detector.feed(a.x, a.y, a.z, e.timeStamp || performance.now());
    if (!found) return;
    const now = Date.now();
    for (let i = 0; i < found; i++) live.recent.push(now);
    addLiveSteps(found, false);
  }

  function onTick() {
    if (!live) return;
    const now = Date.now();
    if (!live.paused && document.visibilityState === 'visible' && live.detector.walking) live.activeMs += now - live.lastTick;
    live.lastTick = now;
    const entry = liveEntry();
    if (entry) entry.minutes = Math.max(1, Math.round(live.activeMs / 60000));
    if (live.dirty) {
      live.dirty = false;
      save(); // saved as you go, so nothing is lost if the app closes
    }
    liveUpdate();
  }

  // Leaving the app: remember the pace. Coming back: fill in the minutes you were away.
  document.addEventListener('visibilitychange', () => {
    if (!live) return;
    if (document.visibilityState === 'hidden') {
      live.hiddenAt = Date.now();
      live.hiddenCadence = live.paused ? 0 : liveCadence();
      save();
      return;
    }
    keepAwake();
    const away = live.hiddenAt ? (Date.now() - live.hiddenAt) / 60000 : 0;
    live.lastTick = Date.now();
    live.hiddenAt = 0;
    if (live.hiddenCadence && away >= 0.2) {
      const minutes = Math.min(away, MAX_AWAY_MIN);
      const steps = Math.round(live.hiddenCadence * minutes);
      live.activeMs += minutes * 60000;
      live.away = { steps, minutes: Math.max(1, Math.round(minutes)) };
      live.recent = [];
      addLiveSteps(steps, true);
      save();
      render();
    }
  });

  function undoAway() {
    const entry = liveEntry();
    if (!entry || !live.away) return;
    entry.steps = Math.max(0, entry.steps - live.away.steps);
    entry.estimated = Math.max(0, (entry.estimated || 0) - live.away.steps);
    live.activeMs = Math.max(0, live.activeMs - live.away.minutes * 60000);
    live.away = null;
    save();
    render();
  }

  // Patch the numbers in place on every step instead of redrawing the page
  function liveUpdate() {
    const els = live?.els;
    if (!els || !els.count.isConnected) return;
    const entry = liveEntry();
    const total = totalOn(today());
    const fraction = Math.min(1, total / data.goal);
    els.arc.setAttribute('stroke-dashoffset', String(RING * (1 - fraction)));
    els.arc.classList.toggle('met', fraction >= 1);
    els.count.textContent = fmt(total);
    const left = Math.max(0, data.goal - total);
    els.sub.textContent = left ? `${fmt(left)} to go · goal ${short(data.goal)}` : 'Goal hit 🎉';
    els.walk.textContent = `+${fmt(entry ? entry.steps : 0)} this walk`;
    const sec = Math.floor(live.activeMs / 1000);
    els.time.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const cad = liveCadence();
    els.pace.textContent = cad ? String(cad) : '–';
    els.dist.textContent = fmtDistance(kmFor(entry ? entry.steps : 0));
    els.cheer.textContent = live.cheer;
    const walking = !live.paused && live.detector.walking;
    els.status.textContent = live.paused
      ? 'Paused'
      : !live.gotMotion
        ? 'Waiting for the motion sensor…'
        : walking
          ? '● Counting'
          : entry && entry.steps
            ? 'Stopped? Start walking and I’ll pick it up.'
            : 'Start walking. Counting begins after a few steps.';
    els.status.classList.toggle('on', walking);
  }

  // The live part of the Steps page
  function liveBlock(stat) {
    const els = {};
    els.walk = h('div', { class: 'st-live-walk' });
    els.cheer = h('p', { class: 'st-live-cheer', 'aria-live': 'polite' });
    els.status = h('p', { class: 'st-live-status' });
    els.time = h('b', {}, '0:00');
    els.pace = h('b', {}, '–');
    els.dist = h('b', {}, '');
    const sens = h('div', { class: 'segmented st-mode' },
      ...[['low', 'Less'], ['normal', 'Normal'], ['high', 'More']].map(([v, label]) => h('button', {
        type: 'button',
        class: (data.liveSens || 'normal') === v ? 'on' : '',
        onclick: (e) => {
          data.liveSens = v;
          save();
          live.detector.setSensitivity(v);
          for (const b of sens.children) b.classList.toggle('on', b === e.currentTarget);
        },
      }, label)));
    const awayNote = live.away
      ? h('div', { class: 'st-away' },
        h('span', {}, `+${fmt(live.away.steps)} steps added for the ${plural(live.away.minutes, 'minute')} you were in another app, based on your pace.`),
        h('button', { type: 'button', class: 'link-btn', onclick: undoAway }, 'Remove'))
      : null;
    const block = h('div', { class: 'st-live-block' },
      els.walk, els.cheer,
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, els.time, h('span', {}, 'walking time')),
        h('div', { class: 'stat' }, els.pace, h('span', {}, 'steps/min')),
        h('div', { class: 'stat' }, els.dist, h('span', {}, 'this walk'))),
      els.status,
      awayNote,
      h('div', { class: 'btn-row st-live-btns' },
        h('button', { type: 'button', class: 'ghost-btn', onclick: () => {
          live.paused = !live.paused;
          render();
        } }, live.paused ? 'Resume' : 'Pause'),
        h('button', { type: 'button', class: 'big-btn st-stop', onclick: stopLive }, 'Stop walk')),
      h('p', { class: 'hint center' }, 'Steps save as you go. You can switch to another app: when you come back, the minutes you were away are filled in from your pace.'),
      data.healthAt ? h('p', { class: 'hint center' }, 'Your iPhone may count this walk too. If today’s total jumps by about the same amount later, remove this walk from “Added today”.') : null,
      h('div', { class: 'st-live-sens' }, h('span', {}, 'Missing steps or counting too many?'), sens));
    return { block, els };
  }

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
    const countEl = h('div', { class: 'ring-time st-count' }, fmt(total));
    const subEl = h('div', { class: 'ring-sub' }, left ? `${fmt(left)} to go · goal ${short(data.goal)}` : 'Goal hit 🎉');
    const ring = h('div', { class: 'ring-wrap st-ring' + (live ? ' live' : ''), role: 'img', 'aria-label': `${fmt(total)} of ${fmt(data.goal)} steps today` }, svg,
      h('div', { class: 'ring-text' }, h('div', { class: 'ring-label' }, live ? 'Today · live' : 'Today'), countEl, subEl));

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
        ? h('span', { class: 'st-source-text' }, `All-day steps from your iPhone: ${fmt(healthOn(t))}`,
          h('small', {}, `Updated ${dayKey(data.healthAt) === dayKey(t) ? 'today' : new Date(data.healthAt).toLocaleDateString([], { weekday: 'long' })} at ${core.fmtTime(data.healthAt)}`))
        : h('span', { class: 'st-source-text' }, 'Only live walks are counted', h('small', {}, 'Your iPhone counts every step you take. Connect once to see them all here.')),
      h('button', { type: 'button', class: 'link-btn', onclick: () => (connected ? refresh() : healthSheet()) }, connected ? 'Refresh' : 'Connect'));

    async function refresh() {
      source.classList.add('busy');
      await fetchHealth(true);
      render();
    }

    const buttons = h('div', { class: 'focus-btns st-btns' },
      h('button', { type: 'button', class: 'big-btn', onclick: startLive }, '▶ Start live walk'),
      h('button', { type: 'button', class: 'ghost-btn', onclick: addSheet }, '+ Add steps'));

    // While walking, the live counter takes the place of the summary and buttons
    let liveEl = null;
    if (live) {
      const lb = liveBlock(stat);
      liveEl = lb.block;
      live.els = { ...lb.els, count: countEl, sub: subEl, arc: svg.querySelector('.ring-fg') };
    }

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
          h('span', {}, m.kind === 'live'
            ? `🚶 Live walk${live && live.entryId === m.id ? ' · now' : m.minutes ? ` · ${m.minutes} min` : ''}${m.estimated ? ` · ${fmt(m.estimated)} estimated` : ''}`
            : m.kind === 'treadmill'
            ? `🏃 Treadmill${m.minutes ? ` · ${m.minutes} min` : ''}${m.distanceKm ? ` · ${fmtDistance(m.distanceKm)}` : ''}`
            : '👟 Steps added'),
          h('span', { class: 'st-entry-right' }, fmt(m.steps),
            h('button', { type: 'button', class: 'del', 'aria-label': 'Remove entry', onclick: () => {
              if (live && live.entryId === m.id) stopLive();
              removeEntry(m.id);
            } }, '×'))))))
      : null;

    const settingsRow = h('div', { class: 'btn-row st-links' },
      h('button', { type: 'button', class: 'ghost-btn', onclick: settingsSheet }, 'Goal & settings'),
      h('button', { type: 'button', class: 'ghost-btn', onclick: healthSheet }, 'iPhone steps'));

    page.replaceChildren(live
      ? h('div', { class: 'focus st-page' }, ring, liveEl, added)
      : h('div', { class: 'focus st-page' }, ring, stats, source, buttons, weekCard, added, settingsRow));
    if (live) liveUpdate();
  }

  function reload() {
    data = load();
    data.synced = false;
    data.serverIds = [];
    save();
  }

  window.TodoSteps = { render, syncAll, reload };

  // An older version kept unfinished walks here
  if (data.liveDraft) {
    const d = data.liveDraft;
    if (d.steps > 0) data.manual.push({ id: String(Date.now()), at: d.at || Date.now(), day: d.day, steps: d.steps, kind: 'live', minutes: Math.max(1, Math.round(d.ms / 60000)) });
    data.liveDraft = null;
    save();
  }
  if (x.page === 'steps') render();
  // Fetch the latest Health count whenever the app comes back to the front
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (await fetchHealth())) render();
  });
  fetchHealth().then((changed) => changed && render());
})();
