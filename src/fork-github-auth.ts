/**
 * FORK-LOCAL — GitHub push auth for agent containers.
 *
 * Not upstream. Lives in its own module so the weekly `upstream/main` merge
 * touches as little of `container-runner.ts` as possible: that file is now the
 * session-spec composition hot path and upstream rewrites it often. Everything
 * fork-specific about GitHub auth is here; `container-runner.ts` carries three
 * call sites and nothing else.
 *
 * ## Why a file and not an env var
 *
 * Before the session-driver seam (upstream 2026-08-18) the host resolved a
 * token with `gh auth token` and passed it to the container as a value-less
 * `-e GH_TOKEN`, inheriting the value from the spawn process env. The container
 * image installs a system git credential helper that reads `$GH_TOKEN`.
 *
 * `validateSpec` (src/drivers/types.ts) now refuses that shape on every lane:
 * a `_TOKEN`-suffixed key is denied on `env`, and a `gho_`/`ghp_`-shaped VALUE
 * is denied on both `env` and `contributedEnv`. Admission is fail-closed, so
 * wiring the old shape back would abort every spawn that mounts a doppenhe/*
 * checkout — not degrade, abort.
 *
 * The sanctioned alternative is the by-reference pattern the same file
 * documents: put the material in a file, mount it read-only, and pass the
 * PATH in the env var. `isSecretShaped` short-circuits to false on an
 * absolute-path value precisely so this works ("A path is a pointer, never a
 * credential").
 *
 * ## What this does and does not buy
 *
 * This restores the previous capability and, honestly, the previous exposure:
 * an agent that can read `/run/nanoclaw/gh-token` holds a GitHub token just as
 * it did when the token sat in its environment. What changes is that the
 * credential no longer rides the spec's env lanes, so admission passes and the
 * blast radius is a mount the policy can see and reason about.
 *
 * The token file is written under `data/gh-tokens/`, deliberately NOT inside
 * the session directory: that directory is mounted read-write at `/workspace`,
 * so a token placed there would be readable — and committable — from the
 * agent's own working tree.
 *
 * OneCLI is not an option for this host. Its gateway special-cases github.com,
 * ignores `generic` vault secrets for it, and returns 401 for raw PATs.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

/** Where the read-only token mount lands inside the container. */
export const GH_TOKEN_CONTAINER_PATH = '/run/nanoclaw/gh-token';

/** Host directory holding per-session token files. Never mounted read-write. */
const GH_TOKEN_DIR = path.join(DATA_DIR, 'gh-tokens');

/**
 * Resolve a GitHub token if any writable mount is a git checkout of a
 * doppenhe/* repo. Returns null when no such mount exists.
 *
 * Throws when a doppenhe/* checkout IS mounted but the token cannot be
 * resolved: failing at spawn is better than handing the agent a container in
 * which every push silently 403s.
 */
export function resolveGithubTokenForMounts(mounts: VolumeMount[]): string | null {
  const needsToken = mounts.some((m) => {
    if (m.readonly) return false;
    const configPath = path.join(m.hostPath, '.git', 'config');
    if (!fs.existsSync(configPath)) return false;
    return /github\.com[/:]doppenhe\//.test(fs.readFileSync(configPath, 'utf-8'));
  });
  if (!needsToken) return null;
  try {
    return execSync('gh auth token -u doppenhe', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new Error(
      'Container mounts a doppenhe/* git repo but `gh auth token -u doppenhe` failed. Run: gh auth login --hostname github.com --user doppenhe',
      { cause: err },
    );
  }
}

function tokenFilePath(sessionId: string): string {
  return path.join(GH_TOKEN_DIR, `${sessionId}.token`);
}

/**
 * Write the session's token to a 0600 host file and return the read-only mount
 * that exposes it. Returns null when no doppenhe/* checkout is mounted, which
 * is the common case — most sessions get no GitHub auth at all.
 *
 * Classed `allowlisted-extra`: `group-state` is pinned by admission to the
 * session's own `groups/<folder>` or `v2-sessions/<group>` subtree and this
 * path is under neither, and `identity-material` is barred from the agent role
 * outright. `allowlisted-extra` is the only class that admits a host-composed
 * mount at an arbitrary path.
 */
export function composeGithubTokenMount(
  mounts: VolumeMount[],
  agentGroupId: string,
  sessionId: string,
): VolumeMount | null {
  const token = resolveGithubTokenForMounts(mounts);
  if (!token) return null;

  fs.mkdirSync(GH_TOKEN_DIR, { recursive: true, mode: 0o700 });
  const hostPath = tokenFilePath(sessionId);
  // Write via a 0600-from-birth handle rather than writeFileSync + chmod:
  // the latter leaves a window in which the token is world-readable.
  fs.writeFileSync(hostPath, token, { mode: 0o600, flag: 'w' });
  fs.chmodSync(hostPath, 0o600); // Re-assert: `mode` is ignored on an existing file.

  log.info('GitHub token mount composed', { sessionId, agentGroupId });
  return {
    hostPath,
    containerPath: GH_TOKEN_CONTAINER_PATH,
    readonly: true,
    mountClass: 'allowlisted-extra',
    scope: agentGroupId,
  };
}

/**
 * The env the container credential helper reads. Derived from the composed
 * mounts rather than passed alongside them, so the env and the mount can never
 * disagree — a `GH_TOKEN_FILE` pointing at a path that was not mounted is a
 * failure mode this shape cannot express.
 *
 * The key is `GH_TOKEN_FILE`, not `GH_TOKEN`: the value is an absolute path,
 * which `isSecretShaped` exempts, and the `_FILE` suffix keeps it clear of the
 * `_TOKEN` name check for a reader who has not read that function.
 */
export function githubAuthEnv(mounts: VolumeMount[]): Record<string, string> {
  const mounted = mounts.some((m) => m.containerPath === GH_TOKEN_CONTAINER_PATH);
  if (!mounted) return {};
  return {
    GH_TOKEN_FILE: GH_TOKEN_CONTAINER_PATH,
    // The OneCLI gateway special-cases github.com and rejects raw PATs, so git
    // traffic has to skip the proxy entirely and use the credential helper.
    NO_PROXY: 'github.com,api.github.com',
    no_proxy: 'github.com,api.github.com',
  };
}

/** Remove a session's token file. Best-effort: called from the exit path. */
export function cleanupGithubTokenFile(sessionId: string): void {
  try {
    fs.rmSync(tokenFilePath(sessionId), { force: true });
  } catch (err) {
    log.warn('Failed to remove GitHub token file', { sessionId, err });
  }
}
