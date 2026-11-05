(() => {
  const { serverUrl, vapidPublicKey } = window.TODO_CONFIG;
  const { Recur, Parse } = window;
  const KEYS = {
    tasks: 'todo.tasks.v1',
    lists: 'todo.lists.v1',
    settings: 'todo.settings.v1',
    view: 'todo.view',
    endpoint: 'todo.pushEndpoint',
    backup: 'todo.lastBackup',
  };
  // Saved by extras.js; included in backups
  const EXTRA_KEYS = ['todo.habits.v1', 'todo.countdowns.v1', 'todo.focus.v1'];
  const DAY = 86400000;
  const $ = (id) => document.getElementById(id);

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // ---------- storage ----------
  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // Fills in fields added since the first version (which only had `remindAt`)
  function migrate(t) {
    if ('remindAt' in t) {
      t.due = t.remindAt;
      t.allDay = false;
      t.scheduled = t.remindAt != null;
      delete t.remindAt;
    }
    return {
      list: null, priority: 0, tags: [], notes: '', subtasks: [], repeat: null, nag: 0,
      snoozedUntil: null, due: null, allDay: true, done: false, scheduled: false, ...t,
    };
  }

  let tasks = read(KEYS.tasks, []).map(migrate);
  let lists = read(KEYS.lists, []);
  let settings = { allDayHour: 9, sound: true, ...read(KEYS.settings, {}) };
  let view = localStorage.getItem(KEYS.view) || 'today';
  let registration = null;

  function save() {
    localStorage.setItem(KEYS.tasks, JSON.stringify(tasks));
    localStorage.setItem(KEYS.lists, JSON.stringify(lists));
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  }
  const find = (id) => tasks.find((t) => t.id === id);
  const listById = (id) => lists.find((l) => l.id === id);
  const snapshot = () => JSON.parse(JSON.stringify({ tasks, lists }));

  // ---------- dates ----------
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const addDays = (ms, n) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function fmtDay(ms) {
    const d = new Date(ms);
    const diff = Math.round((startOfDay(ms) - startOfDay(Date.now())) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  }
  const fmtDue = (ms, allDay) => (allDay ? fmtDay(ms) : `${fmtDay(ms)} ${fmtTime(ms)}`);
  const toDateInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const toTimeInput = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const toLocalInput = (ms) => `${toDateInput(ms)}T${toTimeInput(ms)}`;

  // When the phone should actually buzz for a given due date
  function alertTime(due, allDay) {
    if (!allDay) return due;
    if (settings.allDayHour == null) return null;
    const d = new Date(due);
    d.setHours(settings.allDayHour, 0, 0, 0);
    return d.getTime();
  }

  // ---------- views ----------
  function viewList() {
    return [
      { id: 'today', name: 'Today' },
      { id: 'upcoming', name: 'Upcoming' },
      { id: 'inbox', name: 'Inbox' },
      ...lists.map((l) => ({ id: `list:${l.id}`, name: l.name })),
      { id: 'all', name: 'All' },
    ];
  }
  const active = () => tasks.filter((t) => !t.done);
  const endOfToday = () => addDays(startOfDay(Date.now()), 1);
  const inView = (t, v) => {
    if (v === 'today') return t.due != null && t.due < endOfToday();
    if (v === 'upcoming') return t.due != null;
    if (v === 'inbox') return !t.list;
    if (v === 'all') return true;
    return t.list === v.slice(5);
  };

  function byDue(a, b) {
    if (a.due != null && b.due != null && a.due !== b.due) return a.due - b.due;
    if (a.due != null && b.due == null) return -1;
    if (b.due != null && a.due == null) return 1;
    return (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt;
  }

  function sections() {
    const open = active().filter((t) => inView(t, view)).sort(byDue);
    const today = startOfDay(Date.now());
    const overdue = open.filter((t) => t.due != null && t.due < today);
    const moveAll = { label: 'Move to today', run: () => moveToToday(overdue) };

    if (view === 'today') {
      const due = open.filter((t) => t.due >= today);
      if (!overdue.length) return [{ tasks: due }];
      return [{ title: 'Overdue', late: true, tasks: overdue, action: moveAll }, { title: 'Today', tasks: due }];
    }
    if (view === 'upcoming') {
      const out = overdue.length ? [{ title: 'Overdue', late: true, tasks: overdue, action: moveAll }] : [];
      for (let i = 0; i < 7; i++) {
        const day = addDays(today, i);
        const dayTasks = open.filter((t) => t.due >= day && t.due < addDays(day, 1));
        if (dayTasks.length) {
          const label = i < 2 ? fmtDay(day) : new Date(day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
          out.push({ title: label, tasks: dayTasks });
        }
      }
      const later = open.filter((t) => t.due >= addDays(today, 7));
      if (later.length) out.push({ title: 'Later', tasks: later });
      return out;
    }
    return [{ tasks: open }];
  }

  function emptyMessage() {
    if (view === 'today') {
      const undated = active().filter((t) => t.due == null).length;
      return `Nothing due today. Enjoy it.${undated ? `<br><b>${undated}</b> without a date in Inbox and your lists.` : ''}`;
    }
    if (view === 'upcoming') return 'Nothing scheduled. Add a date like “friday 3pm”.';
    return 'Nothing here yet.';
  }

  // ---------- rendering ----------
  const icons = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm12 8v10H5V10h14Z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>',
  };

  function span(cls, text, html = '') {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.innerHTML = html;
    el.append(text);
    return el;
  }

  function renderItem(task) {
    const li = document.createElement('li');
    li.className = 'item' + (task.done ? ' done' : '');
    li.dataset.p = task.priority || 0;

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
    check.innerHTML = icons.check;
    check.onclick = () => toggle(task, li);

    const body = document.createElement('button');
    body.className = 'body';
    body.type = 'button';
    body.onclick = () => openEdit(task.id);
    body.append(span('title', task.text));

    const meta = document.createElement('span');
    meta.className = 'meta';
    const now = Date.now();
    if (task.snoozedUntil && task.snoozedUntil > now && !task.done) {
      meta.append(span('due', `Snoozed · ${fmtDue(task.snoozedUntil, false)}`, icons.bell));
    } else if (task.due != null) {
      const late = task.allDay ? task.due < startOfDay(now) : task.due < now;
      const cls = 'due' + (late ? (task.done ? ' past' : ' late') : '');
      meta.append(span(cls, fmtDue(task.due, task.allDay), task.allDay ? icons.cal : icons.bell));
    }
    if (task.repeat) meta.append(span('', `↻ ${Recur.describe(task.repeat)}`));
    if (task.nag) meta.append(span('', '🔁 Nag'));
    if (task.list && !view.startsWith('list:')) meta.append(span('', `☰ ${listById(task.list)?.name || 'List'}`));
    if (task.subtasks.length) meta.append(span('', `☑ ${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}`));
    if (task.notes) meta.append(span('', '✎ Note'));
    for (const tag of task.tags) meta.append(span('tag', `@${tag}`));
    if (meta.childNodes.length) body.append(meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete');
    del.textContent = '×';
    del.onclick = () => remove(task);

    li.append(check, body, del);
    return li;
  }

  function renderTabs() {
    const nav = $('tabs');
    const counts = (id) => active().filter((t) => inView(t, id)).length;
    const buttons = viewList().map((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (v.id === view ? ' on' : '');
      b.textContent = v.name;
      const n = counts(v.id);
      if (n && v.id !== 'all') b.append(span('n', String(n)));
      b.onclick = () => setView(v.id);
      return b;
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab new';
    add.textContent = '+ List';
    add.onclick = newList;
    nav.replaceChildren(...buttons, add);
    nav.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function render() {
    if (!viewList().some((v) => v.id === view)) view = 'today';
    const current = viewList().find((v) => v.id === view);
    $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const onTasks = (document.body.dataset.page || 'tasks') === 'tasks';
    if (onTasks) $('view-title').textContent = current.name;
    $('list-menu').hidden = !onTasks || !view.startsWith('list:');
    renderTabs();

    const content = $('content');
    const secs = sections();
    const parts = [];
    for (const s of secs) {
      if (!s.tasks.length) continue;
      const wrap = document.createElement('section');
      wrap.className = 'section';
      if (s.title) {
        const head = document.createElement('div');
        head.className = 'section-head';
        const h = document.createElement('h2');
        h.textContent = s.title;
        if (s.late) h.className = 'late';
        head.append(h);
        if (s.action) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'link-btn';
          b.textContent = s.action.label;
          b.onclick = s.action.run;
          head.append(b);
        }
        wrap.append(head);
      }
      const ul = document.createElement('ul');
      ul.className = 'list';
      ul.append(...s.tasks.map(renderItem));
      wrap.append(ul);
      parts.push(wrap);
    }
    if (!parts.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.innerHTML = emptyMessage();
      parts.push(p);
    }
    content.replaceChildren(...parts);

    // Completed tasks for this view (Today shows the ones finished today)
    const done = tasks
      .filter((t) => t.done && (view === 'today' ? t.doneAt >= startOfDay(Date.now()) : view !== 'upcoming' && inView(t, view)))
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $('done-list').replaceChildren(...done.map(renderItem));
    $('done-wrap').hidden = done.length === 0;
    $('done-title').textContent = `Completed (${done.length})`;
  }

  function setView(id) {
    view = id;
    localStorage.setItem(KEYS.view, id);
    render();
    updatePreview();
  }

  // ---------- feedback: toast, sound, haptics ----------
  let undoFn = null;
  function toast(message, undo) {
    $('toast-text').textContent = message;
    $('toast-undo').hidden = !undo;
    undoFn = undo || null;
    $('toast').classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      $('toast').classList.remove('show');
      undoFn = null;
    }, undo ? 5000 : 3000);
  }
  $('toast-undo').onclick = () => {
    const fn = undoFn;
    undoFn = null;
    $('toast').classList.remove('show');
    if (fn) fn();
  };

  let audio;
  function tickSound() {
    if (!settings.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      [880, 1318].forEach((freq, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        const start = t + i * 0.07;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        osc.connect(gain).connect(audio.destination);
        osc.start(start);
        osc.stop(start + 0.22);
      });
    } catch {
      /* sound is optional */
    }
  }

  // iPhones have no vibration API; tapping a hidden iOS "switch" control gives a light tap instead
  function haptic() {
    try {
      if (navigator.vibrate) return navigator.vibrate(12);
      const label = document.createElement('label');
      label.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.append(input);
      document.body.append(label);
      label.click();
      label.remove();
    } catch {
      /* optional */
    }
  }

  // ---------- task actions ----------
  function commit(ids) {
    for (const id of ids) {
      const t = find(id);
      if (t) t.synced = false;
    }
    save();
    render();
    for (const id of ids) {
      const t = find(id);
      if (t) syncTask(t);
    }
  }

  function restore(before, ids) {
    const removedIds = tasks.filter((t) => !before.tasks.some((b) => b.id === t.id)).map((t) => t.id);
    tasks = before.tasks;
    lists = before.lists;
    commit(ids);
    for (const id of removedIds) cancelReminder(id);
  }

  function toggle(task, li) {
    const before = snapshot();
    if (task.done) {
      task.done = false;
      task.doneAt = null;
      commit([task.id]);
      return;
    }
    haptic();
    tickSound();
    li.classList.add('ticked');
    setTimeout(() => {
      li.classList.add('leaving');
      let message = 'Done';
      if (task.repeat && task.due != null) {
        task.due = Recur.nextAfterCompletion(task.repeat, task.due, Date.now(), task.allDay);
        if (task.repeat.after) task.repeat.anchor = task.due;
        task.subtasks.forEach((s) => (s.done = false));
        message = `Next: ${fmtDue(task.due, task.allDay)}`;
      } else {
        task.done = true;
        task.doneAt = Date.now();
      }
      task.snoozedUntil = null;
      setTimeout(() => {
        commit([task.id]);
        toast(message, () => restore(before, [task.id]));
      }, 220);
    }, 280);
  }

  function remove(task) {
    const before = snapshot();
    tasks = tasks.filter((t) => t.id !== task.id);
    save();
    render();
    cancelReminder(task.id);
    toast('Task deleted', () => restore(before, [task.id]));
  }

  function moveToToday(list) {
    const before = snapshot();
    const today = startOfDay(Date.now());
    for (const t of list) {
      if (t.allDay) t.due = today;
      else {
        const d = new Date(t.due);
        const n = new Date(today);
        n.setHours(d.getHours(), d.getMinutes(), 0, 0);
        t.due = n.getTime();
      }
      t.snoozedUntil = null;
    }
    commit(list.map((t) => t.id));
    toast(`Moved ${list.length} to today`, () => restore(before, list.map((t) => t.id)));
  }

  $('clear-done').addEventListener('click', () => {
    const before = snapshot();
    const cleared = tasks.filter((t) => t.done && (view === 'today' || inView(t, view)));
    tasks = tasks.filter((t) => !cleared.includes(t));
    save();
    render();
    toast(`Cleared ${cleared.length}`, () => restore(before, []));
  });

  // ---------- lists ----------
  function ensureList(name) {
    const existing = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const list = { id: crypto.randomUUID(), name: name.trim() };
    lists.push(list);
    return list;
  }

  function newList() {
    const name = prompt('New list name');
    if (!name || !name.trim()) return;
    const list = ensureList(name);
    save();
    setView(`list:${list.id}`);
  }

  $('list-menu').addEventListener('click', () => {
    const list = listById(view.slice(5));
    if (!list) return;
    actionSheet(list.name, [
      {
        label: 'Rename list',
        run: () => {
          const name = prompt('Rename list', list.name);
          if (name && name.trim()) {
            list.name = name.trim();
            save();
            render();
          }
        },
      },
      {
        label: 'Delete list',
        danger: true,
        run: () => {
          const count = tasks.filter((t) => t.list === list.id).length;
          if (!confirm(`Delete “${list.name}”?${count ? ` Its ${count} task${count > 1 ? 's' : ''} will move to Inbox.` : ''}`)) return;
          const before = snapshot();
          const moved = tasks.filter((t) => t.list === list.id);
          moved.forEach((t) => (t.list = null));
          lists = lists.filter((l) => l !== list);
          setView('inbox');
          commit(moved.map((t) => t.id));
          toast('List deleted', () => {
            restore(before, moved.map((t) => t.id));
            setView(`list:${list.id}`);
          });
        },
      },
    ]);
  });

  function actionSheet(title, actions) {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    const form = document.createElement('form');
    form.method = 'dialog';
    const head = document.createElement('div');
    head.className = 'sheet-head';
    const h = document.createElement('h2');
    h.textContent = title;
    const close = document.createElement('button');
    close.className = 'link-btn strong';
    close.textContent = 'Close';
    head.append(document.createElement('span'), h, close);
    form.append(head);
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.danger ? 'danger-btn' : 'ghost-btn';
      b.style.cssText = 'width:100%;margin-bottom:10px';
      b.textContent = a.label;
      b.onclick = () => {
        dialog.close();
        a.run();
      };
      form.append(b);
    }
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // ---------- add form ----------
  const textInput = $('text');
  const whenInput = $('when');
  let parsed = null;

  function pill(text) {
    return span('pill', text);
  }

  function draftFromInput() {
    const raw = textInput.value.trim();
    if (!raw) return null;
    const p = Parse.parse(raw);
    const manual = whenInput.value ? new Date(whenInput.value).getTime() : null;
    const task = {
      text: p.title || raw,
      due: manual ?? p.due,
      allDay: manual ? false : p.allDay,
      repeat: p.repeat,
      priority: p.priority,
      tags: p.tags,
      listName: p.list,
    };
    if (manual && task.repeat) task.repeat.anchor = manual;
    // Adding from Today/Upcoming without a date puts it on that day
    if (task.due == null && view === 'today') task.due = startOfDay(Date.now());
    if (task.due == null && view === 'upcoming') task.due = addDays(startOfDay(Date.now()), 1);
    if (!task.listName && view.startsWith('list:')) task.listName = listById(view.slice(5))?.name;
    return task;
  }

  function updatePreview() {
    const box = $('preview');
    parsed = draftFromInput();
    const pills = [];
    if (parsed) {
      if (parsed.due != null) pills.push(pill(fmtDue(parsed.due, parsed.allDay)));
      if (parsed.repeat) pills.push(pill(`↻ ${Recur.describe(parsed.repeat)}`));
      if (parsed.listName && !(view.startsWith('list:') && listById(view.slice(5))?.name === parsed.listName)) {
        const exists = lists.some((l) => l.name.toLowerCase() === parsed.listName.toLowerCase());
        pills.push(pill(`☰ ${parsed.listName}${exists ? '' : ' (new list)'}`));
      }
      if (parsed.priority) pills.push(pill(['', 'Low', 'Medium', 'High'][parsed.priority] + ' priority'));
      for (const tag of parsed.tags) pills.push(pill(`@${tag}`));
      if (pills.length && parsed.text !== textInput.value.trim()) pills.unshift(pill(`“${parsed.text}”`));
    }
    box.replaceChildren(...pills);
    const manual = whenInput.value ? new Date(whenInput.value).getTime() : null;
    $('when-label').textContent = manual ? fmtDue(manual, false) : 'Pick date';
    whenInput.parentElement.classList.toggle('set', !!manual);
  }

  textInput.addEventListener('input', updatePreview);
  whenInput.addEventListener('focus', () => {
    if (!whenInput.value) {
      const d = new Date(Date.now() + 3600000);
      d.setMinutes(0, 0, 0);
      whenInput.value = toLocalInput(d.getTime());
      updatePreview();
    }
  });
  whenInput.addEventListener('input', updatePreview);
  whenInput.addEventListener('change', updatePreview);

  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    const draft = draftFromInput();
    if (!draft) return textInput.focus();
    const list = draft.listName ? ensureList(draft.listName) : null;
    const task = migrate({
      id: crypto.randomUUID(),
      text: draft.text,
      due: draft.due,
      allDay: draft.allDay,
      repeat: draft.repeat,
      priority: draft.priority,
      tags: draft.tags,
      list: list ? list.id : null,
      createdAt: Date.now(),
    });
    tasks.push(task);
    textInput.value = '';
    whenInput.value = '';
    commit([task.id]);
    updatePreview();
    if (!inView(task, view)) {
      const where = task.due != null && task.due < endOfToday() ? 'Today' : list ? list.name : task.due != null ? 'Upcoming' : 'Inbox';
      toast(`Added to ${where}`);
    }
    if (task.due != null && alertTime(task.due, task.allDay) != null) ensurePushForReminder();
  });

  // ---------- edit sheet ----------
  const editDialog = $('edit');
  let editing = null; // the task being edited
  let draft = null; // a working copy of it

  function setPriority(p) {
    draft.priority = p;
    for (const b of $('edit-priority').children) b.classList.toggle('on', Number(b.dataset.p) === p);
  }
  for (const b of $('edit-priority').children) b.onclick = () => setPriority(Number(b.dataset.p));

  // Weekday buttons for custom repeats
  let repDays = [];
  const dayPicks = $('rep-days');
  'SMTWTFS'.split('').forEach((letter, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = letter;
    b.setAttribute('aria-label', Recur.DAY_NAMES[i]);
    b.onclick = () => {
      repDays = repDays.includes(i) ? repDays.filter((d) => d !== i) : [...repDays, i].sort();
      b.classList.toggle('on', repDays.includes(i));
    };
    dayPicks.append(b);
  });
  function showRepDays() {
    [...dayPicks.children].forEach((b, i) => b.classList.toggle('on', repDays.includes(i)));
    dayPicks.hidden = $('rep-unit').value !== 'week';
  }

  function repeatPreset(rule, due) {
    if (!rule) return '';
    const days = (rule.days || []).join();
    const n = rule.interval || 1;
    if (rule.after) return 'custom';
    if (rule.freq === 'day' && n === 1) return 'day';
    if (rule.freq === 'week' && n === 1 && days === '1,2,3,4,5') return 'weekdays';
    const plainWeek = !days || (due != null && days === String(new Date(due).getDay()));
    if (rule.freq === 'week' && n === 1 && plainWeek) return 'week';
    if (rule.freq === 'week' && n === 2 && plainWeek) return 'week2';
    if (rule.freq === 'month' && n === 1) return 'month';
    if (rule.freq === 'year' && n === 1) return 'year';
    return 'custom';
  }

  function readRepeat() {
    const v = $('edit-repeat').value;
    switch (v) {
      case '': return null;
      case 'day': return { freq: 'day', interval: 1 };
      case 'weekdays': return { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] };
      case 'week': return { freq: 'week', interval: 1 };
      case 'week2': return { freq: 'week', interval: 2 };
      case 'month': return { freq: 'month', interval: 1 };
      case 'year': return { freq: 'year', interval: 1 };
      default: {
        const freq = $('rep-unit').value;
        return {
          freq,
          interval: Math.max(1, Math.min(99, parseInt($('rep-n').value, 10) || 1)),
          days: freq === 'week' && repDays.length ? repDays.slice() : undefined,
          after: $('rep-after').checked,
        };
      }
    }
  }

  $('edit-repeat').addEventListener('change', () => {
    $('custom-repeat').hidden = $('edit-repeat').value !== 'custom';
    showRepDays();
  });
  $('rep-unit').addEventListener('change', showRepDays);
  $('edit-nag').addEventListener('change', () => ($('nag-hint').hidden = $('edit-nag').value === '0'));

  function fillListSelect(selected) {
    const sel = $('edit-list');
    const opts = [['', 'Inbox'], ...lists.map((l) => [l.id, l.name]), ['__new', '+ New list…']];
    sel.replaceChildren(...opts.map(([value, label]) => new Option(label, value, false, value === (selected || ''))));
  }
  $('edit-list').addEventListener('change', (e) => {
    if (e.target.value !== '__new') return;
    const name = prompt('New list name');
    if (name && name.trim()) {
      const list = ensureList(name);
      save();
      fillListSelect(list.id);
    } else fillListSelect(draft.list);
  });

  function renderSteps() {
    const ul = $('steps');
    ul.replaceChildren(...draft.subtasks.map((s) => {
      const li = document.createElement('li');
      li.className = 'step' + (s.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.done;
      cb.setAttribute('aria-label', 'Step done');
      cb.onchange = () => {
        s.done = cb.checked;
        li.classList.toggle('done', s.done);
        if (s.done) haptic();
      };
      const input = document.createElement('input');
      input.type = 'text';
      input.value = s.text;
      input.setAttribute('aria-label', 'Step');
      input.oninput = () => (s.text = input.value);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Remove step');
      del.onclick = () => {
        draft.subtasks = draft.subtasks.filter((x) => x !== s);
        renderSteps();
      };
      li.append(cb, input, del);
      return li;
    }));
  }
  $('new-step').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    draft.subtasks.push({ id: crypto.randomUUID(), text, done: false });
    e.target.value = '';
    renderSteps();
  });

  function openEdit(id, { fromNotification = false } = {}) {
    editing = find(id);
    if (!editing) return;
    draft = JSON.parse(JSON.stringify(editing));
    $('edit-text').value = draft.text;
    $('edit-notes').value = draft.notes || '';
    $('new-step').value = '';
    renderSteps();
    $('edit-date').value = draft.due != null ? toDateInput(draft.due) : '';
    $('edit-time').value = draft.due != null && !draft.allDay ? toTimeInput(draft.due) : '';
    const preset = repeatPreset(draft.repeat, draft.due);
    $('edit-repeat').value = preset;
    $('custom-repeat').hidden = preset !== 'custom';
    $('rep-n').value = draft.repeat?.interval || 1;
    $('rep-unit').value = draft.repeat?.freq || 'day';
    $('rep-after').checked = !!draft.repeat?.after;
    repDays = draft.repeat?.days ? draft.repeat.days.slice() : [];
    showRepDays();
    $('edit-nag').value = String(draft.nag || 0);
    $('nag-hint').hidden = !draft.nag;
    fillListSelect(draft.list);
    setPriority(draft.priority || 0);
    $('edit-tags').value = draft.tags.join(', ');

    const alertAt = draft.due != null ? alertTime(draft.due, draft.allDay) : null;
    const due = (alertAt != null && alertAt <= Date.now()) || (draft.snoozedUntil && draft.snoozedUntil > Date.now());
    $('snooze').hidden = draft.done || !(fromNotification || due);
    $('snooze-title').textContent = draft.snoozedUntil > Date.now() ? `Snoozed until ${fmtDue(draft.snoozedUntil, false)}. Snooze again:` : 'Snooze this reminder';
    editDialog.showModal();
    if (!fromNotification) editDialog.querySelector('.sheet-head .link-btn').focus();
  }

  editDialog.querySelector('[data-close]').onclick = () => editDialog.close();

  $('edit-form').addEventListener('submit', () => {
    const task = editing;
    if (!task || !find(task.id)) return;
    const before = snapshot();
    const text = $('edit-text').value.trim();
    if (text) task.text = text;
    task.notes = $('edit-notes').value.trim();
    task.subtasks = draft.subtasks.filter((s) => s.text.trim());
    task.priority = draft.priority;
    task.tags = $('edit-tags').value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
    const listValue = $('edit-list').value;
    task.list = listValue && listValue !== '__new' ? listValue : null;
    task.nag = Number($('edit-nag').value) || 0;

    let due = null;
    let allDay = true;
    const dateValue = $('edit-date').value;
    const timeValue = $('edit-time').value;
    if (dateValue || timeValue) {
      const [y, m, d] = (dateValue || toDateInput(Date.now())).split('-').map(Number);
      const date = new Date(y, m - 1, d);
      if (timeValue) {
        const [h, min] = timeValue.split(':').map(Number);
        date.setHours(h, min, 0, 0);
        allDay = false;
      }
      due = date.getTime();
    }
    const rule = readRepeat();
    if (rule && due == null) due = startOfDay(Date.now());
    if (rule) {
      due = Recur.firstOnOrAfter(rule, due);
      const sameRule = task.repeat && JSON.stringify({ ...task.repeat, anchor: 0 }) === JSON.stringify({ ...rule, anchor: 0 });
      rule.anchor = sameRule && due === task.due ? task.repeat.anchor ?? due : due;
    }
    if (due !== task.due || allDay !== task.allDay) task.snoozedUntil = null;
    task.due = due;
    task.allDay = allDay;
    task.repeat = rule;
    commit([task.id]);
    toast('Saved', () => restore(before, [task.id]));
    if (task.due != null && alertTime(task.due, task.allDay) != null) ensurePushForReminder();
  });

  for (const b of document.querySelectorAll('[data-snooze]')) {
    b.addEventListener('click', () => {
      const task = editing;
      if (!task) return;
      const now = Date.now();
      const kind = b.dataset.snooze;
      let until;
      if (kind === 'evening') {
        const d = new Date(now);
        d.setHours(18, 0, 0, 0);
        until = d.getTime() - now > 30 * 60000 ? d.getTime() : now + 3 * 3600000;
      } else if (kind === 'tomorrow') {
        const d = new Date(addDays(startOfDay(now), 1));
        const ref = task.due != null && !task.allDay ? new Date(task.due) : null;
        d.setHours(ref ? ref.getHours() : settings.allDayHour ?? 9, ref ? ref.getMinutes() : 0, 0, 0);
        until = d.getTime();
      } else until = now + Number(kind) * 60000;
      const before = snapshot();
      task.snoozedUntil = until;
      editDialog.close();
      commit([task.id]);
      toast(`Snoozed until ${fmtDue(until, false)}`, () => restore(before, [task.id]));
    });
  }

  $('delete-task').addEventListener('click', () => {
    const task = editing;
    editDialog.close();
    if (task) remove(task);
  });

  // ---------- push notifications ----------
  function base64UrlToBytes(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  async function currentSubscription() {
    if (!registration) return null;
    return registration.pushManager.getSubscription();
  }

  async function api(path, data) {
    const res = await fetch(serverUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Server said ${res.status}`);
    return res.json();
  }

  // Every upcoming time this task should notify (repeats are worked out here, in the phone's time zone)
  function reminderTimes(task, now = Date.now()) {
    if (task.done || task.due == null) return [];
    const occurrences = task.repeat
      ? Recur.occurrences(task.due, task.repeat, { from: startOfDay(now) - DAY, count: 60, until: now + 400 * DAY })
      : [task.due];
    let times = occurrences.map((t) => alertTime(t, task.allDay)).filter((t) => t != null && t > now);
    if (task.snoozedUntil && task.snoozedUntil > now) times = [task.snoozedUntil, ...times];
    return [...new Set(times)].sort((a, b) => a - b).slice(0, 60);
  }

  function notificationBody(task) {
    const parts = [];
    if (task.list) parts.push(listById(task.list)?.name);
    if (task.subtasks.length) parts.push(`${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length} steps done`);
    if (task.notes) parts.push(task.notes.split('\n')[0].slice(0, 80));
    return parts.filter(Boolean).join(' · ') || 'Tap to open';
  }

  async function syncTask(task) {
    const sub = await currentSubscription();
    if (!sub) return;
    const times = reminderTimes(task);
    try {
      if (!times.length) {
        if (task.scheduled) await api('/cancel', { id: task.id, endpoint: sub.endpoint });
        task.scheduled = false;
      } else {
        await api('/schedule', {
          id: task.id,
          times,
          title: task.text,
          body: notificationBody(task),
          url: `./?task=${encodeURIComponent(task.id)}`,
          nag: task.nag || 0,
          subscription: sub.toJSON(),
        });
        task.scheduled = true;
      }
      task.synced = true;
      task.syncedAt = Date.now();
      save();
    } catch (err) {
      console.warn('Could not reach reminder server; will retry', err);
    }
  }

  async function cancelReminder(id) {
    const sub = await currentSubscription();
    if (!sub) return;
    api('/cancel', { id, endpoint: sub.endpoint }).catch(() => {});
  }

  // Sends anything that didn't reach the server, and tops up repeating reminders once a day
  async function syncAll(force = false) {
    const sub = await currentSubscription();
    if (!sub) return;
    if (localStorage.getItem(KEYS.endpoint) !== sub.endpoint) {
      localStorage.setItem(KEYS.endpoint, sub.endpoint);
      force = true;
    }
    const now = Date.now();
    for (const t of tasks.slice()) {
      const stale = t.repeat && t.scheduled && now - (t.syncedAt || 0) > DAY;
      if (force || !t.synced || stale) await syncTask(t);
    }
  }

  async function enablePush() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications are off. Turn them on in Settings → Notifications → To Do.');
        return updateBanner();
      }
      registration = registration || (await navigator.serviceWorker.ready);
      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(vapidPublicKey),
        });
      }
      await syncAll(true);
      if (window.TodoExtras) window.TodoExtras.syncAll(true);
      toast('Reminders are on 🎉');
    } catch (err) {
      console.error(err);
      toast('Could not turn on reminders: ' + err.message);
    }
    updateBanner();
    fillSettings();
  }

  function ensurePushForReminder() {
    if (pushSupported && Notification.permission === 'granted') return;
    updateBanner(true);
    $('banner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const shareSvg = '<svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l4 4-1.4 1.4L13 5.8V15h-2V5.8L9.4 7.4 8 6l4-4zm-7 8h4v2H6v8h12v-8h-3v-2h5v12H4V10z"/></svg>';

  async function pushState() {
    if (isIOS && !isStandalone) return 'install';
    if (!pushSupported) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const sub = await currentSubscription();
    return Notification.permission === 'granted' && sub ? 'on' : 'off';
  }

  async function updateBanner(highlight = false) {
    const banner = $('banner');
    const state = await pushState();
    if (state === 'install') {
      banner.innerHTML = `<strong>Get reminders on your iPhone</strong>
        <p>Tap ${shareSvg} <b>Share</b> in Safari, then <b>Add to Home Screen</b>. Open To Do from your home screen to turn on notifications.</p>`;
      banner.hidden = false;
    } else if (state === 'unsupported') {
      banner.innerHTML = '<strong>Reminders aren’t available in this browser</strong><p>Your tasks still save on this device.</p>';
      banner.hidden = !highlight;
    } else if (state === 'denied') {
      banner.innerHTML = '<strong>Notifications are blocked</strong><p>Turn them on in Settings → Notifications → To Do.</p>';
      banner.hidden = !highlight;
    } else if (state === 'off') {
      banner.innerHTML = `<strong>Turn on reminders</strong>
        <p>Get a notification when a task is due.</p>
        <button class="add-btn" type="button" id="enable-push">Turn on</button>`;
      banner.hidden = false;
      $('enable-push').onclick = enablePush;
    } else banner.hidden = true;
  }

  // ---------- settings ----------
  const settingsDialog = $('settings');
  async function fillSettings() {
    const state = await pushState();
    $('push-status').textContent = {
      install: 'Add this app to your Home Screen to get notifications.',
      unsupported: 'This browser can’t show notifications.',
      denied: 'Blocked. Turn them on in iPhone Settings → Notifications → To Do.',
      off: 'Off.',
      on: 'On. Reminders arrive even when the app is closed.',
    }[state];
    $('settings-enable').hidden = state !== 'off';
    $('test-push').hidden = state !== 'on';
    $('allday-hour').value = settings.allDayHour == null ? '' : String(settings.allDayHour);
    $('sound-on').checked = !!settings.sound;
    const last = Number(localStorage.getItem(KEYS.backup));
    $('last-backup').textContent = last ? `Last backup: ${fmtDue(last, false)}` : 'No backup saved yet.';
  }
  $('open-settings').addEventListener('click', () => {
    fillSettings();
    settingsDialog.showModal();
  });
  $('settings-enable').addEventListener('click', enablePush);
  $('allday-hour').addEventListener('change', (e) => {
    settings.allDayHour = e.target.value === '' ? null : Number(e.target.value);
    save();
    syncAll(true);
  });
  $('sound-on').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    save();
    if (settings.sound) tickSound();
  });
  $('test-push').addEventListener('click', async () => {
    const sub = await currentSubscription();
    if (!sub) return;
    try {
      await api('/test', { subscription: sub.toJSON() });
      toast('Test sent. It should arrive in a few seconds.');
    } catch (err) {
      toast('Test failed: ' + err.message);
    }
  });

  // ---------- backup ----------
  $('export').addEventListener('click', async () => {
    const extra = {};
    for (const key of EXTRA_KEYS) if (localStorage.getItem(key) != null) extra[key] = read(key, null);
    const data = { app: 'todo', version: 2, exportedAt: Date.now(), tasks, lists, settings, extra };
    const name = `todo-backup-${toDateInput(Date.now())}.json`;
    const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'To Do backup' });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      localStorage.setItem(KEYS.backup, String(Date.now()));
      fillSettings();
    } catch (err) {
      if (err.name !== 'AbortError') toast('Could not save backup: ' + err.message);
    }
  });

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'todo' || !Array.isArray(data.tasks)) throw new Error('This isn’t a To Do backup file.');
      if (!confirm(`Replace your ${tasks.length} tasks with the ${data.tasks.length} in this backup?`)) return;
      for (const t of tasks) if (t.scheduled) cancelReminder(t.id);
      tasks = data.tasks.map((t) => ({ ...migrate(t), synced: false, scheduled: false }));
      lists = Array.isArray(data.lists) ? data.lists : [];
      if (data.settings) settings = { ...settings, ...data.settings };
      for (const key of EXTRA_KEYS) {
        if (data.extra && data.extra[key] != null) localStorage.setItem(key, JSON.stringify(data.extra[key]));
      }
      save();
      render();
      syncAll(true);
      if (window.TodoExtras) window.TodoExtras.reload();
      settingsDialog.close();
      toast(`Restored ${tasks.length} tasks`);
    } catch (err) {
      toast('Could not restore: ' + err.message);
    }
  });

  // ---------- opening a task from a notification ----------
  function openFromUrl(url) {
    const params = new URL(url, location.href).searchParams;
    if (params.get('page') && window.TodoExtras) return window.TodoExtras.showPage(params.get('page'));
    const id = params.get('task');
    if (!id || !find(id)) return;
    if (editDialog.open) editDialog.close();
    if (window.TodoExtras) window.TodoExtras.showPage('tasks');
    const task = find(id);
    if (task.due != null && !inView(task, view)) setView(task.due < endOfToday() ? 'today' : 'upcoming');
    openEdit(id, { fromNotification: true });
  }

  // ---------- shared with extras.js (focus, habits, countdowns) ----------
  window.TodoCore = {
    api, currentSubscription, toast, haptic, tickSound, ensurePushForReminder, actionSheet,
    startOfDay, addDays, fmtDay, fmtTime, fmtDue, toDateInput, toTimeInput, read, render,
    get settings() { return settings; },
    get tasks() { return tasks; },
  };

  // ---------- start ----------
  render();
  updatePreview();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  setInterval(render, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      render();
      syncAll();
      if (window.TodoExtras) window.TodoExtras.syncAll();
    }
  });
  window.addEventListener('online', () => syncAll());

  if (location.search.includes('task=')) {
    const url = location.href;
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openFromUrl(url), 0);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open') openFromUrl(e.data.url);
    });
    navigator.serviceWorker
      .register('sw.js')
      .then(async (reg) => {
        registration = reg;
        await updateBanner();
        syncAll();
      })
      .catch((err) => {
        console.error('Service worker failed', err);
        updateBanner();
      });
  } else {
    updateBanner();
  }
})();
