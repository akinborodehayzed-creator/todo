// Run with: node tests/parse.test.js
const assert = require('node:assert/strict');
const Recur = require('../docs/recur.js');
const { parse } = require('../docs/parse.js');

// Wednesday 5 Nov 2025, 10:00 local time
const NOW = new Date(2025, 10, 5, 10, 0).getTime();
const at = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
let failed = 0;
function check(input, expected) {
  const r = parse(input, NOW);
  try {
    for (const [k, v] of Object.entries(expected)) {
      if (k === 'repeat' && v) {
        for (const [rk, rv] of Object.entries(v)) assert.deepEqual(r.repeat?.[rk], rv, `repeat.${rk}`);
      } else assert.deepEqual(r[k], v, k);
    }
    console.log('ok  ', input);
  } catch (e) {
    failed++;
    console.log('FAIL', input, '→', e.message, JSON.stringify({ ...r, due: r.due && new Date(r.due).toString() }));
  }
}

check('Call mom', { title: 'Call mom', due: null, repeat: null });
check('Dentist tomorrow 3pm', { title: 'Dentist', due: at(2025, 11, 6, 15), allDay: false });
check('call mum Friday', { title: 'call mum', due: at(2025, 11, 7), allDay: true });
check('Pay rent on the 1st', { title: 'Pay rent', due: at(2025, 12, 1) });
check('Submit report by Nov 20 at 5:30pm', { title: 'Submit report', due: at(2025, 11, 20, 17, 30) });
check('Party 20th of December', { title: 'Party', due: at(2025, 12, 20) });
check('Take pills every day at 8am', { title: 'Take pills', due: at(2025, 11, 6, 8), repeat: { freq: 'day', interval: 1 } });
check('Standup weekdays 9:15', { title: 'Standup', due: at(2025, 11, 6, 9, 15), repeat: { freq: 'week', days: [1, 2, 3, 4, 5] } });
check('Gym every mon and thu 6pm #Health !1 @fitness', { title: 'Gym', due: at(2025, 11, 6, 18), list: 'Health', priority: 3, tags: ['fitness'], repeat: { freq: 'week', days: [1, 4] } });
check('Water plants every! 3 days', { title: 'Water plants', due: at(2025, 11, 5), repeat: { freq: 'day', interval: 3, after: true } });
check('Bins every other week', { repeat: { freq: 'week', interval: 2 }, due: at(2025, 11, 5) });
check('Check oven in 20 minutes', { title: 'Check oven', due: NOW + 20 * 60000, allDay: false });
check('Movie tonight', { title: 'Movie', due: at(2025, 11, 5, 20) });
check('Lunch at noon', { title: 'Lunch', due: at(2025, 11, 5, 12) });
check('Wake up at 7', { title: 'Wake up', due: at(2025, 11, 6, 7) });
check('Call at 3', { title: 'Call', due: at(2025, 11, 5, 15) });
check('Read 2 books this weekend', { title: 'Read 2 books', due: at(2025, 11, 8) });
check('Buy sat nav', { title: 'Buy sat nav', due: null });
check('May the force', { title: 'May the force', due: null });
check('Pay electricity bill monthly', { repeat: { freq: 'month', interval: 1 } });
check('Birthday Mar 3 yearly', { due: at(2026, 3, 3), repeat: { freq: 'year' } });

// Repeat rules
const eq = (a, b, msg) => { try { assert.equal(a, b, msg); console.log('ok   recur', msg); } catch (e) { failed++; console.log('FAIL recur', msg, new Date(a).toString()); } };
eq(Recur.next({ freq: 'month', interval: 1, anchor: at(2026, 1, 31) }, at(2026, 1, 31)), at(2026, 2, 28), 'Jan 31 → Feb 28');
eq(Recur.next({ freq: 'month', interval: 1, anchor: at(2026, 1, 31) }, at(2026, 2, 28)), at(2026, 3, 31), 'Feb 28 → Mar 31');
eq(Recur.next({ freq: 'week', interval: 2, days: [1, 3], anchor: at(2025, 11, 3, 9) }, at(2025, 11, 5, 9)), at(2025, 11, 17, 9), 'every 2 weeks Mon/Wed');
eq(Recur.next({ freq: 'day', interval: 1, anchor: at(2026, 3, 28, 9) }, at(2026, 3, 28, 9)), at(2026, 3, 29, 9), 'daily keeps 9am across DST');
eq(Recur.nextAfterCompletion({ freq: 'day', interval: 3, after: true }, at(2025, 11, 1, 8), at(2025, 11, 5, 19), false), at(2025, 11, 8, 8), 'after done: 3 days from finish');
eq(Recur.nextAfterCompletion({ freq: 'day', interval: 1, anchor: at(2025, 11, 1, 8) }, at(2025, 11, 1, 8), NOW, false), at(2025, 11, 6, 8), 'missed days skip to future');
eq(Recur.occurrences(at(2025, 11, 1, 8), { freq: 'day', interval: 1 }, { from: NOW, count: 3 }).length, 3, 'occurrences count');
console.log(Recur.describe({ freq: 'week', interval: 1, days: [1, 2, 3, 4, 5] }), '|', Recur.describe({ freq: 'week', interval: 2, days: [1, 3], after: false }), '|', Recur.describe({ freq: 'day', interval: 3, after: true }));
if (failed) { console.log(`${failed} failed`); process.exit(1); } else console.log('all passed');
