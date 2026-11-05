// Repeat rules. A rule looks like:
//   { freq: 'day' | 'week' | 'month' | 'year', interval: 1, days: [1, 3], after: false, anchor: <ms> }
// `days` (0 = Sunday) only applies to weekly rules. `after` means "count from when I finish".
// `anchor` is the first due date; it keeps "every 2 weeks" and "monthly on the 31st" on track.
(function (root) {
  const DAY = 86400000;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function startOfWeek(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  // Adds months, keeping the anchor's day of month (clamped to the month's last day)
  function addMonths(ms, n, dayOfMonth) {
    const d = new Date(ms);
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dayOfMonth, last));
    return d.getTime();
  }

  // The next occurrence strictly after `prev`
  function next(rule, prev) {
    const interval = Math.max(1, rule.interval || 1);
    const anchor = rule.anchor ?? prev;
    const d = new Date(prev);
    switch (rule.freq) {
      case 'day':
        d.setDate(d.getDate() + interval);
        return d.getTime();
      case 'week': {
        if (!rule.days || !rule.days.length) {
          d.setDate(d.getDate() + 7 * interval);
          return d.getTime();
        }
        for (let i = 0; i < 7 * interval + 7; i++) {
          d.setDate(d.getDate() + 1);
          const weeks = Math.round((startOfWeek(d) - startOfWeek(anchor)) / (7 * DAY));
          if (rule.days.includes(d.getDay()) && ((weeks % interval) + interval) % interval === 0) return d.getTime();
        }
        return null;
      }
      case 'month':
        return addMonths(prev, interval, new Date(anchor).getDate());
      case 'year':
        return addMonths(prev, 12 * interval, new Date(anchor).getDate());
      default:
        return null;
    }
  }

  // First matching day on or after `ms` (used when a weekly rule's start isn't one of its days)
  function firstOnOrAfter(rule, ms) {
    if (rule.freq === 'week' && rule.days && rule.days.length && !rule.days.includes(new Date(ms).getDay())) {
      return next({ ...rule, anchor: ms }, ms);
    }
    return ms;
  }

  // Occurrences starting at `start`, skipping any before `from`, up to `count` or `until`
  function occurrences(start, rule, { from = -Infinity, count = 60, until = Infinity } = {}) {
    const out = [];
    let t = start;
    let guard = 0;
    while (t != null && t < from && guard++ < 10000) t = next(rule, t);
    while (t != null && out.length < count && t <= until && guard++ < 10000) {
      out.push(t);
      t = next(rule, t);
    }
    return out;
  }

  // The due date after completing a task on `doneAt`
  function nextAfterCompletion(rule, due, doneAt, allDay) {
    if (!rule.after) {
      // Skip occurrences that already passed so the task moves to the future
      let t = next(rule, due);
      const today = new Date(doneAt);
      today.setHours(0, 0, 0, 0);
      let guard = 0;
      while (t != null && (allDay ? t < today.getTime() + DAY : t <= doneAt) && guard++ < 10000) t = next(rule, t);
      return t;
    }
    // "Count from when I finish": same time of day, one interval after today
    const base = new Date(doneAt);
    const dueDate = new Date(due);
    base.setHours(dueDate.getHours(), dueDate.getMinutes(), 0, 0);
    return next({ ...rule, anchor: base.getTime() }, base.getTime());
  }

  function describe(rule) {
    if (!rule) return '';
    const n = Math.max(1, rule.interval || 1);
    const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[rule.freq];
    const simple = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[rule.freq];
    let text;
    const days = (rule.days || []).slice().sort();
    if (rule.freq === 'week' && n === 1 && days.join() === '1,2,3,4,5') text = 'Weekdays';
    else if (rule.freq === 'week' && n === 1 && days.join() === '0,6') text = 'Weekends';
    else {
      text = n === 1 ? simple : `Every ${n} ${unit}s`;
      if (rule.freq === 'week' && days.length) text += ` on ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
    }
    if (rule.after) text += ' after done';
    return text;
  }

  const Recur = { next, firstOnOrAfter, occurrences, nextAfterCompletion, describe, DAY_NAMES };
  root.Recur = Recur;
  if (typeof module !== 'undefined') module.exports = Recur;
})(typeof self !== 'undefined' ? self : globalThis);
