# Local customizations (v2)

What this NanoClaw v2 install carries on top of `qwibitai/nanoclaw` upstream main, and how to keep both working over time. Personal ledger; not meant to merge upstream.

The v1 ledger (formerly at this path on the v1 install) covered the WhatsApp/Telegram channel forks and the agent-runner image-vision/voice/PDF skill suite. v2's architecture is different — channels are skill-installed and the agent runtime is in `container/agent-runner/` (Bun, not the v1 dual-build). This file tracks v2-only divergence.

## TL;DR — staying updateable

1. Run `/update-nanoclaw` regularly. Keep deltas small.
2. **Do** refresh channel/provider source from the registry branches on every
   upgrade — `/update-skills`, or the equivalent checkout from
   `upstream/channels`. See the correction below before trusting older habits.
3. Our own skills in `.claude/skills/` (`add-shmem`, `add-clidash`, the local
   operational ones) are authored here and committed in main. Nothing upstream
   overwrites them, and `/update-skills` does not touch them.
4. Watch the divergence hotspots below — those are the lines that will conflict.

Related: [weekly-upgrade-job.md](weekly-upgrade-job.md) is the scheduled
upgrade task's prompt and the reasoning behind its shape;
[UPGRADE-2026-08-23.md](UPGRADE-2026-08-23.md) is the host-side runbook for
landing a big upgrade by hand.

### Correction (2026-08-23): the `/update-skills` ban was wrong

This file used to say *"Do not run `/update-skills`. Our skills are committed in
main; upstream `skill/*` branches are stale."* The premise was right and the
conclusion did not follow, and it cost us an outage.

Two different sets of branches were being conflated:

| Branch set | Status | What reads it |
|---|---|---|
| `skill/compact`, `skill/apple-container`, … | **Frozen legacy.** Upstream's own [BRANCH-FORK-MAINTENANCE.md](BRANCH-FORK-MAINTENANCE.md) says don't forward-merge them. | nothing, any more |
| `channels`, `providers` | **Live registry branches**, maintained with main | `/update-skills`, `/add-<channel>` |

`/update-skills` reads the second row. Banning it on evidence about the first
row left `src/channels/telegram.ts` pinned at the copy vendored in May
(f940c527). On 2026-08-19 upstream made central DB access async; our pinned
adapter still called those functions synchronously, and the 2026-08-23 weekly
upgrade failed to compile. The fix was a one-command refresh from
`upstream/channels`, which also brought a formatting bug fix we had been
carrying (see the Telegram entry below).

The durable rule: **adapter source under `src/channels/` and `src/providers/`
tracks the registry branches and must be refreshed whenever upstream changes an
API it calls. Skills we authored under `.claude/skills/` are ours and are never
refreshed from upstream.** Both statements are true at once; the old rule
collapsed them into one.

## Divergence hotspots (v2)

### Container build cache mounts stripped (no `--mount=type=cache`)

| What | Where |
|---|---|
| `container/Dockerfile` | 5 `RUN --mount=type=cache,target=...` directives removed |

**Why:** This host's Docker daemon (28.2.2 on Ubuntu Noble) does not have the buildx component. Legacy builder rejects cache mounts. Upstream's Dockerfile assumes BuildKit/buildx. Re-add cache mounts only if `docker buildx version` succeeds here in the future.

### GitHub credential injection for `doppenhe/*` mounts

**Reworked 2026-08-23 from env-var to by-reference.** The old shape (value-less
`-e GH_TOKEN`, value inherited from the spawn process env) is now refused by
upstream admission — see "How it broke and why" below.

