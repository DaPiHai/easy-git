import { describe, expect, it } from 'vitest';
import { getLocale, setLocale, t } from './index';
import type { MessageKey } from './zh-CN';

describe('t', () => {
  it('returns the Chinese copy for known keys', () => {
    expect(t('tab.changes')).toBe('变更');
    expect(t('bottom.commandLens')).toBe('命令透视');
    expect(t('theme.system')).toBe('跟随系统');
  });

  it('falls back to the key itself when unmapped', () => {
    expect(t('future.missing' as MessageKey)).toBe('future.missing');
  });
});

describe('locale', () => {
  it('defaults to zh-CN and can be switched', () => {
    expect(getLocale()).toBe('zh-CN');
    setLocale('zh-CN');
  });
});
