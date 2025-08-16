// utils/maintenance.js
const MAINT_START = Number(process.env.MAINT_START || 3); // 3 AM
const MAINT_END   = Number(process.env.MAINT_END   || 7); // 7 AM
const MAINT_TZ    = process.env.MAINT_TZ || 'Asia/Beirut'; // غيّرها إذا بدك

function getLocalHourInTZ(date = new Date(), tz = MAINT_TZ) {
  // يرجّع الساعة المحلية (0..23) لمنطقة زمنية محدّدة
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit'
  }).formatToParts(date);
  const hh = parts.find(p => p.type === 'hour')?.value || '00';
  return Number(hh);
}

function isWithinWindow(hour, start, end) {
  // يدعم نافذة عابرة لمنتصف الليل (مثلاً 23 -> 04)
  if (start === end) return false; // لا نافذة
  if (start < end)  return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function isMaintenance(now = new Date()) {
  const h = getLocalHourInTZ(now);
  return isWithinWindow(h, MAINT_START, MAINT_END);
}

module.exports = { isMaintenance, MAINT_START, MAINT_END, MAINT_TZ };
