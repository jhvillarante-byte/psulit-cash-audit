/**
 * schedule.js
 *
 * Per-branch, per-day-of-week shift schedules.
 *
 * Solaire:    Mon-Fri          11:00 -> 05:00 (next day)
 *             Sat/Sun/Holidays 09:00 -> 05:00 (next day)
 * Alphaland:  Mon-Sun          10:00 -> 21:00 (same day)
 *
 * Holidays come from the HOLIDAYS env var, a comma-separated list of
 * YYYY-MM-DD dates, e.g. HOLIDAYS=2026-08-25,2026-11-30,2026-12-25
 * A holiday follows the same schedule as a weekend.
 */

const TOLERANCE_HOURS = 2; // how close a count must be to the scheduled time

const SCHEDULES = {
  Solaire: {
    weekday: { open: 11, close: 5, overnight: true },
    weekend: { open: 9,  close: 5, overnight: true }
  },
  Alphaland: {
    weekday: { open: 10, close: 21, overnight: false },
    weekend: { open: 10, close: 21, overnight: false }
  }
};

function holidaySet() {
  return new Set(
    (process.env.HOLIDAYS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

// Manila is UTC+8 year-round (no DST), so plain UTC date math is safe here.
function manilaDayOfWeek(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun ... 6=Sat
}

function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * The schedule that applies to a branch on a given calendar date.
 * Sat, Sun, and any date listed in HOLIDAYS use the weekend schedule.
 */
function scheduleFor(branch, year, month, day) {
  const table = SCHEDULES[branch];
  if (!table) return null;
  const dow = manilaDayOfWeek(year, month, day);
  const isWeekend = dow === 0 || dow === 6 || holidaySet().has(isoDate(year, month, day));
  return { ...(isWeekend ? table.weekend : table.weekday), isWeekend };
}

/**
 * The shift a closing count belongs to. For an overnight branch, a 05:00 close
 * belongs to the PREVIOUS calendar day's shift, so the opening time has to be
 * looked up against that earlier date (Saturday 5AM closes Friday's 11AM shift).
 */
function shiftDateForClose(branch, year, month, day, hour) {
  const table = SCHEDULES[branch];
  if (!table) return { year, month, day };
  const overnight = table.weekday.overnight || table.weekend.overnight;
  if (overnight && hour < 12) {
    const d = new Date(Date.UTC(year, month - 1, day - 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  return { year, month, day };
}

function hoursApart(a, b) {
  return Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
}

function decimalHour(timestamp) {
  const m = (timestamp || '').match(/(\d{1,2}):(\d{2}):\d{2}/);
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}

function dateParts(timestamp) {
  const m = (timestamp || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]) };
}

/**
 * True if this count was filed at (or near) its branch's scheduled OPENING time
 * for that day of week.
 */
function isScheduledOpening(count) {
  if (!count) return false;
  if (count.phase && count.phase.toLowerCase() !== 'opening') return false;

  const hour = decimalHour(count.timestamp);
  const date = dateParts(count.timestamp);
  if (hour == null || !date) return false;

  const sched = scheduleFor(count.branch, date.year, date.month, date.day);
  if (!sched) return false;

  return hoursApart(hour, sched.open) <= TOLERANCE_HOURS;
}

/**
 * True if this count was filed at (or near) its branch's scheduled CLOSING time
 * for the shift it belongs to.
 */
function isScheduledClosing(count) {
  if (!count) return false;
  if (count.phase && count.phase.toLowerCase() !== 'closing') return false;

  const hour = decimalHour(count.timestamp);
  const date = dateParts(count.timestamp);
  if (hour == null || !date) return false;

  const shiftDate = shiftDateForClose(count.branch, date.year, date.month, date.day, hour);
  const sched = scheduleFor(count.branch, shiftDate.year, shiftDate.month, shiftDate.day);
  if (!sched) return false;

  return hoursApart(hour, sched.close) <= TOLERANCE_HOURS;
}

function fmtHour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${suffix}`;
}

/**
 * Human-readable window label for a report header, e.g. "11AM → 5AM".
 *
 * An OPENING count dates the shift by its own calendar day. Only a CLOSING
 * count may need rolling back a day (a 5AM close belongs to yesterday's shift).
 */
function windowLabel(count) {
  const hour = decimalHour(count.timestamp);
  const date = dateParts(count.timestamp);
  if (hour == null || !date) return '';

  const isClosing = (count.phase || '').toLowerCase() === 'closing';
  const shiftDate = isClosing
    ? shiftDateForClose(count.branch, date.year, date.month, date.day, hour)
    : date;

  const sched = scheduleFor(count.branch, shiftDate.year, shiftDate.month, shiftDate.day);
  if (!sched) return '';

  // Only call out the weekend/holiday schedule when it actually differs from the
  // weekday one — Alphaland runs the same hours all week, so the tag is noise there.
  const table = SCHEDULES[count.branch];
  const differs = table && (table.weekday.open !== table.weekend.open
                         || table.weekday.close !== table.weekend.close);
  const tag = sched.isWeekend && differs ? ' (weekend/holiday)' : '';

  return `${fmtHour(sched.open)} → ${fmtHour(sched.close)}${tag}`;
}

module.exports = {
  scheduleFor,
  shiftDateForClose,
  isScheduledOpening,
  isScheduledClosing,
  windowLabel,
  decimalHour,
  dateParts,
  hoursApart,
  TOLERANCE_HOURS
};
