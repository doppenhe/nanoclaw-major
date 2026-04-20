import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'x',
  CONTAINER_MAX_OUTPUT_SIZE: 0,
  CONTAINER_TIMEOUT: 0,
  DATA_DIR: '/tmp',
  GROUPS_DIR: '/tmp',
  IDLE_TIMEOUT: 0,
  ONECLI_API_KEY: '',
  ONECLI_URL: 'http://x',
  TIMEZONE: 'UTC',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: () => [],
  stopContainer: vi.fn(),
}));

vi.mock('./mount-security.js', () => ({ validateAdditionalMounts: () => [] }));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn();
  },
}));

const { fsMock, execSyncMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  execSyncMock: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, ...fsMock } };
});

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execSync: execSyncMock };
});

import { resolveGithubTokenForMounts } from './container-runner.js';

const mount = (
  hostPath: string,
  readonly: boolean,
): { hostPath: string; containerPath: string; readonly: boolean } => ({
  hostPath,
  containerPath: '/x',
  readonly,
});

describe('resolveGithubTokenForMounts', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    execSyncMock.mockReset();
  });

  it('returns null when no mount is a git checkout', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(
      resolveGithubTokenForMounts([mount('/groups/a', false)]),
    ).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('returns null when a git checkout points at an unrelated remote', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      '[remote "origin"]\n\turl = https://github.com/someone-else/repo.git\n',
    );
    expect(
      resolveGithubTokenForMounts([mount('/groups/a', false)]),
    ).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('ignores readonly mounts even if they point at doppenhe/*', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      '[remote "origin"]\n\turl = https://github.com/doppenhe/major_wiki.git\n',
    );
    expect(
      resolveGithubTokenForMounts([mount('/groups/global', true)]),
    ).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('resolves the token when a writable mount points at doppenhe/*', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      '[remote "origin"]\n\turl = https://github.com/doppenhe/major_content.git\n',
    );
    execSyncMock.mockReturnValue('github_pat_testtoken\n');
    const token = resolveGithubTokenForMounts([
      mount('/groups/telegram_main', false),
    ]);
    expect(token).toBe('github_pat_testtoken');
    expect(execSyncMock).toHaveBeenCalledWith(
      'gh auth token -u doppenhe',
      expect.any(Object),
    );
  });

  it('throws loudly when gh auth fails for a doppenhe/* mount', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      '[remote "origin"]\n\turl = https://github.com/doppenhe/major_wiki.git\n',
    );
    execSyncMock.mockImplementation(() => {
      throw new Error('no token');
    });
    expect(() =>
      resolveGithubTokenForMounts([mount('/groups/global', false)]),
    ).toThrow(/gh auth login --hostname github.com --user doppenhe/);
  });
});
