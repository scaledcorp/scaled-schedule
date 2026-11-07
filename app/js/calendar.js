// Working-time math.
// Instants are whole minutes since 1970-01-01 00:00 in "floating" local time (no time zone), so
// daylight saving never moves a schedule. A calendar is a work week (minute ranges per weekday,
// Sunday first) plus dated exceptions (holidays, or special working hours).

export const DAY = 1440;
const GUARD_DAYS = 365 * 60;

export function standardCalendar() {
  const day = [[480, 720], [780, 1020]];          // 8:00-12:00, 13:00-17:00
  return { name: 'Standard', week: [[], day, day, day, day, day, []], exceptions: [] };
}

export const dayIndex = t => Math.floor(t / DAY);
export const weekday = d => ((d + 4) % 7 + 7) % 7;          // 1970-01-01 was a Thursday; 0 = Sunday
export const dateKey = d => new Date(d * 86400000).toISOString().slice(0, 10);
export const keyToDay = key => Math.round(Date.parse(key + 'T00:00:00Z') / 86400000);

export class WorkCalendar {
  constructor(cal) {
    this.cal = cal;
    this.exceptions = new Map((cal.exceptions || []).map(e => [e.date, e.ranges || []]));
    this.cache = new Map();
    if (!cal.week.some(r => r.length) && !(cal.exceptions || []).some(e => (e.ranges || []).length)) {
      throw new Error('The calendar has no working time.');
    }
  }

  ranges(d) {
    let r = this.cache.get(d);
    if (!r) {
      const key = dateKey(d);
      r = this.exceptions.has(key) ? this.exceptions.get(key) : this.cal.week[weekday(d)];
      this.cache.set(d, r);
    }
    return r;
  }

  isWorkingDay(d) { return this.ranges(d).length > 0; }

  dayMinutes(d) { return this.ranges(d).reduce((s, [a, b]) => s + b - a, 0); }

  // The finish after `minutes` of work starting at t.
  addWork(t, minutes) {
    if (minutes < 0) return this.subtractWork(t, -minutes);
    if (minutes === 0) return t;
    let d = dayIndex(t), m = t - d * DAY, left = minutes;
    for (let i = 0; i < GUARD_DAYS; i++, d++, m = 0) {
      for (const [a, b] of this.ranges(d)) {
        if (b <= m) continue;
        const s = Math.max(a, m);
        if (left <= b - s) return d * DAY + s + left;
        left -= b - s;
      }
    }
    throw new Error('Ran out of calendar while adding work.');
  }

  // The start that is `minutes` of work before t.
  subtractWork(t, minutes) {
    if (minutes < 0) return this.addWork(t, -minutes);
    if (minutes === 0) return t;
    let d = dayIndex(t), m = t - d * DAY, left = minutes;
    if (m === 0) { d--; m = DAY; }
    for (let i = 0; i < GUARD_DAYS; i++, d--, m = DAY) {
      const r = this.ranges(d);
      for (let j = r.length - 1; j >= 0; j--) {
        const [a, b] = r[j];
        if (a >= m) continue;
        const e = Math.min(b, m);
        if (left <= e - a) return d * DAY + e - left;
        left -= e - a;
      }
    }
    throw new Error('Ran out of calendar while subtracting work.');
  }

  // Shift by a lag: forward for positive, backward for negative.
  shift(t, lag) { return lag >= 0 ? this.addWork(t, lag) : this.subtractWork(t, -lag); }

  // The first moment at or after t when work happens (e.g. Friday 17:00 -> Monday 8:00).
  nextWorkStart(t) {
    let d = dayIndex(t), m = t - d * DAY;
    for (let i = 0; i < GUARD_DAYS; i++, d++, m = 0) {
      for (const [a, b] of this.ranges(d)) if (m < b) return d * DAY + Math.max(a, m);
    }
    throw new Error('No working time found.');
  }

  // The last moment at or before t when work ends (e.g. Monday 8:00 -> Friday 17:00).
  prevWorkEnd(t) {
    let d = dayIndex(t), m = t - d * DAY;
    if (m === 0) { d--; m = DAY; }
    for (let i = 0; i < GUARD_DAYS; i++, d--, m = DAY) {
      const r = this.ranges(d);
      for (let j = r.length - 1; j >= 0; j--) if (r[j][0] < m) return d * DAY + Math.min(r[j][1], m);
    }
    throw new Error('No working time found.');
  }

  // Working minutes between two instants (negative when b is before a).
  workBetween(a, b) {
    if (b < a) return -this.workBetween(b, a);
    let total = 0;
    const d1 = dayIndex(b);
    for (let d = dayIndex(a); d <= d1; d++) {
      const lo = Math.max(a - d * DAY, 0), hi = Math.min(b - d * DAY, DAY);
      for (const [x, y] of this.ranges(d)) total += Math.max(0, Math.min(y, hi) - Math.max(x, lo));
    }
    return total;
  }

  // Position of t within its day as a 0..1 share of that day's working time, so bars line up with
  // day columns (8:00 -> 0, 12:00 -> 0.5, 17:00 -> 1). Non-working days give 0.
  dayFraction(t) {
    const d = dayIndex(t), m = t - d * DAY, total = this.dayMinutes(d);
    if (!total) return 0;
    let done = 0;
    for (const [a, b] of this.ranges(d)) done += Math.max(0, Math.min(b, m) - a);
    return done / total;
  }

  firstWorkMinute(d) { const r = this.ranges(d); return r.length ? r[0][0] : 480; }
  lastWorkMinute(d) { const r = this.ranges(d); return r.length ? r[r.length - 1][1] : 1020; }
}

// US federal holidays for a year, as calendar exceptions (observed dates when they fall on a weekend).
export function usFederalHolidays(year) {
  const utc = (m, d) => Math.round(Date.UTC(year, m, d) / 86400000);
  const nth = (m, wd, n) => { let d = utc(m, 1); while (weekday(d) !== wd) d++; return d + 7 * (n - 1); };
  const last = (m, wd) => { let d = utc(m + 1, 1) - 1; while (weekday(d) !== wd) d--; return d; };
  const observed = d => (weekday(d) === 6 ? d - 1 : weekday(d) === 0 ? d + 1 : d);
  const list = [
    [observed(utc(0, 1)), "New Year's Day"],
    [nth(0, 1, 3), 'Martin Luther King Jr. Day'],
    [nth(1, 1, 3), "Presidents' Day"],
    [last(4, 1), 'Memorial Day'],
    [observed(utc(5, 19)), 'Juneteenth'],
    [observed(utc(6, 4)), 'Independence Day'],
    [nth(8, 1, 1), 'Labor Day'],
    [nth(9, 1, 2), 'Columbus Day'],
    [observed(utc(10, 11)), 'Veterans Day'],
    [nth(10, 4, 4), 'Thanksgiving'],
    [observed(utc(11, 25)), 'Christmas Day'],
  ];
  return list.map(([d, name]) => ({ date: dateKey(d), name, ranges: [] }));
}
