/**
 * FORK-LOCAL — the GitHub push-auth path, checked against the real admission
 * rules.
 *
 * The point of these cases is narrow and load-bearing: the pre-driver-seam
 * shape of this feature (`GH_TOKEN=<value>` in container env) is now REFUSED
 * by `validateSpec`, fail-closed, which would abort every spawn that mounts a
 * doppenhe/* checkout. So the suite asserts both directions — the new
 * by-reference shape passes admission, and the old shape still does not. The
 * second half is the regression guard: without it, someone "simplifying" this
 * back to an env var gets a green suite and a host that cannot spawn.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GH_TOKEN_CONTAINER_PATH, forkNoProxyEnv, githubAuthEnv } from './fork-github-auth.js';
import { FIXTURE_POLICY, fixtureSpec } from './drivers/spec-fixture.js';
import { isSecretShaped, validateSpec, type MountSpec, type SessionSpec } from './drivers/types.js';

/** A realistic OAuth token — the `gho_` prefix is what `looksLikeCredential` keys on. */
const REAL_TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';

/** The spec fixture plus a session's GitHub auth, in the by-reference shape. */
function specWithGithubAuth(overrides: { env?: Record<string, string>; mounts?: MountSpec[] } = {}): SessionSpec {
  const spec = fixtureSpec();
  const agent = spec.containers[0]!;
  return {
    ...spec,
    containers: [
      {
        ...agent,
        env: {
          ...agent.env,
          ...(overrides.env ?? { GH_TOKEN_FILE: GH_TOKEN_CONTAINER_PATH }),
        },
        mounts: [
          ...agent.mounts,
          ...(overrides.mounts ?? [
            {
              class: 'allowlisted-extra' as const,
              hostPath: `${FIXTURE_POLICY.dataRoot}/gh-tokens/s1.token`,
              containerPath: GH_TOKEN_CONTAINER_PATH,
              mode: 'ro' as const,
              groupScope: 'g1',
            },
          ]),
        ],
      },
      ...spec.containers.slice(1),
    ],
  };
}

describe('fork GitHub auth — admission', () => {
  it('the by-reference shape passes validateSpec', () => {
    expect(() => validateSpec(specWithGithubAuth(), FIXTURE_POLICY)).not.toThrow();
  });

  it('the pre-seam shape (token value in env) is refused — this is why the rework exists', () => {
    const spec = specWithGithubAuth({ env: { GH_TOKEN: REAL_TOKEN }, mounts: [] });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/denied-by-policy/);
  });

  it('is refused even under an innocuous key — the value is what admission catches', () => {
    const spec = specWithGithubAuth({ env: { GH_CREDENTIAL: REAL_TOKEN }, mounts: [] });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/denied-by-policy/);
  });

  it('an absolute path is not secret-shaped, whatever the key is called', () => {
    expect(isSecretShaped('GH_TOKEN_FILE', GH_TOKEN_CONTAINER_PATH)).toBe(false);
    expect(isSecretShaped('GH_TOKEN', REAL_TOKEN)).toBe(true);
  });

  it('classing the token mount as identity-material is refused on the agent role', () => {
    // identity-material is barred from the agent container outright, which is
    // why the mount is allowlisted-extra. Pinning that here so the class is not
    // "tidied" into the one that reads more correct but cannot be realized.
    const spec = specWithGithubAuth({
      mounts: [
        {
          class: 'identity-material',
          hostPath: `${FIXTURE_POLICY.materialsRoot}/s1.token`,
          containerPath: GH_TOKEN_CONTAINER_PATH,
          mode: 'ro',
          groupScope: 'g1',
        },
      ],
    });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/denied-by-policy/);
  });
});

describe('githubAuthEnv', () => {
  const mounted = [{ hostPath: '/x', containerPath: GH_TOKEN_CONTAINER_PATH, readonly: true }];

  it('is empty when no token mount was composed — the common session', () => {
    expect(githubAuthEnv([{ hostPath: '/x', containerPath: '/workspace', readonly: false }])).toEqual({});
  });

  it('points at the mount and bypasses the OneCLI proxy for github', () => {
    const env = githubAuthEnv(mounted);
    expect(env.GH_TOKEN_FILE).toBe(GH_TOKEN_CONTAINER_PATH);
    // OneCLI special-cases github.com and rejects raw PATs; git has to skip it.
    expect(env.NO_PROXY).toContain('github.com');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('forkNoProxyEnv bypasses the gateway for github and the docker-bridge host', () => {
    const env = forkNoProxyEnv();
    // github: OneCLI rejects raw PATs. host.docker.internal: the gateway cannot
    // resolve it and a bridge-IP vault secret would clobber Authorization
    // (the 2026-08-27 shmem 401).
    for (const host of ['github.com', 'api.github.com', 'host.docker.internal']) {
      expect(env.NO_PROXY.split(',')).toContain(host);
    }
    expect(env.no_proxy).toBe(env.NO_PROXY);
    // The always-on lane and the token-mount lane must agree, or the narrower
    // one would win the spread and silently re-route shmem through the proxy.
    expect(githubAuthEnv(mounted).NO_PROXY).toBe(env.NO_PROXY);
  });

  it('emits no credential-valued entry — every value survives isSecretShaped', () => {
    for (const [key, value] of Object.entries(githubAuthEnv(mounted))) {
      expect(isSecretShaped(key, value)).toBe(false);
    }
  });
});

describe('composeGithubTokenMount', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-gh-auth-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no writable mount is a doppenhe checkout', async () => {
    const { composeGithubTokenMount } = await import('./fork-github-auth.js');
    // A git checkout, but not one of ours — and `gh auth token` is never
    // reached, so this also proves the common session does no subprocess work.
    const repo = path.join(tempDir, 'other');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.git', 'config'),
      '[remote "origin"]\n  url = git@github.com:someoneelse/x.git\n',
    );

    expect(
      composeGithubTokenMount([{ hostPath: repo, containerPath: '/workspace/agent', readonly: false }], 'g1', 's1'),
    ).toBeNull();
  });

  it('ignores a doppenhe checkout mounted read-only — nothing can be pushed from it', async () => {
    const { composeGithubTokenMount } = await import('./fork-github-auth.js');
    const repo = path.join(tempDir, 'ours-ro');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n  url = git@github.com:doppenhe/x.git\n');

    expect(
      composeGithubTokenMount([{ hostPath: repo, containerPath: '/workspace/global', readonly: true }], 'g1', 's1'),
    ).toBeNull();
  });
});
