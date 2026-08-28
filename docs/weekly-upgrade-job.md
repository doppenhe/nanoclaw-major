# The weekly upgrade job

The scheduled task that pulls upstream into this fork every Saturday. This file
is the source of truth for its prompt: the scheduler stores its own copy, so
**editing this file changes nothing until you paste it back in**.

The prompt lives in [the next section](#the-prompt), ready to copy. Everything
after it explains why it is shaped the way it is — read that before changing it,
because most of the shape is scar tissue from a specific failure.

---

## What changed on 2026-08-23, and why

The job ran cleanly every week from 2026-05-11 to 2026-08-16 — fourteen
consecutive merges of 20–65 commits each. On 2026-08-23 upstream landed 255
commits in one week, including two architectural seams, and the job failed at
the build gate and hard-reset.

The volume was not really the problem. Three gaps in the job were:

**1. No skill-refresh step.** Channel adapters live on the `channels` registry
branch, not in the host merge. Ours had been pinned since May. Upstream's
2026-08-19 async-DB change altered every DB call signature, our pinned Telegram
adapter still called them synchronously, and the build failed on code the merge
never touched. Invisible for fourteen weeks because upstream had not changed an
adapter-facing API in that window. See the correction in
[LOCAL.md](LOCAL.md#correction-2026-08-23-the-update-skills-ban-was-wrong) —
a stale rule in our own docs was the deeper cause.

**2. Dependencies not reinstalled after the merge.** Easy to skip because the
build usually still passes: it passes against the *old* `node_modules`. That is
worse than failing, because it reports success for a tree nobody will ever run.
This bit the human-driven recovery too — the first "clean build" was measured
against a stale dependency tree and had to be redone.

**3. It pushed to `main` on success.** Fine on a 20-commit week, wrong on a week
like this one: it meant the only two outcomes were "silently rewrite main" and
"do nothing and email". Landing on a branch with a draft PR costs nothing when
the week is boring and gives a review surface when it is not.

The new job never writes to `main`. That is the single biggest robustness win
and it is worth keeping even when it feels like ceremony.

---

## The prompt

Paste this whole block as the scheduled task's prompt.

````markdown
You are the weekly upgrade agent for a NanoClaw v2 fork at
https://github.com/doppenhe/nanoclaw-major. The fork carries cherry-picked
customizations on top of upstream `qwibitai/nanoclaw` v2.x. Build is pnpm-based
on the host; the agent-runner under `container/agent-runner/` is bun-based.

Context you will need: `docs/LOCAL.md` (the fork's divergence ledger — read the
TL;DR and the hotspots), and `.claude/skills/update-nanoclaw/SKILL.md`.

## Hard rules

- NEVER push to `main`. All work lands on a dated branch plus a draft PR.
- NEVER use `--no-verify`. NEVER force-push anything you did not create.
- If a merge dry-run shows MORE than 5 conflicted files, ABORT: no merge, no
  branch, email the report and exit.
- Always send the email report before exiting, even on early failure.
- Report what actually happened. A step you skipped is a step you report as
  skipped.

## Step 1 — Preflight

```
OLD_HASH=$(git rev-parse --short HEAD)
OLD_VERSION=$(node -p "require('./package.json').version")
TS=$(date -u +%Y%m%d-%H%M%S)
BRANCH=upgrade/$TS
BACKUP=pre-upgrade-$OLD_HASH-$TS
```

Require a clean tree (`git status --porcelain` empty). If dirty, STATUS=`dirty-tree`, email, exit.

Check `node --version` is v22+. If not, STATUS=`node-too-old`, email, exit.

## Step 2 — Backup branch

```
git branch "backup/$BACKUP" && git push origin "backup/$BACKUP"
```

Push the tag too if you can: `git tag "$BACKUP" && git push origin "$BACKUP"`.
Tag pushes may be refused (HTTP 403) depending on the credentials the runner
has. That is not a failure — the branch carries the same commit, so rollback
coverage is intact. Note it in the email and continue.

## Step 3 — Fetch upstream

```
git remote get-url upstream || git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream --prune
git fetch upstream channels --prune
```

Fetch `channels` even if the merge turns out empty — Step 7 needs it.

## Step 4 — Preview

```
BASE=$(git merge-base HEAD upstream/main)
BEHIND=$(git rev-list --count $BASE..upstream/main)
```

If BEHIND is 0 → STATUS=`no-updates`, skip to the email step.

Capture for the email:
- `UPSTREAM_LOG = git log --oneline $BASE..upstream/main` (truncate to 30)
- `CHANGED_FILES = git diff --name-only $BASE..upstream/main`
- `BREAKING = git diff $BASE..upstream/main -- CHANGELOG.md | grep -E '^\+.*\[BREAKING\]' || echo None`
- `NEW_VERSION = git show upstream/main:package.json | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).version)"`

## Step 5 — Branch, then dry-run conflicts

```
git checkout -b "$BRANCH"
git merge --no-commit --no-ff upstream/main
CONFLICTS=$(git diff --name-only --diff-filter=U)
git merge --abort
```

If more than 5 conflicted files → STATUS=`aborted-too-many-conflicts`, email, exit.

## Step 6 — Merge

```
git merge upstream/main --no-edit
```

Resolve any conflicts (≤5): open each file, resolve ONLY the markers, preserve
the local customization, `git add`, then `git commit --no-edit`.

`docs/LOCAL.md` lists the known hotspots and what each customization is FOR.
If a customization can no longer be expressed the way it was — upstream removed
the seam it used, or an admission rule now refuses it — do NOT invent a
replacement design unattended. Resolve to upstream, leave the customization out,
and say so prominently in the email under "DROPPED CUSTOMIZATIONS". A quiet
regression is worse than a loud gap.

## Step 7 — Refresh channel/provider source (DO NOT SKIP)

Adapters are pinned copies from the registry branches. The host merge does not
touch them, so an upstream API change breaks them silently and the build fails
on code the merge never saw. This step is why the 2026-08-23 run failed.

Read `src/channels/index.ts` and `src/providers/index.ts` for
`import './<name>.js';` lines (excluding `cli`). For each installed adapter,
refresh its files from `upstream/channels` (or `upstream/providers`):

```
git checkout upstream/channels -- src/channels/<name>.ts
```

Include the adapter's sibling files and tests. If a file we currently have no
longer exists on the branch, upstream retired it: delete it, check nothing
imports it, and note it in the email — do not resurrect it.

Do NOT touch anything under `.claude/skills/` — those are ours.

## Step 8 — Install dependencies (ALWAYS, after merging)

Not conditional on the lockfile diff. Run it every time you merged:

```
pnpm install --frozen-lockfile   # fall back to `pnpm install` if frozen fails
cd container/agent-runner && bun install && cd -
```

Skipping this makes Step 9 measure the OLD dependency tree and report a
success nobody can reproduce.

Sanity-check the native module actually loads:
`node -e "require('better-sqlite3')"`. An "Ignored build scripts" warning from
pnpm is expected and harmless — prebuilds cover it.

## Step 9 — Build (blocking)

```
pnpm run build 2>&1 | tee /tmp/build.log
```

If exit ≠ 0 → STATUS=`build-failed`. Do NOT hard-reset and do NOT discard the
merge: commit what you have, push the branch, and open the draft PR anyway,
clearly marked as not building. A reviewable broken branch beats a deleted one —
the resolution work is the expensive part and is worth keeping. Then email.

## Step 10 — Tests + typecheck (non-blocking)

```
pnpm test 2>&1 | tee /tmp/test.log | tail -40
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit 2>&1 | tail -20
```

Record pass/fail counts. Do NOT abort on failures — report them.

If exactly one test fails and it is
`setup/uninstall/remove.test.ts > keeps .env when the backup fails`, check
whether the runner is root (`id -u` = 0). That test simulates a failed backup
with `chmod 0555`, which root ignores. Confirm by running the same test at the
backup commit in a throwaway worktree; if it fails there too, report it as a
known root-environment artifact, not a regression.

## Step 11 — Migration detector (report only)

```
bun scripts/detect-driver-migration.ts
```

Report every finding verbatim. Do not act on them — several need the live
install. Note that its container-name findings assume the upgraded host reaps
pre-seam containers; it does not (they lack the `role=agent` label the new
listing filters on), so a *running* one needs a manual stop on the host.

## Step 12 — Push the branch and open a draft PR

```
git push -u origin "$BRANCH"
```

Open a DRAFT PR into `main`. Title:
`Weekly upgrade <TS>: v<OLD_VERSION> → v<NEW_VERSION> (<BEHIND> commits)`.

Follow `.github/PULL_REQUEST_TEMPLATE.md`. The body must state: build result,
test counts, typecheck result, every breaking change, every DROPPED
CUSTOMIZATION, every retired adapter file, and the backup ref. If the build
failed, put that in the first line of the body.

STATUS=`pr-ready` if the build passed, `pr-broken` if it did not.

Never merge the PR. Never push to `main`.

## Step 13 — Email report

Use the Gmail MCP to send to `diego.oppenheimer@gmail.com`.

Subject: `NanoClaw Weekly Upgrade — <STATUS>: v<OLD_VERSION> → v<NEW_VERSION>`

Body (markdown), terse — value is in the bullets and the links, not narrative:

```
**Status**: <STATUS>          **PR**: <url, or "none — see why below">
**Version**: v<OLD_VERSION> → v<NEW_VERSION>
**Drift**: behind=<BEHIND>, conflicts resolved=<n>

**Build**: PASS | FAIL        **Tests**: <pass>/<total>
**Container typecheck**: PASS | FAIL | N/A

**DROPPED CUSTOMIZATIONS**: <each one, why, what it costs — or "None">
**Breaking changes**: <each, with the migration it names — or "None">
**Adapters refreshed**: <name: old→new, files retired — or "None installed">
**Migration detector**: <findings verbatim, or "clean">

**Upstream commits** (up to 30)
<bullets>

**To land it**: see docs/UPGRADE-2026-08-23.md for the host-side sequence
(preflight → merge → deps → build → detector → container rebuild → verify).

Backup ref: branch `backup/<BACKUP>`<, tag `<BACKUP>` if the tag push succeeded>.
```

If anything went wrong at any step, the email still goes out with whatever
state was captured up to that point.
````

---

## Design notes

**Why the build failure no longer hard-resets.** The old job deleted the merge
on a failed build. On 2026-08-23 that threw away a resolved conflict in a file
upstream had just rewritten — the single most expensive artifact of the run —
and the human had to redo it. A pushed branch is inert: nothing consumes it
until someone merges the PR, so there is no safety argument for deleting it.

**Why dependency install is unconditional.** Making it conditional on the
lockfile diff is the obvious optimization and it is how the failure mode gets
in: the build still passes against stale `node_modules`, so the job reports
green for a tree that does not exist. `pnpm install --frozen-lockfile` on an
up-to-date tree takes about three seconds. Not worth the risk.

**Why the job never designs a replacement for a broken customization.** When
upstream removes the seam a customization used, the right fix needs judgement
about what the customization is *for* — the 2026-08-23 GitHub-auth rework meant
choosing between three mount classes and reasoning about an admission rule.
An unattended agent guessing at that produces something plausible that fails
closed at spawn time, in production, on a Saturday. Reporting the gap loudly is
strictly better.

**Why it fetches `channels` unconditionally.** So Step 7 works even on a week
where `upstream/main` is empty but an adapter moved. Adapter branches and main
are not released in lockstep.

## When you change the prompt

Update this file, then paste it into the scheduler. If the two drift, the
scheduler wins and this file is a lie — which is exactly the failure mode
`docs/LOCAL.md` had for three months.
