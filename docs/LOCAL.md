# Local customizations

What this fork adds on top of `qwibitai/nanoclaw` main, and how to keep both working together over time. This is a personal ledger, not upstream docs — nothing here is meant to be merged back.

## TL;DR — staying updateable

1. Run `/update-nanoclaw` regularly (weekly-ish). Small deltas merge cleanly.
2. **Do not** run `/update-skills`. Our skills live in our own code; upstream's `skill/*` branches are stale variants that conflict for no benefit.
3. If upstream ever refactors `src/index.ts` heavily, come back here — that's our one real divergence hotspot (+38/-23 vs upstream). Commits below tell you what's ours.

## Skills we authored

All merged into `main` already; not tracked as `skill/*` branches in our origin.

| Skill | Dir | Source of truth |
|---|---|---|
| WhatsApp channel | `src/channels/whatsapp.ts`, `src/whatsapp-auth.ts` | merged from `whatsapp` remote (`qwibitai/nanoclaw-whatsapp.git`) plus local fixes below |
| Telegram channel | `src/channels/telegram.ts` | merged from `telegram` remote (`qwibitai/nanoclaw-telegram.git`) plus local fixes below |
| Voice transcription | `container/skills/...`, container-runner wiring | `c054cbc skill/voice-transcription` |
| PDF reader | `container/skills/pdf-reader/` | `3f83b41 skill/pdf-reader` |
| Image vision | `container/agent-runner/src/index.ts` image-block path | `dfc23a2 skill/image-vision` (+ today's `54d71df` fix) |

## Core fixes we carry

Real bugs we hit that aren't (yet) in upstream. Commit hash is the anchor — line numbers drift.

| Fix | Commit | Files |
|---|---|---|
| Image `media_type` narrowed to SDK's literal union | `54d71df` | `container/agent-runner/src/index.ts:43,416-424` |
| Telegram photo-array null-check | `0e81baa` | `src/channels/telegram.ts`, `telegram.test.ts` |
| `thread_id` on `NewMessage` for Telegram topics | `08a1ff3` | `src/types.ts:54` |
| Telegram `message_thread_id` support end-to-end | `59c6aa6` | `src/channels/telegram.ts:32,105,163,328` |
| Normalize LID mentions for trigger matching | `d1381ea` | `src/channels/whatsapp.ts` |
| `senderPn` fallback for LID→JID translation | `2186208` | `src/channels/whatsapp.ts:210-220` |
| `getMessage` callback (stops "Waiting for this message") | `c3d349a` | `src/channels/whatsapp.ts:92-101` |
| `openai` v6 bump (for `zod` v4) | `aa7f149` | `package.json` |

If any of these come back after an upstream merge, check whether upstream has landed an equivalent fix first — don't blind-reapply.

## Personal data (never upstream, never delete)

- `groups/` — all group state: `main`, `global`, `telegram_main`, `telegram_dmo-*`, `whatsapp_main`, `whatsapp_ai-gossip`, `whatsapp_pef-*`.
- Per-group memory: `groups/<name>/CLAUDE.md`.
- `store/messages.db` — message history + scheduled tasks.
- `.env` — credentials (managed by OneCLI gateway; don't commit).

## Remotes

| Name | URL | Purpose |
|---|---|---|
| `origin` | `doppenheCBC/nanoclaw-major` | our fork |
| `upstream` | `qwibitai/nanoclaw` | track for `/update-nanoclaw` |
| `whatsapp` | `qwibitai/nanoclaw-whatsapp` | whatsapp channel source (merge from this) |
| `telegram` | `qwibitai/nanoclaw-telegram` | telegram channel source (merge from this) |

## Cross-agent data repos

Two private repos, both owned by the `doppenhe` GitHub account (not `doppenheCBC`), live as git checkouts inside `groups/`:

| Checkout | Remote | Role |
|---|---|---|
| `groups/global/` | `doppenhe/major_wiki` | Compiled cross-agent knowledge base (wiki) |
| `groups/telegram_main/` | `doppenhe/major_content` | Content-pipeline working state (posts, queues, research) |

`groups/whatsapp_main/` was a stale checkout of `major_content`; `.git` removed 2026-04-19 (backup: `/tmp/whatsapp_main-git-backup-20260419-060019.tar.gz`). Its files stay local to that group folder.

### Container git auth (2026-04-19 infra)

Container agents can push directly to `major_wiki` / `major_content` — no 30-min host-sync latency:

1. **Dockerfile** configures a system-wide git credential helper for `https://github.com` that reads `$GH_TOKEN` env var. See `container/Dockerfile` (the `git config --system credential.https://github.com.helper` step).
2. **`src/container-runner.ts`** exports `resolveGithubTokenForMounts`. At container-spawn time it scans writable mounts; if any is a git checkout of `doppenhe/*`, it runs `gh auth token -u doppenhe` on the host and passes the token into the container via `spawn()`'s `env` plus `-e GH_TOKEN` (value-less `-e` keeps the token out of `ps` output).
3. **Failure mode**: if a `doppenhe/*` repo is mounted but `gh auth` can't return a token, the spawn **throws loudly** with a message pointing at `gh auth login --hostname github.com --user doppenhe`. No silent degradation.
4. **Redundant safety net**: `~/.local/bin/major-repo-sync` (systemd timer `major-repo-sync.timer`, every 30 min) still runs. If a container dies mid-commit before pushing, next timer run reconciles.

Auth chain inside the container when git needs credentials:
```
git push → asks credential helper → /etc/gitconfig helper runs
  → printf "username=x-access-token\npassword=$GH_TOKEN\n"
  → git sends Basic auth to github.com
```

Tests: `src/container-runner-auth.test.ts`.

## Container git credential helper

Location: `/etc/gitconfig` inside the image (set at Dockerfile build). Format:

```
[credential "https://github.com"]
    helper = "!f() { [ \"$1\" = get ] && printf \"username=x-access-token\\npassword=%s\\n\" \"$GH_TOKEN\"; }; f"
```

Only responds to `get`, ignores `store`/`erase`. Token source is the `$GH_TOKEN` env var injected by the host. Never persisted to disk inside the container.

## Commit-graph noise (historical)

The old `fork-sync-skills.yml` workflow was removed in `a3f2af5` / `e9426da`. It had produced ~77 `Merge branch 'main' into skill/X` commits that inflate our ahead-count but are harmless. New noise should not accumulate.

## Update playbook

**Routine upstream sync:**
```bash
# Just run the skill
/update-nanoclaw
```

**Previewing a skill branch before installing (if we ever want one):**
```bash
git fetch upstream --prune
git merge-tree --write-tree HEAD upstream/skill/<name>
# Look at conflicts in stderr; only proceed if the actual new content is worth it
```

**If /update-nanoclaw hits a real conflict on `src/index.ts`:**
- Our divergence is the orchestrator's message loop (custom channel registration + routing).
- Prefer upstream's structural changes; reapply the local behavior on top.
- The backup tag printed at the start of the update is the rollback point.

**Rollback anchor from today's update:** `pre-update-54d71df-20260418-205114`
