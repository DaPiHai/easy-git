import { describe, expect, it } from 'vitest';
import { humanizeEgError } from './errors';

describe('humanizeEgError', () => {
  it('maps repo_not_found with the path and a picker hint', () => {
    const result = humanizeEgError({ code: 'repo_not_found', path: '/tmp/demo' });
    expect(result.title).toBe('找不到仓库');
    expect(result.detail).toContain('/tmp/demo');
    expect(result.hint?.action).toBe('open-repo-picker');
  });

  it('maps repo_ownership to the folder-ownership explanation with the raw reason', () => {
    const result = humanizeEgError({
      code: 'repo_ownership',
      path: 'C:\\demo',
      detail: "repository path 'C:/demo' is not owned by current user",
    });
    expect(result.title).toBe('无法打开这个文件夹');
    expect(result.detail).toContain('C:\\demo');
    expect(result.detail).toContain('Git 出于安全默认拒绝访问');
    expect(result.reason).toContain('is not owned by current user');
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

  it('ssh_not_a_repo with exists=true offers an init action and reconstructs the URI', () => {
    const result = humanizeEgError({
      code: 'ssh_not_a_repo',
      target: { host: '192.168.5.3', port: 22, user: 'hhdlj', path: '/home/hhdlj/easy-desktop' },
      exists: true,
      detail: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect(result.title).toBe('远端路径不是 Git 仓库');
    expect(result.detail).toContain('ssh://hhdlj@192.168.5.3/home/hhdlj/easy-desktop');
    expect(result.detail).toContain('尚未初始化为 Git 仓库');
    expect(result.hint?.action).toBe('init-ssh-repo');
    expect(result.hint?.label).toBe('在此初始化仓库');
    expect(result.reason).toContain('not a git repository');
  });

  it('ssh_not_a_repo with exists=false points at the picker, not init', () => {
    const result = humanizeEgError({
      code: 'ssh_not_a_repo',
      target: { host: 'host', port: 22, user: null, path: '/srv/missing' },
      exists: false,
    });
    expect(result.detail).toContain('不存在');
    expect(result.hint?.action).toBe('open-repo-picker');
  });
});
