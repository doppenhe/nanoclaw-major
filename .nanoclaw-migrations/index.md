# NanoClaw Migration Guide — `nanoclaw-major` fork

Generated: 2026-04-30T13:37:54Z
BASE (merge-base with upstream/main): `a81e1651b5e48c9194162ffa2c50a22283d5ecd3`
HEAD at generation: `8ffb2e8` (`8ffb2e815db1a753bc08d715eb1c5fe0aef4692a`)
Upstream at generation: `bb1b418` (`bb1b41800cac05b67691aefac2b1fa0a9ae22db1`)
Tier: **3** (complex)

## What this guide is

A reapply plan for upgrading the `nanoclaw-major` fork to a fresh upstream
checkout. Source-of-truth for what's customized is `docs/LOCAL.md` in the
fork's main tree; this guide turns that ledger into an ordered reapply
script. Most customizations land via **cherry-pick** of the original
commits onto a clean upstream worktree; a few personal-data files are
**copied from the main tree** at the end.

Two companion files:

- [`cherry-picks.md`](cherry-picks.md) — every commit to cherry-pick, in order, with fallback notes.
- [`copy-files.md`](copy-files.md) — files copied verbatim from the main tree (data, docs, settings, diagnostics).

## Migration plan (Tier 3)

Work happens entirely in `.upgrade-worktree/` until the swap. Each step
must succeed before the next is attempted.

### Stage A — Prep

1. Backup tag + branch on current HEAD (Phase 2 §2.1).
2. Create worktree at `upstream/main` (`git worktree add .upgrade-worktree upstream/main --detach`).
3. Inside the worktree, ensure remotes are visible: `git fetch whatsapp && git fetch telegram` (the fork's main tree configures both).

### Stage B — Reapply skills (cherry-picks)

Order matters because later commits depend on files introduced by
earlier ones. Each step is its own commit; resolve any conflict before
moving on. See [`cherry-picks.md`](cherry-picks.md) for the full list.

1. WhatsApp channel — `git cherry-pick -m 1 5139f44`
   - Conflict fallback: `git cherry-pick --abort && git merge whatsapp/main --no-edit`
2. Telegram channel — `git cherry-pick -m 1 07f6075`
   - Conflict fallback: `git cherry-pick --abort && git merge telegram/main --no-edit`
3. Voice transcription skill — `git cherry-pick c054cbc`
4. PDF reader skill — `git cherry-pick 3f83b41`
5. Image vision skill — `git cherry-pick dfc23a2` *(touches `src/index.ts`; expect conflicts here — see troubleshooting in [`cherry-picks.md`](cherry-picks.md))*

After Stage B, run `npm install && npm run build` once. Fix typing
errors before continuing — they'll only get harder to triage later.

### Stage C — Carry-over fixes

These are bug fixes the fork has on top of upstream (`docs/LOCAL.md`
"Core fixes we carry"). Order is logical, not strict:

1. WhatsApp `getMessage` callback — `c3d349a`
2. WhatsApp LID-mention normalization — `d1381ea`
3. WhatsApp `senderPn` fallback — `2186208`
4. Telegram photo-array null-check — `0e81baa`
5. Telegram `thread_id` on `NewMessage` (touches `src/types.ts`) — `08a1ff3`
6. Telegram `message_thread_id` end-to-end — `59c6aa6`
7. `openai` v6 bump — `aa7f149`
8. Image `media_type` literal-union narrow — `54d71df`

If any has already been landed upstream (very possible after 512
commits), `git cherry-pick` will say "the previous cherry-pick is now
empty"; skip it (`git cherry-pick --skip`) and note it.

### Stage D — Custom infra

1. GH_TOKEN injection for `doppenhe/*` mounts — `git cherry-pick ba48a32`
   - This is the most fork-specific change. It depends on the Dockerfile
     and `src/container-runner.ts` being in roughly their post-skill
     state. If the cherry-pick conflicts, see [`cherry-picks.md`](cherry-picks.md) §
     "GH_TOKEN reapply by hand."
2. Wiki SKILL.md split — `git cherry-pick 8ffb2e8` *(only modifies `container/skills/wiki/SKILL.md`; should be clean)*

### Stage E — Copy personal/data files from main tree

See [`copy-files.md`](copy-files.md) for the exact list and one-shot script.
Run before the validation build so the worktree matches the live state.

### Stage F — Validate

```bash
cd "$WORKTREE" && npm install && npm run build && npm test
```

Build must pass. Test failures are OK to triage individually but a
clean build is non-negotiable — the container does its own `tsc` at
spawn time and exits silently on TS errors (see auto-memory).

### Stage G — Optional live test (Phase 2 §2.7)

Symlink data into the worktree, run from worktree against real groups,
send a test message via Telegram or WhatsApp, then tear down.

### Stage H — Swap and post-upgrade

Phase 2 §2.8–§2.9 verbatim. Update the guide's header hashes after the
swap.

## Files known to break

- **`src/index.ts`** — fork has +38/-23 from upstream BASE; upstream has
  had 512 commits. Image-vision cherry-pick (`dfc23a2`) and voice
  transcription (`c054cbc`) both edit this file. Expect conflicts on
  the orchestrator's message-loop and `runAgent` signature.
  See [`cherry-picks.md`](cherry-picks.md) for the textual fallback.

## Files NOT to recreate

Both upstream-removed in commits `e9426da` (concurrency-group fix) and
`a3f2af5` (auto-sync removal). Keep them deleted in the worktree:

- `.github/workflows/bump-version.yml`
- `.github/workflows/update-tokens.yml`

These workflows belonged to upstream's release automation; the fork
deliberately doesn't run them.

## Skill interactions

- **WhatsApp + Telegram channels coexist.** `src/channels/index.ts`
  currently disables WhatsApp (`// import './whatsapp.js';`). After
  reapply, decide which the user wants active by uncommenting the
  appropriate import. (See `copy-files.md` for the canonical contents
  of `src/channels/index.ts`.)
- **Voice transcription + WhatsApp.** Voice messages only work on
  WhatsApp today; if WhatsApp stays disabled, the transcription code is
  inert but harmless.
- **Image vision + container/agent-runner.** The image-vision cherry-pick
  (`dfc23a2`) and the media_type narrow fix (`54d71df`) both edit
  `container/agent-runner/src/index.ts`. Apply `dfc23a2` first; the
  later narrow fix layers on top.
- **GH_TOKEN injection + container-runner.** `ba48a32` adds
  `resolveGithubTokenForMounts` to `src/container-runner.ts`. This
  function is independent of the channel/skill cherry-picks. If the
  cherry-pick fails because upstream has refactored
  `runContainerAgent`, reapply by hand using the snippets in
  [`cherry-picks.md`](cherry-picks.md).

## Rollback

The pre-upgrade backup tag (`pre-migrate-<hash>-<timestamp>`) is the
canonical rollback point:

```bash
git reset --hard <backup-tag>
```

If you got past the swap and the live service is broken, also restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or
systemctl --user restart nanoclaw                  # Linux
```