| What | Where |
|---|---|
| `src/fork-github-auth.ts` | **All of it.** Deliberately its own module, not inline in `container-runner.ts`: that file is upstream's session-spec composition hot path and gets rewritten often, so keeping our logic out of it turns a seven-hunk merge conflict into three call sites. |
| `src/fork-github-auth.ts` — `resolveGithubTokenForMounts(mounts)` | Scans writable mounts for `.git/config` matching `doppenhe/*`; if any, calls `gh auth token -u doppenhe`. Throws loudly if `gh auth` fails. |
| `src/fork-github-auth.ts` — `composeGithubTokenMount(...)` | Writes the token to `data/gh-tokens/<session>.token` at 0600 and returns a read-only mount to `/run/nanoclaw/gh-token`, classed `allowlisted-extra`. |
| `src/fork-github-auth.ts` — `githubAuthEnv(mounts)` | Derives `GH_TOKEN_FILE` + `NO_PROXY` **from the composed mounts**, so the pointer and the file can never disagree. Empty for the common session. |
| `src/fork-github-auth.ts` — `cleanupGithubTokenFile(id)` | Called from the exit path; a live credential does not outlive its session. |
| `src/container-runner.ts` | Three lines only: the import, `composeGithubTokenMount(...)` at the end of `buildMounts()` (after operator `additionalMounts`, which is how a doppenhe checkout usually arrives), and `...githubAuthEnv(mounts)` in `composeSessionSpec()`'s `env`. |
| `container/Dockerfile` — system git credential helper | Reads `$GH_TOKEN_FILE` and `cat`s it; falls back to `$GH_TOKEN` so a hand-run container still authenticates. Responds only to `get`, never persists. |
| `src/fork-github-auth.test.ts` | Pins **both** directions against the real `validateSpec`. |

**Why:** Major's content/wiki workflows require `git push` from inside the container directly to `doppenhe/major_content` and `doppenhe/major_wiki`.

**How it broke and why the shape changed:** upstream's session-driver seam
(2026-08-18) added `validateSpec` in `src/drivers/types.ts`, which refuses a
`_TOKEN`-suffixed key on the `env` lane and a `gho_`/`ghp_`-shaped *value* on
both `env` and `contributedEnv`. Admission is fail-closed, so the old shape
would not have degraded — it would have aborted every spawn that mounts a
doppenhe checkout. The sanctioned alternative is the by-reference pattern the
same file documents: material in a file, mounted read-only, **path** in the env
var. `isSecretShaped` short-circuits to `false` on an absolute-path value
precisely so this works.

**Why the token file lives in `data/gh-tokens/`, not the session dir:** the
session directory is mounted read-write at `/workspace`. A token placed there
would be readable — and committable — from the agent's own working tree.

**Why `allowlisted-extra`:** `group-state` is pinned by admission to the
session's own `groups/<folder>` or `v2-sessions/<group>` subtree, and this path
is under neither. `identity-material` is barred from the agent role outright.
`allowlisted-extra` is the only class that admits a host-composed mount at an
arbitrary path. The test suite pins this so it is not "tidied" into a class that
reads more correct but cannot be realized.

**What this does NOT buy:** the same exposure as before. An agent that can read
`/run/nanoclaw/gh-token` holds a GitHub token exactly as it did when the token
sat in its environment. What changed is that admission can see the mount and
reason about it. Removing the exposure needs short-lived per-session tokens —
designed in [design/github-app-tokens.md](design/github-app-tokens.md), not built.

**Do not "simplify" this back to an env var.** `src/fork-github-auth.test.ts`
asserts the old shape is still refused, so the suite will catch it — that
assertion is the point of the test, not incidental coverage.

**Why bypass OneCLI for github specifically:** OneCLI's proxy special-cases `github.com` — it ignores `generic` vault secrets for that host and expects its own GitHub OAuth-app connection. A raw PAT in the vault is silently rejected (`HTTP 401 "invalid credentials"`). Bypassing the proxy for `github.com` lets the existing credential-helper + `$GH_TOKEN` path work. The PAT lives in Bitwarden (record-of-truth) and gh CLI (host-side credential store, queried per spawn). Tested 2026-05-20: clone + push from inside a fresh container succeeded only with NO_PROXY set; failed with `remote: invalid credentials` without it.

