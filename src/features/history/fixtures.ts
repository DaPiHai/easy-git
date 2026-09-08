import type { CommitLogEntry } from '../../lib/ipc/commands';

/** Shared CommitLogEntry builder for W5 tests and the snapshot harness. */
export function entry(overrides: Partial<CommitLogEntry> = {}): CommitLogEntry {
  return {
    oid: '0123456789abcdef0123456789abcdef01234567',
    shortOid: '0123456',
    subject: 'feat: something',
    body: '',
    authorName: '张三',
    authorEmail: 'z@ex.com',
    authorTime: Math.floor(Date.now() / 1000),
    parentCount: 1,
    isHead: false,
    refs: { branches: [], remotes: [], tags: [] },
    node: { lane: 0, color: 0, merge: false },
    lines: [{ from: 0, to: 0, color: 0 }],
    laneCount: 1,
    ...overrides,
  };
}
