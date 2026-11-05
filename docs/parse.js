// Reads plain English out of a new task, e.g.
//   "Gym tomorrow 6pm every mon and thu #health !1 @fitness"
// → title "Gym", due tomorrow 6 PM, repeats Mon/Thu, list "health", high priority, tag "fitness".
(function (root) {
  const DAY = 86400000;
  const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
  const WD_FULL = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, other: 2 };
  const PRIORITY = { 1: 3, high: 3, 2: 2, med: 2, medium: 2, 3: 1, low: 1 };

  const weekday = (word) => WEEKDAYS[word.toLowerCase().slice(0, 3)];
  const num = (word) => (/^\d+$/.test(word) ? parseInt(word, 10) : NUMBER_WORDS[word.toLowerCase()]);
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
  // Next date (strictly after today) that falls on the weekday
  const nextWeekday = (today, wd) => addDays(today, ((wd - new Date(today).getDay() + 7) % 7) || 7);

  function parse(input, now = Date.now()) {
    let text = ` ${input} `;
    const out = { title: '', date: null, time: null, repeat: null, list: null, priority: 0, tags: [], exact: null };
    const today = startOfDay(now);

    // Runs `re` on the text; when `fn` returns something other than false, the match is cut out.
    const take = (re, fn) => {
      text = text.replace(re, (...m) => (fn(...m) === false ? m[0] : ' '));
    };
    const B = '(?<=[\\s,.;(])'; // start of a word
    const E = '(?=[\\s,.;!?)])'; // end of a word
    const rx = (body) => new RegExp(`${B}${body}${E}`, 'giu');

    // #list  !priority  @tag
    take(/(?<=\s)#([\p{L}\p{N}_-]+)/gu, (_, name) => { out.list = name; });
    take(/(?<=\s)!(1|2|3|high|med|medium|low)(?=\s)/giu, (_, p) => { out.priority = PRIORITY[p.toLowerCase()]; });
    take(/(?<=\s)@([\p{L}\p{N}_-]+)/gu, (_, tag) => { if (!out.tags.includes(tag)) out.tags.push(tag); });

    // Repeats
    const every = '(every|each)(!?)\\s+';
    const after = (bang) => bang === '!';
    take(rx(`(?:${every}(?:(\\d+|other|two|three|four|five|six)\\s+)?(day|week|month|year)s?|(daily|weekly|monthly|yearly|annually))`),
      (_, _e, bang, n, unit, adverb) => {
        if (out.repeat) return false;
        const freq = unit ? unit.toLowerCase() : { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annually: 'year' }[adverb.toLowerCase()];
        out.repeat = { freq, interval: n ? num(n) : 1, after: after(bang) };
      });
    take(rx(`(?:${every}(weekday|weekend)s?|(weekdays))`), (_, _e, bang, kind, plain) => {
      if (out.repeat) return false;
      const days = (kind || plain).toLowerCase().startsWith('weekend') ? [0, 6] : [1, 2, 3, 4, 5];
      out.repeat = { freq: 'week', interval: 1, days, after: after(bang) };
    });
    take(rx(`${every}(${WD}(?:\\s*(?:,|and|&)\\s*${WD})*)`), (_, _e, bang, list) => {
      if (out.repeat) return false;
      const days = [...new Set(list.split(/\s*(?:,|and|&)\s*/i).map(weekday))].sort();
      out.repeat = { freq: 'week', interval: 1, days, after: after(bang) };
    });
    take(rx('after (?:done|finishing|completion|completing|i finish)'), () => {
      if (!out.repeat) return false;
      out.repeat.after = true;
    });

    // Times
    const setTime = (h, m) => {
      if (h > 23 || m > 59) return false;
      out.time = { h, m };
    };
    take(rx('(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)'), (_, h, m, ap) => {
      if (out.time) return false;
      let hour = parseInt(h, 10) % 12;
      if (ap.toLowerCase().startsWith('p')) hour += 12;
      return setTime(hour, m ? parseInt(m, 10) : 0);
    });
    take(rx('(?:at\\s+)?(\\d{1,2}):(\\d{2})'), (_, h, m) => (out.time ? false : setTime(parseInt(h, 10), parseInt(m, 10))));
    take(rx('at\\s+(\\d{1,2})'), (_, h) => {
      if (out.time) return false;
      const hour = parseInt(h, 10);
      if (hour < 1 || hour > 12) return false;
      return setTime(hour === 12 ? 12 : hour <= 6 ? hour + 12 : hour, 0);
    });
    take(rx('(?:at\\s+)?(noon|midday|midnight)'), (_, w) => (out.time ? false : setTime(w.toLowerCase() === 'midnight' ? 0 : 12, 0)));
    take(rx('(?:(?:this|in the)\\s+)?(morning|afternoon|evening)'), (_, w) => {
      if (out.time) return false;
      setTime({ morning: 9, afternoon: 15, evening: 18 }[w.toLowerCase()], 0);
    });
    take(rx('tonight'), () => {
      out.date = out.date ?? today;
      if (!out.time) out.time = { h: 20, m: 0 };
    });

    // "in 20 minutes", "in 2 hours", "in 3 days", "in a week"
    take(rx('in\\s+(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?)'), (_, n, unit) => {
      if (out.date != null || out.exact) return false;
      const k = num(n);
      const u = unit.toLowerCase();
      if (u.startsWith('min')) out.exact = now + k * 60000;
      else if (u.startsWith('h')) out.exact = now + k * 3600000;
      else if (u.startsWith('d')) out.date = addDays(today, k);
      else if (u.startsWith('w')) out.date = addDays(today, 7 * k);
      else {
        const d = new Date(today);
        d.setMonth(d.getMonth() + k);
        out.date = d.getTime();
      }
    });

    // Dates
    take(rx('(?:on\\s+|by\\s+|due\\s+)?(?:the\\s+)?day after (?:tomorrow|tmrw?)'), () => (out.date != null ? false : (out.date = addDays(today, 2))));
    take(rx('(?:by\\s+|due\\s+)?(today|tomorrow|tomorow|tmrw?)'), (_, w) => {
      if (out.date != null) return false;
      out.date = w.toLowerCase().startsWith('tod') ? today : addDays(today, 1);
    });
    take(rx('(?:on\\s+|by\\s+)?(?:this\\s+)?weekend'), () => (out.date != null ? false : (out.date = nextWeekday(today - DAY, 6))));
    take(rx('next week'), () => (out.date != null ? false : (out.date = nextWeekday(today, 1))));
    take(rx('next month'), () => {
      if (out.date != null) return false;
      const d = new Date(today);
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      out.date = d.getTime();
    });
    // Full weekday names on their own; short ones only after on/next/this/by
    const onWeekday = (_, wd) => {
      if (out.date != null) return false;
      out.date = nextWeekday(today, weekday(wd));
    };
    take(rx(`(?:on|next|this|by|due)\\s+(${WD})`), onWeekday);
    take(rx(`(${WD_FULL})`), onWeekday);
    // "Nov 20", "20 Nov", "20th of November", "on the 15th"
    const onMonthDay = (monthWord, dayStr) => {
      if (out.date != null) return false;
      const month = MONTHS.indexOf(monthWord.toLowerCase().slice(0, 3));
      const day = parseInt(dayStr, 10);
      if (day < 1 || day > 31) return false;
      let d = new Date(new Date(today).getFullYear(), month, day);
      if (d.getTime() < today) d = new Date(d.getFullYear() + 1, month, day);
      out.date = d.getTime();
    };
    take(rx(`(?:on\\s+|by\\s+)?(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`), (_, mo, d) => onMonthDay(mo, d));
    take(rx(`(?:on\\s+|by\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})`), (_, d, mo) => onMonthDay(mo, d));
    take(rx('(?:on\\s+|by\\s+)the\\s+(\\d{1,2})(?:st|nd|rd|th)'), (_, dayStr) => {
      if (out.date != null) return false;
      const day = parseInt(dayStr, 10);
      if (day < 1 || day > 31) return false;
      const t = new Date(today);
      let d = new Date(t.getFullYear(), t.getMonth(), day);
      if (d.getTime() < today) d = new Date(t.getFullYear(), t.getMonth() + 1, day);
      out.date = d.getTime();
    });

    out.title = text.replace(/\s+/g, ' ').replace(/\s+(?:on|at|by|due|from|starting)$/i, '').trim();
    return finish(out, now, today);
  }

  // Turns the parsed parts into { due, allDay } and fills in sensible defaults
  function finish(out, now, today) {
    let due = null;
    let allDay = true;
    if (out.exact) {
      due = out.exact;
      allDay = false;
    } else {
      let date = out.date;
      if (date == null && out.repeat) {
        date = today;
        if (out.repeat.freq === 'week' && out.repeat.days) {
          const wd = new Date(today).getDay();
          if (!out.repeat.days.includes(wd)) date = addDays(today, Math.min(...out.repeat.days.map((d) => ((d - wd + 7) % 7) || 7)));
        }
      }
      if (date == null && out.time) date = today;
      if (date != null) {
        due = date;
        if (out.time) {
          const d = new Date(date);
          d.setHours(out.time.h, out.time.m, 0, 0);
          due = d.getTime();
          allDay = false;
          // A time that already passed today means the next one
          if (out.date == null && due <= now) {
            if (out.repeat && root.Recur) due = root.Recur.next({ ...out.repeat, anchor: due }, due);
            else due = addDays(due, 1);
          }
        }
      }
    }
    // "tomorrow every mon and thu" starts on the first Mon/Thu from tomorrow
    if (out.repeat && out.repeat.days && due != null && root.Recur) due = root.Recur.firstOnOrAfter(out.repeat, due);
    if (out.repeat && due != null) out.repeat.anchor = due;
    return { title: out.title, due, allDay, repeat: out.repeat, list: out.list, priority: out.priority, tags: out.tags };
  }

  const Parse = { parse };
  root.Parse = Parse;
  if (typeof module !== 'undefined') module.exports = Parse;
})(typeof self !== 'undefined' ? self : globalThis);
