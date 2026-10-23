export function nowIso() {
  return new Date().toISOString();
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function text(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, max);
}

