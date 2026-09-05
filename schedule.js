const TOLERANCE_HOURS = 2;
const SCHEDULES = {
  Solaire: { weekday: { open: 11, close: 5, overnight: true }, weekend: { open: 9, close: 5, overnight: true } },
  Alphaland: { weekday: { open: 10, close: 21, overnight: false }, weekend: { open: 10, close: 21, overnight: false } }
};

// Only Solaire needs a specific shift NAME to identify the true start/end of
// day — it always runs multiple named shifts back to back (Morning ->
// Mid-Shift -> ... -> Night), so the phase alone is ambiguous (Morning's own
// close is a mid-day handover, not the real end of day).
//
// Alphaland does NOT get this treatment: on weekdays it's two tellers
// (Morning, Mid-Shift), on weekends it's one teller alone all day (Morning
// open -> Morning close, no Mid-Shift at all) -- the shift NAME that ends up
// on the "real" closing count varies by staffing, not by a fixed pattern.
// For Alphaland we trust phase + time-of-day only: whichever count is
// tagged "Closing" and lands near the scheduled close hour IS the real
// close, whatever shift name it happens to carry that day.
const OPENING_SHIFT_NAME = { Solaire: 'Morning' };
const CLOSING_SHIFT_NAME = { Solaire: 'Night' };

function holidaySet() { return new Set((process.env.HOLIDAYS || '').split(',').map(s => s.trim()).filter(Boolean)); }
function manilaDayOfWeek(y,m,d) { return new Date(Date.UTC(y,m-1,d)).getUTCDay(); }
function isoDate(y,m,d) { return new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10); }
function scheduleFor(branch,y,m,d) { const t=SCHEDULES[branch]; if(!t) return null; const dow=manilaDayOfWeek(y,m,d); const w=dow===0||dow===6||holidaySet().has(isoDate(y,m,d)); return {...(w?t.weekend:t.weekday), isWeekend:w}; }
function shiftDateForClose(branch,y,m,d,hour) { const t=SCHEDULES[branch]; if(!t) return {year:y,month:m,day:d}; const o=t.weekday.overnight||t.weekend.overnight; if(o&&hour<12){const dd=new Date(Date.UTC(y,m-1,d-1)); return {year:dd.getUTCFullYear(),month:dd.getUTCMonth()+1,day:dd.getUTCDate()};} return {year:y,month:m,day:d}; }
function hoursApart(a,b){return Math.min(Math.abs(a-b),24-Math.abs(a-b));}
function decimalHour(ts){const m=(ts||'').match(/(\d{1,2}):(\d{2}):\d{2}/);if(!m)return null;return parseInt(m[1],10)+parseInt(m[2],10)/60;}
function dateParts(ts){const m=(ts||'').match(/(\d{2})\/(\d{2})\/(\d{4})/);if(!m)return null;return {month:Number(m[1]),day:Number(m[2]),year:Number(m[3])};}

function isScheduledOpening(count){
  if(!count)return false;
  if(count.phase&&count.phase.toLowerCase()!=='opening')return false;
  const wantShift = OPENING_SHIFT_NAME[count.branch];
  if (wantShift && count.shift !== wantShift) return false;
  const h=decimalHour(count.timestamp),d=dateParts(count.timestamp);
  if(h==null||!d)return false;
  const s=scheduleFor(count.branch,d.year,d.month,d.day);
  if(!s)return false;
  return hoursApart(h,s.open)<=TOLERANCE_HOURS;
}
function isScheduledClosing(count){
  if(!count)return false;
  if(count.phase&&count.phase.toLowerCase()!=='closing')return false;
  const wantShift = CLOSING_SHIFT_NAME[count.branch];
  if (wantShift && count.shift !== wantShift) return false;
  const h=decimalHour(count.timestamp),d=dateParts(count.timestamp);
  if(h==null||!d)return false;
  const sd=shiftDateForClose(count.branch,d.year,d.month,d.day,h);
  const s=scheduleFor(count.branch,sd.year,sd.month,sd.day);
  if(!s)return false;
  return hoursApart(h,s.close)<=TOLERANCE_HOURS;
}
function fmtHour(h){const s=h>=12?'PM':'AM';const d=h%12===0?12:h%12;return `${d}${s}`;}
function windowLabel(count){
  const h=decimalHour(count.timestamp),d=dateParts(count.timestamp);
  if(h==null||!d)return '';
  const isClosing=(count.phase||'').toLowerCase()==='closing';
  const sd=isClosing?shiftDateForClose(count.branch,d.year,d.month,d.day,h):d;
  const s=scheduleFor(count.branch,sd.year,sd.month,sd.day);
  if(!s)return '';
  const t=SCHEDULES[count.branch];
  const diff=t&&(t.weekday.open!==t.weekend.open||t.weekday.close!==t.weekend.close);
  const tag=s.isWeekend&&diff?' (weekend/holiday)':'';
  return `${fmtHour(s.open)} → ${fmtHour(s.close)}${tag}`;
}
module.exports = { scheduleFor, shiftDateForClose, isScheduledOpening, isScheduledClosing, windowLabel, decimalHour, dateParts, hoursApart, TOLERANCE_HOURS };