**Rotation:** generate fresh fine-grained PAT (Contents:RW on `major_content` + `major_wiki`), save to Bitwarden as `GITHUB_PAT_DOPPENHE`, then `echo <pat> | gh auth login --hostname github.com --with-token`. No restart needed — the next container spawn re-reads `gh auth token`.

**Failure mode:** if a `doppenhe/*` repo is mounted but `gh auth token -u doppenhe` errors, the spawn throws. No silent degradation. Fix: `gh auth login --hostname github.com --with-token`.

### Telegram adapter — tracks `upstream/channels`, no longer vendored

| What | Where |
|---|---|
| `src/channels/telegram.ts`, `src/channels/telegram-pairing.ts` (+ its test) | Refreshed from `upstream/channels` on 2026-08-23. **Not ours to edit** — refresh, don't patch. |
| `src/channels/telegram-markdown-sanitize.ts` (+ test) | **DELETED 2026-08-23.** Do not re-add. |
| `package.json` | `@chat-adapter/telegram` pinned `4.29.0` (fork commit f3846ecf). |

**Why the sanitizer is gone:** we carried a `transformOutboundText` hook that
downgraded legacy Markdown for the old converter. `@chat-adapter/telegram` >=
4.29 parses CommonMark and renders escaped MarkdownV2 itself, and running our
sanitizer in front of it turned `**bold**` into `*single-star*`, which the
adapter then parsed as emphasis and rendered *italic*. Upstream removed the hook
deliberately and documents the reason inline. We were pinned at 4.29.0 already,
so deleting it fixed a formatting bug we had been living with. Nothing else
imported it.

**Refresh procedure** (part of every upgrade — see the correction at the top):

```bash
git fetch upstream channels
for f in src/channels/telegram.ts src/channels/telegram-pairing.ts \
         src/channels/telegram-pairing.test.ts; do
  git checkout upstream/channels -- "$f"
done
```

If a refresh drops a file we still import, that is upstream retiring the
mechanism — read their inline comment before reinstating anything.

### Credential pattern (post 2026-05-20 consolidation)

The "BW + OneCLI" pattern is now the standard for HTTP API keys; git auth is the documented exception above.

