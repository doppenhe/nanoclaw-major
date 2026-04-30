# Files to copy from main tree → worktree

These are files where the canonical content lives in the user's main
tree, not in any cherry-picked commit. Copy them after Stage D
(cherry-picks) but before Stage F (validation).

`$PROJECT_ROOT` is the absolute path to the live repo (where the
fork's HEAD is). `$WORKTREE` is the absolute path to the upgrade
worktree (typically `$PROJECT_ROOT/.upgrade-worktree`).

## Personal data (user content, never modify)

- `groups/global/CLAUDE.md` — system prompt for the Major agent (global). Contains personal context.
- `groups/main/CLAUDE.md` — system prompt for the main group.

```bash
mkdir -p "$WORKTREE/groups/global" "$WORKTREE/groups/main"
cp "$PROJECT_ROOT/groups/global/CLAUDE.md" "$WORKTREE/groups/global/CLAUDE.md"
cp "$PROJECT_ROOT/groups/main/CLAUDE.md"   "$WORKTREE/groups/main/CLAUDE.md"
```

> **Treat opaquely.** Do not snapshot or summarize the contents in this
> guide; copy the file as a black box.

## Fork ledger and methodology docs

- `docs/LOCAL.md` — the canonical customization ledger this guide is built from. Must travel forward; without it, future migrations lose context.
- `docs/CONTENT-MANAGER-AGENT-SPEC.md` — methodology spec for content-manager agent (513 lines).

```bash
mkdir -p "$WORKTREE/docs"
cp "$PROJECT_ROOT/docs/LOCAL.md"                     "$WORKTREE/docs/LOCAL.md"
cp "$PROJECT_ROOT/docs/CONTENT-MANAGER-AGENT-SPEC.md" "$WORKTREE/docs/CONTENT-MANAGER-AGENT-SPEC.md"
```

## Diagnostics opt-out markers

The fork has explicitly opted out of telemetry pings for two skills:
`setup` and `update-nanoclaw`. Each marker file replaces upstream's
multi-step diagnostics block with a single line. Copy both (the
upstream worktree will have the full upstream `diagnostics.md` for
each — overwrite it):

```bash
cp "$PROJECT_ROOT/.claude/skills/setup/diagnostics.md"           "$WORKTREE/.claude/skills/setup/diagnostics.md"
cp "$PROJECT_ROOT/.claude/skills/update-nanoclaw/diagnostics.md" "$WORKTREE/.claude/skills/update-nanoclaw/diagnostics.md"
```

> **`migrate-nanoclaw` is NOT opted out** — leave upstream's full
> diagnostics file in place there. (If you want to opt out of all three
> in the future, run the "Never ask again" branch of any of these
> skills' diagnostics flows.)

The post-cherry-pick SKILL.md files for `setup` and `update-nanoclaw`
may still reference a "Diagnostics" section that is now a no-op;
that's fine — the marker file is the source of truth.

## Permissions allow-list

`.claude/settings.json` is largely a permissions allow-list of read-only
commands the user has pre-approved (gh auth, git diff/log/show, systemctl,
journalctl, onecli, etc.). It's safe to copy verbatim — these are
preferences, not state.

```bash
cp "$PROJECT_ROOT/.claude/settings.json" "$WORKTREE/.claude/settings.json"
```

## `claw` skill JID example

`.claude/skills/claw/SKILL.md` line 76 has been anonymized in the fork
(real JID replaced with `1234567890-1234567890@g.us`). If the cherry-pick
chain didn't already touch this file, copy:

```bash
cp "$PROJECT_ROOT/.claude/skills/claw/SKILL.md" "$WORKTREE/.claude/skills/claw/SKILL.md"
```

If the upstream `claw/SKILL.md` has changed substantially since the
fork branched, prefer the upstream version and just patch line 76 to
keep the placeholder JID. (`grep -n '@g.us' SKILL.md` will find it.)

## Channel registry

`src/channels/index.ts` is the imports barrel for channels. The fork's
final state imports Telegram only (WhatsApp commented out):

```typescript
// telegram
import './telegram.js';

// whatsapp (disabled — using Telegram only)
// import './whatsapp.js';
```

After the cherry-pick chain finishes, this file may have a different
shape (the WhatsApp/Telegram cherry-picks each registered themselves
via this file). Verify the final state is what the user wants — if the
user wants WhatsApp re-enabled, uncomment the WhatsApp line; if
Telegram-only, leave WhatsApp commented.

```bash
cp "$PROJECT_ROOT/src/channels/index.ts" "$WORKTREE/src/channels/index.ts"
```

## `.env.example`

The fork's `.env.example` lists the env vars used by the active skills:

```
ASSISTANT_HAS_OWN_NUMBER=
TELEGRAM_BOT_TOKEN=
OPENAI_API_KEY=
```

Copy if the cherry-pick chain didn't already produce equivalent content:

```bash
cp "$PROJECT_ROOT/.env.example" "$WORKTREE/.env.example"
```

If upstream's `.env.example` has additional well-documented entries,
keep upstream's and append the fork's three names.

## Files known to be removed (do not copy or recreate)

These were deleted upstream-side in the fork — the upgrade worktree
starts from upstream/main, which may or may not have them. If present
in the worktree after Stage D, delete them:

```bash
rm -f "$WORKTREE/.github/workflows/bump-version.yml"
rm -f "$WORKTREE/.github/workflows/update-tokens.yml"
```

## After all copies

Verify nothing was missed:

```bash
diff -rq --brief "$PROJECT_ROOT/groups/global" "$WORKTREE/groups/global" || true
diff -rq --brief "$PROJECT_ROOT/groups/main"   "$WORKTREE/groups/main"   || true
diff -q "$PROJECT_ROOT/docs/LOCAL.md"          "$WORKTREE/docs/LOCAL.md"
diff -q "$PROJECT_ROOT/.claude/settings.json"  "$WORKTREE/.claude/settings.json"
```

(Other group directories — `groups/telegram_*`, `groups/whatsapp_*` —
contain runtime state that is **not** committed to git; they are
preserved on disk through the swap and don't need copying. Only the
two committed `CLAUDE.md` files travel through the migration.)
