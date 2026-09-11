import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStatus, stagePaths } from './commands';
import { useBusyStore } from '../../stores/busyStore';

const { stageMock, statusMock } = vi.hoisted(() => ({
  stageMock: vi.fn(),
  statusMock: vi.fn(),
}));

// The generated bindings module is the only place IPC happens; stub the two
// commands this test exercises (plus the events export commands.ts re-exports).
vi.mock('./bindings', () => ({
  commands: { stage: stageMock, statusGet: statusMock },
  events: { repoChanged: { listen: vi.fn() }, syncProgress: { listen: vi.fn() } },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

describe('IPC wait indicator', () => {
  beforeEach(() => {
    stageMock.mockReset();
    statusMock.mockReset();
    useBusyStore.getState().reset();
  });

  afterEach(() => {
    useBusyStore.getState().reset();
  });

  it('marks a write command as running for its whole in-flight window', async () => {
    let resolveStage!: (value: unknown) => void;
    stageMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStage = resolve;
      }),
    );

    const pending = stagePaths('r1', ['a.txt'], 'stage');
    expect(useBusyStore.getState().stack).toHaveLength(1);
    expect(useBusyStore.getState().label).toBe('busy.stage');

    resolveStage({ status: 'ok', data: { repoId: 'r1' } });
    await pending;
    expect(useBusyStore.getState().stack).toHaveLength(0);
  });

  it('clears the marker when the command fails', async () => {
    stageMock.mockResolvedValue({ status: 'error', error: { code: 'internal' } });
    await expect(stagePaths('r1', ['a.txt'], 'stage')).rejects.toBeTruthy();
    expect(useBusyStore.getState().stack).toHaveLength(0);
  });

  it('leaves read-only commands silent', async () => {
    statusMock.mockResolvedValue({ status: 'ok', data: { repoId: 'r1' } });
    await getStatus('r1');
    expect(useBusyStore.getState().stack).toHaveLength(0);
  });
});
