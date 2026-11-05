(() => {
  const { serverUrl, vapidPublicKey } = window.TODO_CONFIG;
  const STORE = 'todo.tasks.v1';
  const ENDPOINT_KEY = 'todo.pushEndpoint';
  const $ = (id) => document.getElementById(id);

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  let tasks = load();
  let registration = null;
  let editingId = null;

  // ---------- storage ----------
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || [];
    } catch {
      return [];
    }
  }
  function save() {
    localStorage.setItem(STORE, JSON.stringify(tasks));
  }

  // ---------- dates ----------
  function toInputValue(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  function fromInputValue(value) {
    return value ? new Date(value).getTime() : null;
  }
  function formatWhen(ms) {
    const d = new Date(ms);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dayDiff = Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000,
    );
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Tomorrow ${time}`;
    if (dayDiff === -1) return `Yesterday ${time}`;
    if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
    const sameYear = d.getFullYear() === now.getFullYear();
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })} ${time}`;
  }

  // ---------- rendering ----------
  const bellSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
  const checkSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function renderItem(task) {
    const li = document.createElement('li');
    li.className = 'item' + (task.done ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'check';
    check.type = 'button';
    check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
    check.innerHTML = checkSvg;
    check.onclick = () => toggle(task.id);

    const body = document.createElement('button');
    body.className = 'body';
    body.type = 'button';
    body.onclick = () => openEdit(task.id);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = task.text;
    body.append(title);
    if (task.remindAt) {
      const chip = document.createElement('span');
      const past = task.remindAt < Date.now();
      chip.className = 'chip' + (past ? (task.done ? ' past' : ' late') : '');
      chip.innerHTML = bellSvg;
      chip.append(formatWhen(task.remindAt));
      body.append(chip);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete');
    del.textContent = '×';
    del.onclick = () => remove(task.id);

    li.append(check, body, del);
    return li;
  }

  function render() {
    const active = tasks.filter((t) => !t.done).sort(byReminderThenCreated);
    const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $('list').replaceChildren(...active.map(renderItem));
    $('done-list').replaceChildren(...done.map(renderItem));
    $('empty').hidden = active.length > 0;
    $('done-wrap').hidden = done.length === 0;
    $('done-title').textContent = `Completed (${done.length})`;
    $('count').textContent = active.length ? `${active.length} left` : '';
  }

  function byReminderThenCreated(a, b) {
    if (a.remindAt && b.remindAt) return a.remindAt - b.remindAt;
    if (a.remindAt) return -1;
    if (b.remindAt) return 1;
    return a.createdAt - b.createdAt;
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // ---------- task actions ----------
  function add(text, remindAt) {
    const task = { id: crypto.randomUUID(), text, done: false, remindAt, createdAt: Date.now(), synced: !remindAt };
    tasks.push(task);
    save();
    render();
    if (remindAt) syncReminder(task);
  }

  function toggle(id) {
    const task = tasks.find((t) => t.id === id);
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : null;
    task.synced = false;
    save();
    render();
    syncReminder(task);
  }

  function remove(id) {
    const task = tasks.find((t) => t.id === id);
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
    if (task.remindAt) cancelReminder(task.id);
  }

  function openEdit(id) {
    const task = tasks.find((t) => t.id === id);
    editingId = id;
    $('edit-text').value = task.text;
    $('edit-when').value = task.remindAt ? toInputValue(task.remindAt) : '';
    $('edit').showModal();
  }

  $('edit').addEventListener('close', () => {
    const action = $('edit').returnValue;
    const task = tasks.find((t) => t.id === editingId);
    if (!task || action === 'cancel' || !action) return;
    const text = $('edit-text').value.trim();
    if (text) task.text = text;
    const before = task.remindAt;
    task.remindAt = action === 'clear-reminder' ? null : fromInputValue($('edit-when').value);
    task.synced = false;
    save();
    render();
    if (task.remindAt) {
      syncReminder(task);
      if (task.remindAt !== before) ensurePushForReminder();
    } else if (before) {
      cancelReminder(task.id);
      task.synced = true;
      save();
    }
  });

  // ---------- add form ----------
  const whenInput = $('when');
  function updateWhenLabel() {
    const ms = fromInputValue(whenInput.value);
    $('when-label').textContent = ms ? formatWhen(ms) : 'Remind me';
    whenInput.parentElement.classList.toggle('set', !!ms);
  }
  whenInput.addEventListener('focus', () => {
    // Start the picker one hour from now, rounded to the hour
    if (!whenInput.value) {
      const d = new Date(Date.now() + 3600000);
      d.setMinutes(0, 0, 0);
      whenInput.value = toInputValue(d.getTime());
      updateWhenLabel();
    }
  });
  whenInput.addEventListener('input', updateWhenLabel);
  whenInput.addEventListener('change', updateWhenLabel);

  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('text').value.trim();
    if (!text) return $('text').focus();
    const remindAt = fromInputValue(whenInput.value);
    if (remindAt && remindAt < Date.now()) return toast('That time has already passed.');
    add(text, remindAt);
    $('text').value = '';
    whenInput.value = '';
    updateWhenLabel();
    if (remindAt) ensurePushForReminder();
  });

  $('clear-done').addEventListener('click', () => {
    for (const t of tasks.filter((t) => t.done && t.remindAt)) cancelReminder(t.id);
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
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

  async function syncReminder(task) {
    const sub = await currentSubscription();
    if (!sub) return;
    try {
      if (task.done || !task.remindAt || task.remindAt < Date.now()) {
        await api('/cancel', { id: task.id, endpoint: sub.endpoint });
      } else {
        await api('/schedule', {
          id: task.id,
          at: task.remindAt,
          title: task.text,
          body: `Reminder · ${formatWhen(task.remindAt)}`,
          subscription: sub.toJSON(),
        });
      }
      task.synced = true;
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

  // Re-sends anything that didn't reach the server (offline, new subscription, ...)
  async function syncAll(force = false) {
    const sub = await currentSubscription();
    if (!sub) return;
    if (localStorage.getItem(ENDPOINT_KEY) !== sub.endpoint) {
      localStorage.setItem(ENDPOINT_KEY, sub.endpoint);
      force = true;
    }
    for (const t of tasks) {
      if (t.remindAt && t.remindAt > Date.now() && (force || !t.synced)) await syncReminder(t);
    }
  }

  async function enablePush() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications are off. You can turn them on in iPhone Settings → Notifications → To Do.');
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
      toast('Reminders are on 🎉');
    } catch (err) {
      console.error(err);
      toast('Could not turn on reminders: ' + err.message);
    }
    updateBanner();
  }

  function ensurePushForReminder() {
    if (pushSupported && Notification.permission === 'granted') return;
    updateBanner(true);
    $('banner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const shareSvg = '<svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l4 4-1.4 1.4L13 5.8V15h-2V5.8L9.4 7.4 8 6l4-4zm-7 8h4v2H6v8h12v-8h-3v-2h5v12H4V10z"/></svg>';

  async function updateBanner(highlight = false) {
    const banner = $('banner');
    const sub = await currentSubscription();
    $('test-push').hidden = !sub;

    if (isIOS && !isStandalone) {
      banner.innerHTML = `<strong>Get reminders on your iPhone</strong>
        <p>Tap ${shareSvg} <b>Share</b> in Safari, then <b>Add to Home Screen</b>. Open To Do from your home screen to turn on notifications.</p>`;
      banner.hidden = false;
      return;
    }
    if (!pushSupported) {
      banner.innerHTML = '<strong>Reminders aren’t available in this browser</strong><p>Your tasks still save on this device.</p>';
      banner.hidden = !highlight;
      return;
    }
    if (Notification.permission === 'denied') {
      banner.innerHTML = '<strong>Notifications are blocked</strong><p>Turn them on in Settings → Notifications → To Do.</p>';
      banner.hidden = false;
      return;
    }
    if (Notification.permission !== 'granted' || !sub) {
      banner.innerHTML = `<strong>Turn on reminders</strong>
        <p>Get a notification when a task is due.</p>
        <button class="add-btn" type="button" id="enable-push">Turn on</button>`;
      banner.hidden = false;
      $('enable-push').onclick = enablePush;
      return;
    }
    banner.hidden = true;
  }

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

  // ---------- start ----------
  $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  render();
  // Refresh "late" chips and the date every minute
  setInterval(() => {
    $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    render();
  }, 60000);
  window.addEventListener('online', () => syncAll());

  if ('serviceWorker' in navigator) {
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