| Credential | BW item | OneCLI vault | Injection | Used by |
|---|---|---|---|---|
| Anthropic API | (existing) | `Anthropic` | proxy (native handling) | All agents |
| AI Tinkerers | `AITINKERERS_API_KEY` | `AITINKERERS_API_KEY` host=`aitinkerers.org` Bearer | proxy header inject | telegram_main `ait-api` skill |
| Scrapecreators | (user choice) | `SCRAPECREATORS_API_KEY` host=`api.scrapecreators.com` `x-api-key` | proxy header inject | (no active consumer; future skills) |
| GitHub PAT (doppenhe) | `GITHUB_PAT_DOPPENHE` | **not in vault** (proxy can't inject) | 0600 host file, read-only mount at `/run/nanoclaw/gh-token`, path in `$GH_TOKEN_FILE`; git credential helper `cat`s it, bypassing proxy via NO_PROXY | `src/fork-github-auth.ts` for `doppenhe/*` repo mounts |

Plaintext key files (`*.ait_api_key`, `aitinkerers_api_key.txt`, `.scrape_creators_key`, `.github_token`) are banned. Browser sessions (`twitter_session.json`, `linkedin_session.json`) remain as files because they're multi-value cookie blobs that refresh in-use — different shape from API keys, no OneCLI fit.

#### Credential rotation playbook

Use this when the user says a token is expired, leaked, or needs to change. **Default to "test the existing key first" before assuming rotation is needed** — a 401 from one endpoint doesn't always mean the key is dead; check the proxy state too (see prior episode where AIT key was working but vault entry was missing).

**Diagnosis order, before rotating anything:**
1. Read the key from its source (`onecli secrets list` shows vault entries; gh CLI for github via `gh auth status`).
2. Test directly from the host with `curl` (bypasses OneCLI) — confirms whether the key itself is alive.
3. Test via `onecli run --agent <agent-id> -- curl ...` — confirms whether the proxy injection path works.
4. If host-direct works but proxy doesn't: vault is misconfigured (wrong host pattern, missing entry, agent in `selective` mode). Fix vault, not the key.
5. If both fail: key actually needs rotation.

**HTTP API keys (AIT, Scrapecreators, future):**

| Step | Command |
|---|---|
| 1. Generate new key | User obtains from the provider's dashboard (`aitinkerers.org/profile`, `scrapecreators.com`, etc.) |
| 2. Save to Bitwarden | User updates the BW item (`AITINKERERS_API_KEY` etc.) |
| 3. Find the vault entry ID | `onecli secrets list \| grep -B2 <NAME>` |
| 4. Update vault value | `onecli secrets update --id <id> --value <new>` (rotates without changing host/header config) |
| 5. Verify | `onecli run --agent <agent-id> -- curl ...` against a benign endpoint; confirm HTTP 200 |
| 6. No restart | Gateway resolves secrets per request — already-running containers pick up the new value on next call |

**GitHub PAT (doppenhe) — different path, do NOT try the vault:**

OneCLI's proxy special-cases `github.com` and rejects vault PATs. The PAT flows BW → gh CLI → `GH_TOKEN` env → container, bypassing OneCLI via `NO_PROXY=github.com`. See "GitHub credential injection for `doppenhe/*` mounts" above.

| Step | Command |
|---|---|
| 1. Generate fine-grained PAT | github.com/settings/personal-access-tokens. Scope: `doppenhe/major_content` + `doppenhe/major_wiki`. Permissions: **Contents: Read+Write**, Metadata: Read (auto). |
| 2. Save to Bitwarden | Update the `GITHUB_PAT_DOPPENHE` item |
| 3. Replace gh CLI token | `echo <pat> \| gh auth login --hostname github.com --with-token` |
| 4. Verify host can read it | `gh auth token -u doppenhe \| head -c 12` — expect `github_pat_1...` |
| 5. Verify from inside next container | After next session spawn: `docker exec <container> bash -c 'cd /tmp && git clone --depth 1 https://github.com/doppenhe/major_content.git t && rm -rf t'` — expect exit 0 |
| 6. No restart | `container-runner.ts` calls `gh auth token` at spawn time, so next container spawn picks up the new PAT. Already-running containers still hold the old PAT in env — kill them only if you need them refreshed before their natural exit. |

**Anthropic API key:** managed natively by OneCLI's `anthropic` secret type. Rotation is `onecli secrets update --id <Anthropic-id> --value <new>`. If Anthropic auth fails container-wide, also check OAuth token state via `/setup`.

**Common gotchas (learned the hard way):**
- New agent groups are created in `secretMode: selective` by default — even if the matching secret exists in the vault, it won't be injected. Fix: `onecli agents set-secret-mode --id <agent-id> --mode all` (or explicitly assign the secret). Major Telegram is already `all`.
- OneCLI vault is **write-only** — no `secrets get/show/reveal` command. You can't write a script that reads a value back out. Plan accordingly.
- Adding a secret with `--type generic` requires either `--header-name` or `--param-name` — the proxy needs to know HOW to inject. For Bearer auth: `--header-name Authorization --value-format "Bearer {value}"`. For API-key headers: `--header-name x-api-key --value-format "{value}"`.
- After rotating a key, the next container spawn doesn't need a restart of the nanoclaw service. The OneCLI gateway is shared, and `container-runner.ts` re-reads env at spawn time.

### shmem-mcp installed in container image (cross-session memory for Major)

> **⚠️ Superseded wiring (this section describes the original stdio+mount setup).** As of the ~2026-06-23 cutover, the Major groups no longer use the stdio `shmem-mcp` binary or the `~/.shmem/db` bind-mount. They connect to the **shared HTTP shmem server** (systemd, `http://172.17.0.1:8705/mcp`, Bearer auth, project `major`) — `mcp_servers.shmem = { type: "http", url, headers }`, `additional_mounts: []`. The Dockerfile layer, mount-allowlist entry, and `SHMEM_QA_PROVIDER=mock` notes below no longer apply to the live containers (synthesis happens server-side now). Kept for historical reference and single-host fallback.

**Recall enforcement (added 2026-06-30):**
- **Container agents** — the `shmem` MCP entry for both Major groups now carries an `instructions` field (canonical recall+capture text). `composeGroupClaudeMd()` auto-emits it as an `mcp-shmem.md` fragment into `CLAUDE.md` on every spawn (`src/claude-md-compose.ts:100-107`), so recall discipline is DB-driven and consistent instead of hand-copied into `CLAUDE.local.md`. Set via `updateContainerConfigJson` (the `ncl` CLI can't set it on an HTTP entry). Takes effect on next spawn. **Provider caveat:** the fragment is Claude-only — a switch to Codex/Gemini/OpenCode needs the same text mirrored into `container/AGENTS.md` / `GEMINI.md`.
- **Claude Code (diego's host CLI)** — global `SessionStart` hook `~/.claude/hooks/shmem-recall.sh` injects a `shmem ask` recall digest at every cold session start (skips resume/compact, non-fatal). Complements the existing capture hooks in `~/.claude/settings.json`. diego's personal shmem QA/classifier now run on OpenAI — see [[reference_shmem_local_cli_config]].

| What | Where |
|---|---|
| `container/Dockerfile` | New layer between Playwright env and Bun runtime. Downloads `shmem-mcp` v0.1.35 from `github.com/second-moment-ai/homebrew-tap/releases`, SHA-pinned, installs to `/usr/local/bin/`. |
| `~/.config/nanoclaw/mount-allowlist.json` | `/home/diego/.shmem/db` added to `allowedRoots` with `allowReadWrite: true`. |
| `data/v2.db` → `container_configs` row for `ag-1777914843751-fv7my8` (Major Telegram) and `ag-1777914843751-b0l4bv` (DMO Command and Conquer) | `mcp_servers.shmem = { command: "shmem-mcp", env: { SHMEM_PROJECT: "major", SHMEM_TREE_PATH: "/workspace/extra/shmem-db", SHMEM_QA_PROVIDER: "mock" } }` and `additional_mounts = [{ hostPath: "/home/diego/.shmem/db", containerPath: "shmem-db", readonly: false }]`. **`containerPath` must be relative** — NanoClaw's mount-security validator auto-prefixes `/workspace/extra/` and silently rejects (WARN-logged) any absolute path. |
| Host-side state | `~/.shmem/db/facts/shmem.db` (unified store). Project `major` registered via `shmem admin project create major`. |
| `groups/telegram_main/CLAUDE.local.md` + DMO mirror | New "Memory surfaces" + "shmem (long-term memory)" sections — write discipline for wiki vs `/workspace/agent/*.md` vs shmem. |

**Why:** Cross-session memory for content work — drafts considered, user pushback patterns, "we touched X last week". The Karpathy wiki captures stable knowledge; CLAUDE.local.md captures identity; `approved_posts.md` captures canonical published records; shmem captures conversational state. Different surfaces, different writers, do not duplicate.

**Why `SHMEM_QA_PROVIDER=mock`:** skips shmem's own LLM synthesis. Major does synthesis itself from raw `recall_memory` results — no extra credentials in the container.

**Restoring on a new host / from backup:** run `shmem admin project create major`, restore `~/.shmem/db/`, ensure mount allowlist contains `~/.shmem/db`, and re-add the two `mcp_servers.shmem` + `additional_mounts` rows to `container_configs`.

**Upgrade path:** when bumping `SHMEM_VERSION` in the Dockerfile, update the `SHMEM_SHA256` arg too. SHA values for each release live in the brew formula at `/home/linuxbrew/.linuxbrew/Homebrew/Library/Taps/second-moment-ai/homebrew-tap/shmem.rb` (under the `linux_amd64` block).

### shmem over HTTP: container wiring + health check (2026-08-27)

**What broke (found 2026-08-27):** the Major agents had silently lost memory. Two independent causes:
1. Upstream `ae81f976` (2026-08-11) made `src/container-config.ts` reject plain-HTTP MCP URLs unless the host is `localhost` / `127.0.0.1` / `host.docker.internal`. Our `http://172.17.0.1:8705/mcp` entry was **dropped at spawn** (`Dropping invalid stored MCP server` in `logs/nanoclaw.error.log`) — the container got no shmem tools at all.
2. Even with a valid URL, container traffic rides the OneCLI proxy (`HTTP_PROXY=host.docker.internal:10255`). The gateway cannot resolve `host.docker.internal` itself, and the vault secret `CBC_GWS_BRIDGE_TOKEN` (hostPattern `172.17.0.1`, path `/*`, header `Authorization`) overwrote the shmem bearer on any bridge-IP request → `401 invalid token`.

**Fix (fork-local):**
| What | Where |
|---|---|
| `container_configs.mcp_servers.shmem.url` for both Major groups → `http://host.docker.internal:8705/mcp` (instructions field untouched) | `data/v2.db` (SQL `replace(...)`) |
| `NO_PROXY=github.com,api.github.com,host.docker.internal` emitted for **every** session, not only when a GitHub token mount exists | `src/fork-github-auth.ts` (`FORK_NO_PROXY`, `forkNoProxyEnv()`), spread first in `composeSessionSpec` (`src/container-runner.ts`); pinned by `src/fork-github-auth.test.ts` |

Verified from inside fresh containers with curl, Node (`NODE_USE_ENV_PROXY` / undici `EnvHttpProxyAgent` honours `NO_PROXY`) and Bun `fetch` — all 200, zero `:8705` forwards in `docker logs onecli`. The agent confirmed `recall_memory` itself after an `ncl groups restart --message` respawn.

**Health check + alerting:** `scripts/fork-shmem-healthcheck.sh` runs every 15 min from the systemd user timer `nanoclaw-shmem-check.timer` (`~/.config/systemd/user/nanoclaw-shmem-check.{service,timer}`). Checks: `nanoclaw-shmem.service` active → server `initialize` + `tools/call recall_memory` (from `~/.config/nanoclaw/shmem-server.env` key) → every group's DB shmem URL is `host.docker.internal` and, for groups with a live container, the materialized `groups/<folder>/container.json` still carries the entry → each running `ncl-*` container reaches the server through its own env with `host.docker.internal` in `NO_PROXY`. Alerts Diego on Telegram (`TELEGRAM_BOT_TOKEN` from `.env`, chat `5214488088`) on ok→fail, re-nags every 6 h while down, and sends a recovery note on fail→ok. State: `data/shmem-healthcheck.state.json`; log: `logs/shmem-healthcheck.log`; `journalctl --user -u nanoclaw-shmem-check`. Manual: `scripts/fork-shmem-healthcheck.sh -v [--notify-ok]`.

**Upstream-merge tripwires:** if a merge touches `sanitizeStoredMcpServers` / `parseMcpServerConfig` (allowed plain-HTTP hosts) or `composeSessionSpec` env composition, run the health check right after the restart — it is the only thing that notices a dropped MCP entry.

### `groups/global/` preserved when it's a git checkout

| What | Where |
|---|---|
| `src/claude-md-compose.ts` — `migrateGroupsToClaudeLocal()` | guard the `groups/global/` delete on `!fs.existsSync(.git)`. |
| `src/container-runner.ts` — `buildMounts()` global block | mount `groups/global` RW when it's a git checkout, RO otherwise. Since 2026-08-23 the literal also carries `mountClass: 'allowlisted-extra'` and `scope` — it lives under `GROUPS_DIR` but outside any single `groups/<folder>`, so `group-state` is denied by admission's folder-label scope pin, and it is not a release surface. |

**Why:** Upstream v2 deletes `groups/global/` on every host start (assumes it was just a leftover v1 global memory file replaced by `container/CLAUDE.md`). This install uses `groups/global/` as a `doppenhe/major_wiki` git checkout — a multi-agent shared knowledge base. Without this guard, every host restart wipes the wiki dir.

**Container-side path:** `/workspace/global` (RW). The wiki at `/workspace/global/wiki/` follows the contract in `wiki/CONVENTIONS.md`.

## Cross-agent data repos

Two private repos owned by the `doppenhe` GitHub account (not `doppenheCBC`):

| Path | Remote | Mount | Role |
|---|---|---|---|
| `groups/global/` | `doppenhe/major_wiki` | `/workspace/global` (RW) | Shared wiki — multi-agent knowledge base |
| `groups/telegram_main/` | `doppenhe/major_content` | `/workspace/agent` (RW) | Content pipeline — schedules, posts, opportunities |

Each has `.git/info/exclude` configured locally to ignore NanoClaw-managed files (`CLAUDE.local.md`, `CLAUDE.md`, `container.json`, `.claude-fragments/`, `.claude-shared.md`) so `git status` shows only real content changes.

## Per-group memory

`groups/telegram_main/CLAUDE.local.md` and `groups/telegram_dmo-command-and-conquer/CLAUDE.local.md` are kept identical (same content, single source of truth for Major's identity + content mission + voice rules). When updating one, copy to the other.

## Local host-side skills (committed here, not upstream)

| Skill | Path | Purpose |
|---|---|---|
| add-shmem | `.claude/skills/add-shmem/` | Install shmem MCP server in an agent group. Wraps the manual recipe carried out for the Major groups (Dockerfile layer, mount allowlist, per-group MCP + mount, CLAUDE.local.md write-discipline section). Reusable for any other NanoClaw install. |

## Custom container skills (untracked-on-trunk-but-committed-here)

| Skill | Path | Purpose |
|---|---|---|
| capabilities | `container/skills/capabilities/` | Major's capability self-description |
| pdf-reader | `container/skills/pdf-reader/` | PDF text extraction inside container |
| status | `container/skills/status/` | Periodic status snapshots |
| wiki | `container/skills/wiki/` | Wiki workflow contract (defers to `/workspace/global/wiki/CONVENTIONS.md`) |

These were carried over from v1 by `migrate-v2.sh` and committed locally on top of upstream.

## Personal data (never upstream, never delete)

- `groups/telegram_main/`, `groups/telegram_dmo-command-and-conquer/` — Major's per-group state
- `groups/global/` — major_wiki checkout
- `data/v2.db` — central DB (users, agent_groups, messaging_groups, sessions, scheduled tasks)
- `data/v2-sessions/<agent-group>/<session>/` — per-session DBs and Claude memory
- `.env` — credentials (managed by OneCLI gateway)

## Design docs (local, not upstream)

- [docs/design/major-cee-bridge.md](design/major-cee-bridge.md) — autonomous Major↔Cee (Hermes) interaction mirrored into the *DMO Command and Conquer* Telegram room. Status: design/not built. Core constraint: two Bot-API bots are deaf to each other in-room, so the conversation must run over a backchannel (Hermes `api_server` / MCP), with the room as display only.

## Remotes

| Name | URL | Purpose |
|---|---|---|
| `origin` | `doppenhe/nanoclaw-major` | this fork |
| `upstream` | `qwibitai/nanoclaw` | track for `/update-nanoclaw` |

The `telegram` and `whatsapp` remotes from v1 (qwibitai/nanoclaw-telegram, qwibitai/nanoclaw-whatsapp) are no longer needed — v2 channels live on `upstream/channels` and are skill-installed via `/add-telegram`, `/add-whatsapp`, etc.
