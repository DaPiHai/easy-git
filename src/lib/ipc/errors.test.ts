import { describe, expect, it } from 'vitest';
import { humanizeEgError } from './errors';

describe('humanizeEgError', () => {
  it('maps repo_not_found with the path and a picker hint', () => {
    const result = humanizeEgError({ code: 'repo_not_found', path: '/tmp/demo' });
    expect(result.title).toBe('找不到仓库');
    expect(result.detail).toContain('/tmp/demo');
    expect(result.hint?.action).toBe('open-repo-picker');
  });

  it('maps auth with the provider name', () => {
    const result = humanizeEgError({ code: 'auth', provider: 'GitLab' });
    expect(result.detail).toContain('GitLab');
    expect(result.hint?.label).toBe('管理凭据');
  });

  it('maps conflict_state to the wizard hint', () => {
    const result = humanizeEgError({ code: 'conflict_state', state: 'merge' });
    expect(result.hint?.action).toBe('open-conflict-wizard');
  });

  it('returns no hint for cancelled', () => {
    const result = humanizeEgError({ code: 'cancelled' });
    expect(result.hint).toBeUndefined();
  });

  it('maps git_missing to the install guidance', () => {
    const result = humanizeEgError({ code: 'git_missing' });
    expect(result.title).toBe('未检测到 Git');
    expect(result.detail).toContain('2.30');
    expect(result.hint?.action).toBe('open-git-download');
  });

  it('degrades unknown codes to the generic fallback', () => {
    const result = humanizeEgError({ code: 'some_future_code' });
    expect(result.title).toBe('出了点问题');
    expect(result.hint?.action).toBe('open-logs');
  });

  it('carries the structured detail as the technical reason', () => {
    const result = humanizeEgError({
      code: 'network',
      kind: 'connect',
      url: 'origin',
      detail: 'fatal: could not resolve host: host',
    });
    expect(result.reason).toBe('fatal: could not resolve host: host');
    expect(result.detail).toContain('origin');
  });

  it('omits the reason when the core sent none', () => {
    const result = humanizeEgError({ code: 'auth', provider: 'git' });
    expect(result.reason).toBeUndefined();
  });

  it('exposes internal context as the reason instead of inline detail', () => {
    const result = humanizeEgError({ code: 'internal', context: 'git gc failed: boom' });
    expect(result.reason).toBe('git gc failed: boom');
    expect(result.detail).not.toContain('boom');
  });

  it('keeps repo_not_found path clean and moves the libgit2 message to the reason', () => {
    const result = humanizeEgError({
      code: 'repo_not_found',
      path: '/tmp/demo',
      detail: 'invalid repository path',
    });
    expect(result.detail).toBe('路径「/tmp/demo」不是一个 Git 仓库');
    expect(result.reason).toBe('invalid repository path');
  });
});
