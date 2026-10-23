export function formatBytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1));
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

export function bytesToGb(value) {
  return value ? Math.round((value / 1024 ** 3) * 10) / 10 : 0;
}

export function gbToBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1024 ** 3) : 0;
}

export function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function shortDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', year: 'numeric' })
    .format(new Date(value));
}

export function relativeTime(value) {
  if (!value) return '从未连接';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return '刚刚在线';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return shortDate(value);
}

