// Focus timer, habit tracker and countdowns.
// Uses the helpers app.js shares on window.TodoCore (toast, sound, reminders server, dates).
(() => {
  const core = window.TodoCore;
  const DAY = 86400000;
  const KEYS = { habits: 'todo.habits.v1', countdowns: 'todo.countdowns.v1', focus: 'todo.focus.v1', page: 'todo.page' };
  const TITLES = { tasks: 'Tasks', focus: 'Focus', habits: 'Habits', countdowns: 'Countdown' };
  const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const $ = (id) => document.getElementById(id);
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const dayKey = (ms) => core.toDateInput(ms);
  const today = () => core.startOfDay(Date.now());
  const fromDayKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const atTime = (dayMs, hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    const d = new Date(dayMs);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Tiny element builder: h('div', { class: 'x', onclick }, child, ...)
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el[k] = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }

  // A bottom sheet with Cancel / title / Save
  function sheet(title, body, { onSave, saveLabel = 'Save', footer } = {}) {
    const dialog = h('dialog', { class: 'sheet' });
    const form = h('form', { method: 'dialog' });
    const cancel = h('button', { type: 'button', class: 'link-btn', onclick: () => dialog.close() }, 'Cancel');
    const ok = onSave
      ? h('button', { type: 'submit', class: 'link-btn strong' }, saveLabel)
      : h('button', { type: 'submit', class: 'link-btn strong' }, 'Done');
    form.append(h('div', { class: 'sheet-head' }, onSave ? cancel : h('span'), h('h2', {}, title), ok), ...[body].flat());
    if (footer) form.append(footer);
    form.addEventListener('submit', (e) => {
      if (onSave && onSave() === false) e.preventDefault();
    });
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  // ---------- reminders through the push server ----------
  // `item` remembers which ids it has on the server so stale ones get cancelled
  async function syncReminders(item, entries) {
    const sub = await core.currentSubscription();
    if (!sub) return;
    try {
      const wanted = entries.filter((e) => e.times.length);
      for (const e of wanted) {
        await core.api('/schedule', {
          id: e.id,
          times: e.times.slice(0, 60),
          title: e.title,
          body: e.body,
          url: e.url,
          nag: 0,
          subscription: sub.toJSON(),
        });
      }
      for (const id of item.serverIds || []) {
        if (!wanted.some((e) => e.id === id)) await core.api('/cancel', { id, endpoint: sub.endpoint });
      }
      item.serverIds = wanted.map((e) => e.id);
      item.synced = true;
      item.syncedAt = Date.now();
    } catch (err) {
      console.warn('Reminder sync failed; will retry', err);
    }
  }

  async function cancelReminders(item) {
    const sub = await core.currentSubscription();
    if (!sub) return;
    for (const id of item.serverIds || []) core.api('/cancel', { id, endpoint: sub.endpoint }).catch(() => {});
  }

  // =====================================================================
  // FOCUS TIMER
  // =====================================================================
  const focusDefaults = {
    settings: { focus: 25, short: 5, long: 15, every: 4 },
    mode: 'pomo',
    phase: 'focus',
    running: false,
    endAt: null,
    remaining: null,
    startedAt: null,
    taskId: '',
    cycle: 0,
    swStart: null,
    swElapsed: 0,
    sessions: [],
  };
  let focus = { ...focusDefaults, ...core.read(KEYS.focus, {}) };
  focus.settings = { ...focusDefaults.settings, ...focus.settings };
  const saveFocus = () => save(KEYS.focus, focus);
  const PHASE_NAMES = { focus: 'Focus', short: 'Short break', long: 'Long break' };
  const phaseLength = (phase = focus.phase) => focus.settings[phase] * 60000;

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      /* not available */
    }
  }

  const focusItem = { serverIds: core.read('todo.focus.server', []) };
  async function scheduleFocusPush() {
    const entries = [];
    if (focus.mode === 'pomo' && focus.running && focus.endAt) {
      const done = focus.phase === 'focus';
      entries.push({
        id: 'focus',
        times: [focus.endAt],
        title: done ? 'Focus session complete 🎉' : 'Break’s over',
        body: done ? 'Nice work. Time for a break.' : 'Ready for the next focus session?',
        url: './?page=focus',
      });
    }
    await syncReminders(focusItem, entries);
    save('todo.focus.server', focusItem.serverIds || []);
  }

  function recordSession(minutes, pomo) {
    if (minutes < 1) return;
    const task = core.tasks.find((t) => t.id === focus.taskId);
    focus.sessions.push({ end: Date.now(), minutes: Math.round(minutes), pomo, task: task ? task.text : '' });
    // Keep a year of history
    const cutoff = Date.now() - 366 * DAY;
    focus.sessions = focus.sessions.filter((s) => s.end > cutoff);
  }

  function focusStart() {
    const now = Date.now();
    if (focus.mode === 'stopwatch') {
      focus.swStart = now;
    } else {
      focus.endAt = now + (focus.remaining ?? phaseLength());
      focus.remaining = null;
      if (!focus.startedAt) focus.startedAt = now;
    }
    focus.running = true;
    core.haptic();
    saveFocus();
    keepAwake(true);
    scheduleFocusPush();
    if (focus.mode === 'pomo') core.ensurePushForReminder();
    renderFocus();
  }

  function focusPause() {
    const now = Date.now();
    if (focus.mode === 'stopwatch') {
      focus.swElapsed += now - focus.swStart;
      focus.swStart = null;
    } else {
      focus.remaining = Math.max(0, focus.endAt - now);
      focus.endAt = null;
    }
    focus.running = false;
    saveFocus();
    keepAwake(false);
    scheduleFocusPush();
    renderFocus();
  }

  function focusReset() {
    focus.running = false;
    focus.endAt = null;
    focus.remaining = null;
    focus.startedAt = null;
    focus.swStart = null;
    focus.swElapsed = 0;
    keepAwake(false);
  }

  function focusStop() {
    const now = Date.now();
    if (focus.mode === 'stopwatch') {
      const elapsed = focus.swElapsed + (focus.swStart ? now - focus.swStart : 0);
      recordSession(elapsed / 60000, false);
      if (elapsed >= 60000) core.toast(`Saved ${plural(Math.round(elapsed / 60000), 'minute')} of focus`);
    } else if (focus.phase === 'focus') {
      const left = focus.running ? focus.endAt - now : focus.remaining ?? phaseLength();
      const done = (phaseLength() - left) / 60000;
      if (done >= 1 && !confirm('End this session early? The time still counts, but not as a full pomo.')) return;
      recordSession(done, false);
    } else {
      focus.phase = 'focus';
    }
    focusReset();
    saveFocus();
    scheduleFocusPush();
    renderFocus();
  }

  function focusComplete() {
    if (focus.phase === 'focus') {
      recordSession(focus.settings.focus, true);
      focus.cycle += 1;
      focus.phase = focus.cycle % focus.settings.every === 0 ? 'long' : 'short';
      core.toast(`Pomo done! ${PHASE_NAMES[focus.phase]} time.`);
    } else {
      focus.phase = 'focus';
      core.toast('Break’s over. Ready when you are.');
    }
    core.tickSound();
    core.haptic();
    focusReset();
    saveFocus();
    renderFocus();
  }

  function focusSkip() {
    focus.phase = 'focus';
    focusReset();
    saveFocus();
    scheduleFocusPush();
    renderFocus();
  }

  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = String(s % 60).padStart(2, '0');
    return hrs ? `${hrs}:${String(mins).padStart(2, '0')}:${secs}` : `${String(mins).padStart(2, '0')}:${secs}`;
  };
  const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

  const RING = 2 * Math.PI * 88;
  let ringEl = null;
  let timeEl = null;

  function focusDisplay() {
    const now = Date.now();
    if (focus.mode === 'stopwatch') {
      const elapsed = focus.swElapsed + (focus.swStart ? now - focus.swStart : 0);
      return { text: mmss(elapsed), fraction: (elapsed % 3600000) / 3600000 };
    }
    const left = focus.running ? focus.endAt - now : focus.remaining ?? phaseLength();
    return { text: mmss(left), fraction: 1 - left / phaseLength() };
  }

  function tickFocus() {
    if (focus.mode === 'pomo' && focus.running && Date.now() >= focus.endAt) return focusComplete();
    if (!timeEl) return;
    const { text, fraction } = focusDisplay();
    timeEl.textContent = text;
    ringEl.style.strokeDashoffset = String(RING * (1 - Math.min(1, Math.max(0, fraction))));
  }
  setInterval(() => {
    if (focus.running) tickFocus();
  }, 250);

  function renderFocus() {
    const page = $('page-focus');
    if (page.hidden) return;
    const pomo = focus.mode === 'pomo';
    const modes = h('div', { class: 'segmented wide' },
      ...[['pomo', 'Pomodoro'], ['stopwatch', 'Stopwatch']].map(([m, label]) =>
        h('button', {
          type: 'button',
          class: focus.mode === m ? 'on' : '',
          disabled: focus.running,
          onclick: () => {
            if (focus.mode === m) return;
            focusReset();
            focus.mode = m;
            focus.phase = 'focus';
            saveFocus();
            renderFocus();
          },
        }, label)));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'ring');
    svg.innerHTML = `<circle cx="100" cy="100" r="88" class="ring-bg"/><circle cx="100" cy="100" r="88" class="ring-fg ${focus.phase !== 'focus' && pomo ? 'break' : ''}" stroke-dasharray="${RING}" transform="rotate(-90 100 100)"/>`;
    ringEl = svg.querySelector('.ring-fg');
    timeEl = h('div', { class: 'ring-time' });
    const label = pomo ? PHASE_NAMES[focus.phase] : 'Stopwatch';
    const cycleText = pomo ? `Pomo ${(focus.cycle % focus.settings.every) + (focus.phase === 'focus' ? 1 : 0) || focus.settings.every} of ${focus.settings.every}` : '';
    const ring = h('div', { class: 'ring-wrap' }, svg,
      h('div', { class: 'ring-text' }, h('div', { class: 'ring-label' }, label), timeEl, h('div', { class: 'ring-sub' }, cycleText)));

    const open = core.tasks.filter((t) => !t.done);
    if (focus.taskId && !open.some((t) => t.id === focus.taskId)) focus.taskId = '';
    const taskSelect = h('select', {
      onchange: (e) => {
        focus.taskId = e.target.value;
        saveFocus();
      },
    }, h('option', { value: '' }, 'Nothing in particular'), ...open.map((t) => h('option', { value: t.id }, t.text.slice(0, 60))));
    taskSelect.value = focus.taskId;

    const paused = !focus.running && (focus.remaining != null || focus.swElapsed > 0);
    const buttons = h('div', { class: 'focus-btns' });
    if (focus.running) {
      buttons.append(h('button', { type: 'button', class: 'big-btn', onclick: focusPause }, 'Pause'));
      buttons.append(h('button', { type: 'button', class: 'ghost-btn', onclick: focusStop }, focus.phase === 'focus' || !pomo ? 'Stop' : 'Skip break'));
    } else if (paused) {
      buttons.append(h('button', { type: 'button', class: 'big-btn', onclick: focusStart }, 'Resume'));
      buttons.append(h('button', { type: 'button', class: 'ghost-btn', onclick: focusStop }, pomo && focus.phase !== 'focus' ? 'Skip break' : 'Stop'));
    } else {
      buttons.append(h('button', { type: 'button', class: 'big-btn', onclick: focusStart }, pomo && focus.phase !== 'focus' ? `Start ${PHASE_NAMES[focus.phase].toLowerCase()}` : 'Start focus'));
      if (pomo && focus.phase !== 'focus') buttons.append(h('button', { type: 'button', class: 'ghost-btn', onclick: focusSkip }, 'Skip break'));
    }

    // Stats
    const start = today();
    const todays = focus.sessions.filter((s) => s.end >= start);
    const weekStart = core.addDays(start, -6);
    const week = focus.sessions.filter((s) => s.end >= weekStart);
    const sum = (list) => list.reduce((n, s) => n + s.minutes, 0);
    const stat = (value, label) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
    const bars = h('div', { class: 'bars' }, ...Array.from({ length: 7 }, (_, i) => {
      const day = core.addDays(weekStart, i);
      const mins = sum(focus.sessions.filter((s) => s.end >= day && s.end < core.addDays(day, 1)));
      const max = Math.max(60, ...Array.from({ length: 7 }, (_, j) => {
        const d = core.addDays(weekStart, j);
        return sum(focus.sessions.filter((s) => s.end >= d && s.end < core.addDays(d, 1)));
      }));
      return h('div', { class: 'bar' + (i === 6 ? ' today' : ''), title: fmtMinutes(mins) },
        h('div', { class: 'bar-fill', style: `height:${Math.round((mins / max) * 100)}%` }),
        h('span', {}, DAY_LETTERS[new Date(day).getDay()]));
    }));
    const stats = h('div', { class: 'group' },
      h('p', { class: 'group-title' }, 'Today'),
      h('div', { class: 'stats' },
        stat(String(todays.filter((s) => s.pomo).length), 'pomos'),
        stat(fmtMinutes(sum(todays)), 'focused'),
        stat(fmtMinutes(sum(week)), 'last 7 days')),
      bars,
      todays.length
        ? h('ul', { class: 'sessions' }, ...todays.slice().reverse().slice(0, 8).map((s) =>
          h('li', {}, h('span', {}, `${s.pomo ? '🍅' : '⏱'} ${s.task || 'Focus'}`), h('span', {}, `${core.fmtTime(s.end)} · ${s.minutes}m`))))
        : h('p', { class: 'hint' }, 'Sessions you finish show up here.'));

    const numberSelect = (key, options, suffix) => {
      const sel = h('select', {
        disabled: focus.running,
        onchange: (e) => {
          focus.settings[key] = Number(e.target.value);
          if (!focus.running) focus.remaining = null;
          saveFocus();
          renderFocus();
        },
      }, ...options.map((n) => h('option', { value: n }, `${n}${suffix}`)));
      sel.value = String(focus.settings[key]);
      return sel;
    };
    const settings = h('details', { class: 'group focus-settings' },
      h('summary', { class: 'group-title' }, 'Timer settings'),
      h('label', { class: 'row' }, 'Focus', numberSelect('focus', [15, 20, 25, 30, 35, 40, 45, 50, 60, 90], ' min')),
      h('label', { class: 'row' }, 'Short break', numberSelect('short', [3, 5, 10, 15], ' min')),
      h('label', { class: 'row' }, 'Long break', numberSelect('long', [10, 15, 20, 25, 30], ' min')),
      h('label', { class: 'row' }, 'Long break every', numberSelect('every', [2, 3, 4, 5, 6], ' pomos')));

    page.replaceChildren(h('div', { class: 'focus' },
      modes,
      ring,
      h('label', { class: 'focus-task' }, h('span', {}, 'Focusing on'), taskSelect),
      buttons,
      pomo ? h('p', { class: 'hint center' }, 'You’ll get a notification when the timer ends, even if the app is closed.') : null,
      stats,
      pomo ? settings : null));
    tickFocus();
  }

  // =====================================================================
  // HABITS
  // =====================================================================
  let habitsData = { habits: [], log: {}, ...core.read(KEYS.habits, {}) };
  const saveHabits = () => save(KEYS.habits, habitsData);
  const habits = () => habitsData.habits;
  const countOn = (habit, ms) => (habitsData.log[habit.id] || {})[dayKey(ms)] || 0;
  const doneOn = (habit, ms) => countOn(habit, ms) >= habit.goal;
  const scheduledOn = (habit, ms) => habit.days.includes(new Date(ms).getDay());

  function setCount(habit, ms, n) {
    const log = (habitsData.log[habit.id] = habitsData.log[habit.id] || {});
    if (n > 0) log[dayKey(ms)] = n;
    else delete log[dayKey(ms)];
    habit.synced = false;
    saveHabits();
    syncHabit(habit);
  }

  function streak(habit) {
    let d = today();
    if (!doneOn(habit, d)) d = core.addDays(d, -1);
    const first = core.startOfDay(habit.createdAt);
    let n = 0;
    for (let i = 0; i < 3660 && d >= first; i++, d = core.addDays(d, -1)) {
      if (doneOn(habit, d)) n++;
      else if (scheduledOn(habit, d)) break;
    }
    return n;
  }

  function bestStreak(habit) {
    let best = 0;
    let run = 0;
    const end = today();
    for (let d = core.startOfDay(habit.createdAt), i = 0; d <= end && i < 3660; d = core.addDays(d, 1), i++) {
      if (doneOn(habit, d)) best = Math.max(best, ++run);
      else if (scheduledOn(habit, d) && d < end) run = 0;
    }
    return best;
  }

  function habitTimes(habit) {
    if (!habit.remind) return [];
    const now = Date.now();
    const out = [];
    for (let i = 0; i < 70 && out.length < 60; i++) {
      const d = core.addDays(today(), i);
      if (!scheduledOn(habit, d) || (i === 0 && doneOn(habit, d))) continue;
      const t = atTime(d, habit.remind);
      if (t > now) out.push(t);
    }
    return out;
  }

  async function syncHabit(habit) {
    await syncReminders(habit, [{
      id: `habit-${habit.id}`,
      times: habitTimes(habit),
      title: `${habit.emoji} ${habit.name}`,
      body: habit.goal > 1 ? `Goal today: ${habit.goal} ${habit.unit || 'times'}` : 'Time to check in',
      url: './?page=habits',
    }]);
    saveHabits();
  }

  function checkIn(habit, card) {
    const n = countOn(habit, today());
    if (n >= habit.goal) {
      setCount(habit, today(), 0);
      renderHabits();
      core.toast('Check-in removed', () => {
        setCount(habit, today(), n);
        renderHabits();
      });
      return;
    }
    setCount(habit, today(), n + 1);
    core.haptic();
    if (n + 1 >= habit.goal) {
      core.tickSound();
      const s = streak(habit);
      if (s > 1) core.toast(`🔥 ${plural(s, 'day')} in a row!`);
    }
    renderHabits();
    const again = $('page-habits').querySelector(`[data-habit="${habit.id}"] .habit-check`);
    if (again && n + 1 >= habit.goal) again.classList.add('pop');
  }

  function weekStrip(habit) {
    return h('div', { class: 'week' }, ...Array.from({ length: 7 }, (_, i) => {
      const d = core.addDays(today(), i - 6);
      const done = doneOn(habit, d);
      const partial = !done && countOn(habit, d) > 0;
      const cls = 'wd' + (done ? ' done' : partial ? ' partial' : '') + (scheduledOn(habit, d) ? '' : ' off') + (i === 6 ? ' now' : '');
      return h('button', {
        type: 'button',
        class: cls,
        'aria-label': `${new Date(d).toLocaleDateString([], { weekday: 'long' })}: ${done ? 'done' : 'not done'}`,
        onclick: () => {
          setCount(habit, d, done ? 0 : habit.goal);
          if (!done) core.haptic();
          renderHabits();
        },
      }, h('span', {}, DAY_LETTERS[new Date(d).getDay()]), h('i', {}));
    }));
  }

  function habitCard(habit) {
    const n = countOn(habit, today());
    const done = n >= habit.goal;
    const s = streak(habit);
    const sub = [];
    if (s) sub.push(`🔥 ${plural(s, 'day')}`);
    if (habit.goal > 1) sub.push(`${n}/${habit.goal} ${habit.unit || ''}`.trim());
    if (habit.remind) sub.push(`⏰ ${core.fmtTime(atTime(today(), habit.remind))}`);
    return h('li', { class: 'habit' + (done ? ' done' : ''), 'data-habit': habit.id },
      h('div', { class: 'habit-top' },
        h('button', { type: 'button', class: 'habit-emoji', onclick: () => habitDetail(habit) }, habit.emoji),
        h('button', { type: 'button', class: 'habit-main', onclick: () => habitDetail(habit) },
          h('span', { class: 'habit-name' }, habit.name),
          h('span', { class: 'habit-sub' }, sub.join(' · ') || 'Tap to see your progress')),
        h('button', {
          type: 'button',
          class: 'habit-check',
          'aria-label': done ? 'Checked in. Tap to undo' : 'Check in',
          onclick: (e) => checkIn(habit, e.currentTarget),
        }, done ? '✓' : habit.goal > 1 ? `${n}/${habit.goal}` : '')),
      weekStrip(habit));
  }

  function renderHabits() {
    const page = $('page-habits');
    if (page.hidden) return;
    const t = today();
    const dueToday = habits().filter((x) => scheduledOn(x, t));
    const other = habits().filter((x) => !scheduledOn(x, t));
    const doneCount = dueToday.filter((x) => doneOn(x, t)).length;
    const parts = [];
    if (habits().length) {
      parts.push(h('div', { class: 'progress-card' },
        h('div', {}, h('b', {}, `${doneCount} of ${dueToday.length}`), ' done today'),
        h('div', { class: 'progress' }, h('div', { style: `width:${dueToday.length ? (doneCount / dueToday.length) * 100 : 0}%` }))));
      if (dueToday.length) parts.push(h('ul', { class: 'habits' }, ...dueToday.map(habitCard)));
      if (other.length) {
        parts.push(h('h2', { class: 'section-title' }, 'Not today'));
        parts.push(h('ul', { class: 'habits off' }, ...other.map(habitCard)));
      }
    } else {
      parts.push(h('div', { class: 'empty' },
        h('p', { html: '<b>Build a habit</b><br>Drink water, read, walk, stretch. Tick it off each day and watch your streak grow.' })));
    }
    parts.push(h('button', { type: 'button', class: 'add-btn full', onclick: () => editHabit() }, '+ New habit'));
    page.replaceChildren(...parts);
  }

  const HABIT_EMOJI = ['💧', '🏃', '📚', '🧘', '💊', '🥗', '😴', '✍️', '🙏', '🎯', '🚶', '🪥'];

  function emojiPicker(input) {
    return h('div', { class: 'emoji-row' }, ...HABIT_EMOJI.concat(['🎂', '✈️', '🎉', '💍', '🎓', '🏖️']).slice(0, 12).map((e) =>
      h('button', { type: 'button', onclick: () => (input.value = e) }, e)));
  }

  function dayPicker(selected) {
    let days = selected.slice();
    const wrap = h('div', { class: 'day-picks' });
    const draw = () => wrap.replaceChildren(...DAY_LETTERS.map((l, i) =>
      h('button', {
        type: 'button',
        class: days.includes(i) ? 'on' : '',
        'aria-label': window.Recur.DAY_NAMES[i],
        onclick: () => {
          days = days.includes(i) ? days.filter((d) => d !== i) : [...days, i].sort();
          draw();
        },
      }, l)));
    draw();
    return { el: wrap, get: () => days, set: (d) => { days = d; draw(); } };
  }

  function editHabit(habit) {
    const isNew = !habit;
    const name = h('input', { class: 'field-input title-input', placeholder: 'e.g. Drink water', maxlength: 60, value: habit?.name || '' });
    const emoji = h('input', { class: 'emoji-input', maxlength: 4, value: habit?.emoji || '💧', 'aria-label': 'Emoji' });
    const days = dayPicker(habit?.days || [0, 1, 2, 3, 4, 5, 6]);
    const goal = h('input', { type: 'number', min: 1, max: 99, value: habit?.goal || 1, inputmode: 'numeric' });
    const unit = h('input', { type: 'text', placeholder: 'times', maxlength: 20, value: habit?.unit || '', class: 'tags-input' });
    const remind = h('input', { type: 'time', value: habit?.remind || '' });
    const body = [
      h('div', { class: 'name-row' }, emoji, name),
      emojiPicker(emoji),
      h('div', { class: 'group' },
        h('p', { class: 'group-title' }, 'Which days'),
        days.el,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'ghost-btn small', onclick: () => days.set([0, 1, 2, 3, 4, 5, 6]) }, 'Every day'),
          h('button', { type: 'button', class: 'ghost-btn small', onclick: () => days.set([1, 2, 3, 4, 5]) }, 'Weekdays'))),
      h('div', { class: 'group' },
        h('label', { class: 'row' }, 'Goal per day', goal),
        h('label', { class: 'row' }, 'Unit (optional)', unit),
        h('label', { class: 'row' }, 'Remind me at', remind),
        h('p', { class: 'hint' }, 'Leave the time empty for no reminder.')),
    ];
    const footer = isNew ? null : h('button', {
      type: 'button',
      class: 'danger-btn',
      onclick: () => {
        if (!confirm(`Delete “${habit.name}” and its history?`)) return;
        cancelReminders(habit);
        habitsData.habits = habits().filter((x) => x !== habit);
        delete habitsData.log[habit.id];
        saveHabits();
        dialog.close();
        renderHabits();
      },
    }, 'Delete habit');
    const dialog = sheet(isNew ? 'New habit' : 'Edit habit', body, {
      footer,
      onSave: () => {
        if (!name.value.trim()) {
          name.focus();
          return false;
        }
        if (!days.get().length) {
          core.toast('Pick at least one day');
          return false;
        }
        const h2 = habit || { id: crypto.randomUUID(), createdAt: Date.now() };
        Object.assign(h2, {
          name: name.value.trim(),
          emoji: emoji.value.trim() || '✅',
          days: days.get(),
          goal: Math.max(1, Math.min(99, parseInt(goal.value, 10) || 1)),
          unit: unit.value.trim(),
          remind: remind.value || '',
          synced: false,
        });
        if (isNew) habitsData.habits.push(h2);
        saveHabits();
        syncHabit(h2);
        renderHabits();
        if (h2.remind) core.ensurePushForReminder();
      },
    });
    if (isNew) setTimeout(() => name.focus(), 50);
  }

  function habitDetail(habit) {
    let month = new Date(today());
    month.setDate(1);
    const cal = h('div', { class: 'calendar' });
    const title = h('h3', { class: 'cal-title' });
    const statsBox = h('div', { class: 'stats' });

    function drawStats() {
      const t = today();
      const monthStart = new Date(new Date(t).getFullYear(), new Date(t).getMonth(), 1).getTime();
      let scheduled = 0;
      let done = 0;
      for (let d = Math.max(monthStart, core.startOfDay(habit.createdAt)); d <= t; d = core.addDays(d, 1)) {
        if (scheduledOn(habit, d)) {
          scheduled++;
          if (doneOn(habit, d)) done++;
        }
      }
      const total = Object.keys(habitsData.log[habit.id] || {}).filter((k) => doneOn(habit, fromDayKey(k))).length;
      const stat = (v, l) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
      statsBox.replaceChildren(
        stat(`🔥 ${streak(habit)}`, 'current streak'),
        stat(String(bestStreak(habit)), 'best streak'),
        stat(String(total), 'total days'),
        stat(scheduled ? `${Math.round((done / scheduled) * 100)}%` : '–', 'this month'));
    }

    function drawCalendar() {
      title.textContent = month.toLocaleDateString([], { month: 'long', year: 'numeric' });
      const first = month.getTime();
      const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      const cells = DAY_LETTERS.map((l) => h('span', { class: 'cal-head' }, l));
      for (let i = 0; i < month.getDay(); i++) cells.push(h('span'));
      for (let i = 0; i < daysInMonth; i++) {
        const d = core.addDays(first, i);
        const future = d > today();
        const done = doneOn(habit, d);
        const cls = 'cal-day' + (done ? ' done' : countOn(habit, d) ? ' partial' : '') + (d === today() ? ' now' : '') + (scheduledOn(habit, d) ? '' : ' off');
        cells.push(h('button', {
          type: 'button',
          class: cls,
          disabled: future,
          onclick: () => {
            setCount(habit, d, done ? 0 : habit.goal);
            drawCalendar();
            drawStats();
            renderHabits();
          },
        }, String(i + 1)));
      }
      cal.replaceChildren(...cells);
    }

    const nav = h('div', { class: 'cal-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { month.setMonth(month.getMonth() - 1); drawCalendar(); } }, '‹'),
      title,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { month.setMonth(month.getMonth() + 1); drawCalendar(); } }, '›'));
    drawStats();
    drawCalendar();
    const dialog = sheet(`${habit.emoji} ${habit.name}`, [
      h('div', { class: 'group' }, statsBox),
      h('div', { class: 'group' }, nav, cal, h('p', { class: 'hint' }, 'Tap a day to mark it done or not done.')),
    ], {
      footer: h('button', {
        type: 'button',
        class: 'ghost-btn full',
        onclick: () => {
          dialog.close();
          editHabit(habit);
        },
      }, 'Edit habit'),
    });
  }

  // =====================================================================
  // COUNTDOWNS
  // =====================================================================
  let cdData = { items: [], ...core.read(KEYS.countdowns, {}) };
  const saveCountdowns = () => save(KEYS.countdowns, cdData);

  // The date it counts to: for yearly ones, the next anniversary on or after today
  function targetDay(item, from = today()) {
    const base = fromDayKey(item.date);
    if (!item.yearly) return base;
    const b = new Date(base);
    const make = (y) => {
      const last = new Date(y, b.getMonth() + 1, 0).getDate();
      return new Date(y, b.getMonth(), Math.min(b.getDate(), last)).getTime();
    };
    let y = new Date(from).getFullYear();
    let t = make(y);
    if (t < from) t = make(++y);
    return t;
  }
  const daysBetween = (a, b) => Math.round((core.startOfDay(b) - core.startOfDay(a)) / DAY);

  function countdownTimes(item) {
    const now = Date.now();
    const time = item.time || `${String(core.settings.allDayHour ?? 9).padStart(2, '0')}:00`;
    const occurrences = [];
    let t = targetDay(item);
    occurrences.push(t);
    if (item.yearly) {
      for (let i = 0; i < 2; i++) {
        t = targetDay(item, core.addDays(t, 1));
        occurrences.push(t);
      }
    }
    if (item.countUp && !item.yearly) return [];
    const label = { 0: 'is today', 1: 'is tomorrow', 7: 'is in 1 week' };
    return (item.remind || []).map((offset) => ({
      id: `cd-${item.id}-${offset}`,
      times: occurrences.map((d) => atTime(core.addDays(d, -offset), time)).filter((x) => x > now),
      title: `${item.emoji} ${item.name} ${label[offset]}`,
      body: offset ? `${core.fmtDay(occurrences[0])}` : 'Tap to see your countdowns',
      url: './?page=countdowns',
    }));
  }

  async function syncCountdown(item) {
    await syncReminders(item, countdownTimes(item));
    saveCountdowns();
  }

  function countdownCard(item) {
    const t = today();
    const target = targetDay(item);
    const left = daysBetween(t, target);
    let big;
    let small;
    if (item.countUp) {
      const since = daysBetween(fromDayKey(item.date), t);
      big = String(Math.abs(since));
      small = since >= 0 ? (since === 1 ? 'day since' : 'days since') : 'days to go';
    } else if (left === 0) {
      big = '🎉';
      small = 'Today!';
    } else {
      big = String(Math.abs(left));
      small = left > 0 ? (left === 1 ? 'day left' : 'days left') : (left === -1 ? 'day ago' : 'days ago');
    }
    const when = new Date(target).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(target).getFullYear() === new Date(t).getFullYear() ? undefined : 'numeric' });
    const extra = [];
    if (item.yearly) {
      const years = new Date(target).getFullYear() - new Date(fromDayKey(item.date)).getFullYear();
      extra.push(years > 0 ? `turns ${years}` : 'every year');
      if (item.countUp) extra.push(left === 0 ? 'anniversary today' : `next in ${plural(left, 'day')}`);
    }
    if (item.time) extra.push(core.fmtTime(atTime(target, item.time)));
    return h('li', { class: 'cd' + (left === 0 && !item.countUp ? ' today' : left < 0 && !item.countUp ? ' past' : '') },
      h('button', { type: 'button', onclick: () => editCountdown(item) },
        h('span', { class: 'cd-emoji' }, item.emoji),
        h('span', { class: 'cd-main' }, h('span', { class: 'cd-name' }, item.name), h('span', { class: 'cd-when' }, [when, ...extra].join(' · '))),
        h('span', { class: 'cd-count' }, h('b', {}, big), h('span', {}, small))));
  }

  function renderCountdowns() {
    const page = $('page-countdowns');
    if (page.hidden) return;
    const t = today();
    const items = cdData.items.slice().sort((a, b) => {
      const la = daysBetween(t, targetDay(a));
      const lb = daysBetween(t, targetDay(b));
      if ((la < 0) !== (lb < 0)) return la < 0 ? 1 : -1;
      return la < 0 ? lb - la : la - lb;
    });
    const parts = [];
    if (items.length) parts.push(h('ul', { class: 'countdowns' }, ...items.map(countdownCard)));
    else {
      parts.push(h('div', { class: 'empty' },
        h('p', { html: '<b>Count down to what matters</b><br>Birthdays, trips, exams, paydays. Or count up the days since something started.' })));
    }
    parts.push(h('button', { type: 'button', class: 'add-btn full', onclick: () => editCountdown() }, '+ New countdown'));
    page.replaceChildren(...parts);
  }

  function editCountdown(item) {
    const isNew = !item;
    const name = h('input', { class: 'field-input title-input', placeholder: 'e.g. Mum’s birthday', maxlength: 60, value: item?.name || '' });
    const emoji = h('input', { class: 'emoji-input', maxlength: 4, value: item?.emoji || '🎉', 'aria-label': 'Emoji' });
    const date = h('input', { type: 'date', value: item?.date || dayKey(core.addDays(today(), 7)) });
    const time = h('input', { type: 'time', value: item?.time || '' });
    const yearly = h('input', { type: 'checkbox', checked: !!item?.yearly });
    let countUp = !!item?.countUp;
    const typeSeg = h('div', { class: 'segmented' });
    const drawType = () => typeSeg.replaceChildren(
      h('button', { type: 'button', class: countUp ? '' : 'on', onclick: () => { countUp = false; drawType(); } }, 'Days until'),
      h('button', { type: 'button', class: countUp ? 'on' : '', onclick: () => { countUp = true; drawType(); } }, 'Days since'));
    drawType();
    const remind = item?.remind || [0, 1];
    const box = (offset, label) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', 'data-offset': offset, checked: remind.includes(offset) }), label);
    const remindGroup = h('div', { class: 'group' },
      h('p', { class: 'group-title' }, 'Remind me'),
      box(0, 'On the day'),
      box(1, '1 day before'),
      box(7, '1 week before'));
    const emojiRow = h('div', { class: 'emoji-row' }, ...['🎉', '🎂', '✈️', '🏖️', '💍', '🎓', '💰', '📝', '🏥', '🎄', '❤️', '⚽'].map((e) =>
      h('button', { type: 'button', onclick: () => (emoji.value = e) }, e)));
    const body = [
      h('div', { class: 'name-row' }, emoji, name),
      emojiRow,
      h('div', { class: 'group' },
        h('div', { class: 'row' }, 'Count', typeSeg),
        h('label', { class: 'row' }, 'Date', date),
        h('label', { class: 'row' }, 'Time (optional)', time),
        h('label', { class: 'check-row' }, yearly, 'Repeats every year (birthdays, anniversaries)')),
      remindGroup,
    ];
    const footer = isNew ? null : h('button', {
      type: 'button',
      class: 'danger-btn',
      onclick: () => {
        if (!confirm(`Delete “${item.name}”?`)) return;
        cancelReminders(item);
        cdData.items = cdData.items.filter((x) => x !== item);
        saveCountdowns();
        dialog.close();
        renderCountdowns();
      },
    }, 'Delete countdown');
    const dialog = sheet(isNew ? 'New countdown' : 'Edit countdown', body, {
      footer,
      onSave: () => {
        if (!name.value.trim()) {
          name.focus();
          return false;
        }
        if (!date.value) {
          core.toast('Pick a date');
          return false;
        }
        const it = item || { id: crypto.randomUUID(), createdAt: Date.now() };
        Object.assign(it, {
          name: name.value.trim(),
          emoji: emoji.value.trim() || '🎉',
          date: date.value,
          time: time.value || '',
          yearly: yearly.checked,
          countUp,
          remind: [...remindGroup.querySelectorAll('input:checked')].map((x) => Number(x.dataset.offset)),
          synced: false,
        });
        if (isNew) cdData.items.push(it);
        saveCountdowns();
        syncCountdown(it);
        renderCountdowns();
        if (it.remind.length) core.ensurePushForReminder();
      },
    });
    if (isNew) setTimeout(() => name.focus(), 50);
  }

  // =====================================================================
  // PAGES
  // =====================================================================
  let page = localStorage.getItem(KEYS.page) || 'tasks';

  function showPage(p) {
    if (!TITLES[p]) p = 'tasks';
    page = p;
    localStorage.setItem(KEYS.page, p);
    document.body.dataset.page = p;
    for (const key of Object.keys(TITLES)) $(`page-${key}`).hidden = key !== p;
    for (const b of document.querySelectorAll('.bottom-nav button')) b.classList.toggle('on', b.dataset.page === p);
    if (p !== 'tasks') $('view-title').textContent = TITLES[p];
    core.render();
    renderPage();
    window.scrollTo(0, 0);
  }

  function renderPage() {
    if (page === 'focus') renderFocus();
    if (page === 'habits') renderHabits();
    if (page === 'countdowns') renderCountdowns();
  }

  for (const b of document.querySelectorAll('.bottom-nav button')) b.addEventListener('click', () => showPage(b.dataset.page));

  async function syncAll(force = false) {
    const now = Date.now();
    const stale = (item) => force || !item.synced || now - (item.syncedAt || 0) > DAY;
    for (const habit of habits()) if (stale(habit)) await syncHabit(habit);
    for (const item of cdData.items) if (stale(item)) await syncCountdown(item);
    if (force) await scheduleFocusPush();
  }

  function reload() {
    habitsData = { habits: [], log: {}, ...core.read(KEYS.habits, {}) };
    cdData = { items: [], ...core.read(KEYS.countdowns, {}) };
    focus = { ...focusDefaults, ...core.read(KEYS.focus, {}) };
    focus.settings = { ...focusDefaults.settings, ...focus.settings };
    for (const x of [...habits(), ...cdData.items]) {
      x.synced = false;
      x.serverIds = [];
    }
    renderPage();
    syncAll(true);
  }

  // A timer that ended while the app was closed
  if (focus.mode === 'pomo' && focus.running && focus.endAt && Date.now() >= focus.endAt) focusComplete();
  if (focus.running) keepAwake(true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (focus.running) {
      keepAwake(true);
      tickFocus();
    }
    renderPage();
  });
  // Day changes: refresh streaks and countdowns
  let lastDay = today();
  setInterval(() => {
    if (today() !== lastDay) {
      lastDay = today();
      renderPage();
    }
  }, 60000);

  window.TodoExtras = { showPage, syncAll, reload };
  showPage(page);
  // Push subscription is ready a moment after load
  setTimeout(() => syncAll(), 2000);
})();
