# Local customizations (v2)

What this NanoClaw v2 install carries on top of `qwibitai/nanoclaw` upstream main, and how to keep both working over time. Personal ledger; not meant to merge upstream.

The v1 ledger (formerly at this path on the v1 install) covered the WhatsApp/Telegram channel forks and the agent-runner image-vision/voice/PDF skill suite. v2's architecture is different — channels are skill-installed and the agent runtime is in `container/agent-runner/` (Bun, not the v1 dual-build). This file tracks v2-only divergence.

## TL;DR — staying updateable

1. Run `/update-nanoclaw` regularly. Keep deltas small.
2. **Do not** run `/update-skills`. Our skills are committed in main; upstream `skill/*` branches are stale.
3. Watch the divergence hotspots below — those are the lines that will conflict.

## Divergence hotspots (v2)

### Container build cache mounts stripped (no `--mount=type=cache`)

| What | Where |
|---|---|
| `container/Dockerfile` | 5 `RUN --mount=type=cache,target=...` directives removed |

**Why:** This host's Docker daemon (28.2.2 on Ubuntu Noble) does not have the buildx component. Legacy builder rejects cache mounts. Upstream's Dockerfile assumes BuildKit/buildx. Re-add cache mounts only if `docker buildx version` succeeds here in the future.

### GitHub credential injection for `doppenhe/*` mounts

| What | Where |
|---|---|
| `container/Dockerfile` — system git credential helper | line ~58, after `git` is installed via apt. Helper reads `$GH_TOKEN` env at request time, never persists. |
| `src/container-runner.ts` — `resolveGithubTokenForMounts(mounts)` | exported function. Scans writable mounts for `.git/config` matching `doppenhe/*`; if any, calls `gh auth token -u doppenhe`. Throws loudly if `gh auth` fails. |
| `src/container-runner.ts` — `wakeContainer()` plumbing | computes token once, passes `injectGithubToken` into `buildContainerArgs` (adds value-less `-e GH_TOKEN`), and forwards the value via `spawn(... { env })`. |

**Why:** Major's content/wiki workflows require `git push` from inside the container directly to `doppenhe/major_content` and `doppenhe/major_wiki`. Without this, every push needs a host-side detour. Modeled exactly after the v1 implementation.

**Failure mode:** if a `doppenhe/*` repo is mounted but `gh auth token -u doppenhe` errors, the spawn throws. No silent degradation. Fix: `gh auth login --hostname github.com --user doppenhe`.

### shmem-mcp installed in container image (cross-session memory for Major)

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

### `groups/global/` preserved when it's a git checkout

| What | Where |
|---|---|
| `src/claude-md-compose.ts` — `migrateGroupsToClaudeLocal()` | guard the `groups/global/` delete on `!fs.existsSync(.git)`. |
| `src/container-runner.ts` — `buildMounts()` global block | mount `groups/global` RW when it's a git checkout, RO otherwise. |

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

## Remotes

| Name | URL | Purpose |
|---|---|---|
| `origin` | `doppenhe/nanoclaw-major` | this fork |
| `upstream` | `qwibitai/nanoclaw` | track for `/update-nanoclaw` |

The `telegram` and `whatsapp` remotes from v1 (qwibitai/nanoclaw-telegram, qwibitai/nanoclaw-whatsapp) are no longer needed — v2 channels live on `upstream/channels` and are skill-installed via `/add-telegram`, `/add-whatsapp`, etc.
