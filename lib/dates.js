// Date helpers pinned to the company's timezone (WIB by default).
const TZ = process.env.APP_TZ || 'Asia/Jakarta';

function todayKey(date = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function formatDate(isoOrKey) {
  if (!isoOrKey) return '-';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrKey) ? new Date(`${isoOrKey}T12:00:00Z`) : new Date(isoOrKey);
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

function formatDateTime(iso) {
  return iso ? `${formatDate(iso)} ${formatTime(iso)}` : '-';
}

function minutesBetween(start, end) {
  // start/end are "HH:MM"; an end before start means it crosses midnight.
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let diff = eh * 60 + em - (sh * 60 + sm);
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

module.exports = { TZ, todayKey, formatTime, formatDate, formatDateTime, minutesBetween };
