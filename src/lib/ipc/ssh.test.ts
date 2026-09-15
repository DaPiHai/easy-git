import { describe, expect, it } from 'vitest';
import { isSshRepoPath } from './commands';
import { humanizeEgError } from './errors';

describe('isSshRepoPath', () => {
  it.each([
    'ssh://root@192.168.1.10/srv/repo',
    'ssh://root@host:2222/srv/repo',
    'ssh://host/srv/repo',
    'root@host:/srv/repo',
    'git@github.com:/u/r.git',
    'root@host:~/repos/app',
  ])('recognizes %s as an SSH coordinate', (input) => {
    expect(isSshRepoPath(input)).toBe(true);
  });

  it.each([
    'C:\\Users\\demo\\repo',
    'C:/Users/demo/repo',
    '/home/demo/repo',
    './relative/repo',
    'just-a-dir',
    'host:relative/path',
    'https://github.com/u/r.git',
    '',
  ])('rejects %s as a local path', (input) => {
    expect(isSshRepoPath(input)).toBe(false);
  });
});

describe('humanizeEgError SSH providers', () => {
  it('explains ssh-host-key failures with fingerprint guidance', () => {
    const result = humanizeEgError({
      code: 'auth',
      provider: 'ssh-host-key',
      detail: 'Host key verification failed.',
    });
    expect(result.detail).toContain('主机密钥');
    expect(result.reason).toContain('Host key verification failed.');
  });

  it('explains ssh-key failures with agent guidance', () => {
    const result = humanizeEgError({ code: 'auth', provider: 'ssh-key' });
    expect(result.detail).toContain('ssh-agent');
  });

  it('explains ssh-passphrase failures with unlock guidance', () => {
    const result = humanizeEgError({ code: 'auth', provider: 'ssh-passphrase' });
    expect(result.detail).toContain('ssh-add');
  });

  it('explains dns failures with the hostname', () => {
    const result = humanizeEgError({
      code: 'network',
      kind: 'dns',
      url: 'ssh://root@badhost/srv/repo',
    });
    expect(result.detail).toContain('无法解析服务器地址');
    expect(result.detail).toContain('badhost');
  });

  it('passes remote policy refusals through verbatim', () => {
    const result = humanizeEgError({
      code: 'not_supported',
      feature: '远端仓库默认禁用危险写（丢弃修改），请在服务器上直接操作',
    });
    expect(result.title).toBe('该功能尚未支持');
    expect(result.detail).toContain('远端仓库默认禁用危险写');
  });

  it('guides SSH users to check the remote path for repo_not_found', () => {
    const result = humanizeEgError({
      code: 'repo_not_found',
      path: 'ssh://hhdlj@192.168.5.3/home/hhdlj/easy-desktop',
      detail: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect(result.title).toBe('找不到仓库');
    expect(result.detail).toContain('ssh://hhdlj@192.168.5.3/home/hhdlj/easy-desktop');
    expect(result.detail).toContain('浏览远端目录');
    expect(result.reason).toContain('not a git repository');
  });
});
