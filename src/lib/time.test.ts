import { describe, expect, it } from 'vitest';
import { authorInitial, formatRelativeTime } from './time';

describe('formatRelativeTime (UI doc §6.7)', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0); // 2026-09-08 12:00

  it('formats minutes, hours and days relatively', () => {
    expect(formatRelativeTime(now / 1000 - 30, now)).toBe('刚刚');
    expect(formatRelativeTime(now / 1000 - 5 * 60, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now / 1000 - 3 * 3600, now)).toBe('3 小时前');
    expect(formatRelativeTime(now / 1000 - 2 * 86400, now)).toBe('2 天前');
  });

  it('falls back to a date beyond a month', () => {
    expect(formatRelativeTime(now / 1000 - 60 * 86400, now)).toBe('2026-07-10');
  });
});

describe('authorInitial', () => {
  it('returns the uppercased first code point, CJK included', () => {
    expect(authorInitial('张三')).toBe('张');
    expect(authorInitial('alice')).toBe('A');
    expect(authorInitial('  bob ')).toBe('B');
    expect(authorInitial('')).toBe('?');
  });
});
