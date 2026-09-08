/** Relative-time formatting for history rows (UI doc §6.7 元信息列). */
export function formatRelativeTime(epochSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, now / 1000 - epochSeconds);
  const minutes = Math.floor(diff / 60);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Initial letter for the 16px author avatar circle. */
export function authorInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const codePoint = trimmed.codePointAt(0) ?? 63;
  return String.fromCodePoint(codePoint).toUpperCase();
}
