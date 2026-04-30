# Cherry-pick reference

Every commit listed here lives in the fork's history — `git show <hash>`
will display it as long as the local repo has them. The migration
worktree is detached at `upstream/main`, so the commits aren't in the
worktree's branch but they remain in the object store; cherry-pick
works regardless.

If a cherry-pick reports the change is "already empty," the fix has
already landed upstream. Run `git cherry-pick --skip` and continue.

## Stage B — Skills

### `5139f44` — Merge whatsapp/main

| | |
|---|---|
| Subject | `Merge remote-tracking branch 'whatsapp/main'` |
| Brings in | `src/channels/whatsapp.ts`, `src/channels/whatsapp.test.ts`, `src/whatsapp-auth.ts`, `setup/whatsapp-auth.ts`, `.claude/skills/add-whatsapp/SKILL.md`, plus baileys / qrcode-terminal / pino dependencies |
| Cherry-pick | `git cherry-pick -m 1 5139f44` |
| Fallback | If many conflicts: `git cherry-pick --abort && git fetch whatsapp && git merge whatsapp/main --no-edit` |

The `-m 1` flag tells cherry-pick to use the user's prior main as the
mainline parent, so the patch represents everything the merge brought
in from `whatsapp/main`. The fallback re-merges directly from the
`qwibitai/nanoclaw-whatsapp` remote, which is the original source.

### `07f6075` — Merge telegram/main

| | |
|---|---|
| Subject | `Merge remote-tracking branch 'telegram/main'` |
| Brings in | `src/channels/telegram.ts`, `src/channels/telegram.test.ts`, plus grammy dependency |
| Cherry-pick | `git cherry-pick -m 1 07f6075` |
| Fallback | `git cherry-pick --abort && git fetch telegram && git merge telegram/main --no-edit` |

### `c054cbc` — skill/voice-transcription

| | |
|---|---|
| Subject | `skill/voice-transcription: WhatsApp voice message transcription via OpenAI Whisper` |
| Adds | `src/transcription.ts` (new), edits `src/index.ts` to wire transcription into the WhatsApp message handler, adds `OPENAI_API_KEY` to `.env.example` |
| Cherry-pick | `git cherry-pick c054cbc` |

Conflict expectation: `src/index.ts` may conflict because upstream has
refactored the orchestrator. The relevant change is small — the
WhatsApp handler should call `transcribeAudioMessage` for audio
messages before formatting. If conflict, keep upstream's structure and
re-thread the call (see `src/transcription.ts` for the exact API).

### `3f83b41` — skill/pdf-reader

| | |
|---|---|
| Subject | `skill/pdf-reader: PDF reading via poppler-utils` |
| Adds | `container/skills/pdf-reader/SKILL.md`, `container/skills/pdf-reader/pdf-reader` (executable, mode 755), Dockerfile lines for `poppler-utils` apt install + `COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader` + `chmod +x` |
| Cherry-pick | `git cherry-pick 3f83b41` |

After cherry-pick, verify `container/skills/pdf-reader/pdf-reader` is
executable: `ls -l container/skills/pdf-reader/pdf-reader` should show
`-rwxr-xr-x` or similar. If not: `chmod +x container/skills/pdf-reader/pdf-reader`.

### `dfc23a2` — skill/image-vision

| | |
|---|---|
| Subject | `skill/image-vision: WhatsApp image vision via sharp + Claude multimodal` |
| Adds | `src/image.ts`, `src/image.test.ts` (new), `sharp` dependency, image-block path in `container/agent-runner/src/index.ts`, edits `src/index.ts` for image-attachment plumbing through `runAgent` |
| Cherry-pick | `git cherry-pick dfc23a2` |

**This is the highest-risk cherry-pick.** Conflicts will be in
`src/index.ts` and `container/agent-runner/src/index.ts`. The
fork-specific behavior to preserve:

1. `import { parseImageReferences } from './image.js';` near other imports.
2. In `processGroupMessages` (or whatever upstream renamed it to), after
   formatting messages: `const imageAttachments = parseImageReferences(missedMessages);`.
3. The repeating typing indicator (lives in the same function):
   ```ts
   const typingInterval = setInterval(() => {
     channel.setTyping?.(chatJid, true)?.catch(() => {});
   }, 4000);
   // ...agent runs...
   clearInterval(typingInterval);
   ```
4. `runAgent` accepts `imageAttachments: Array<{ relativePath: string; mediaType: string }>` and forwards it to `runContainerAgent` via a conditional spread:
   ```ts
   ...(imageAttachments.length > 0 && { imageAttachments }),
   ```
5. In `container/agent-runner/src/index.ts`, the `runQuery` function reads `containerInput.imageAttachments`, validates `media_type` against the literal union, base64-encodes from `/workspace/group/<relativePath>`, and pushes each as an `image` content block. Already covered by the next cherry-pick (`54d71df`) for type-narrowing.

If `git cherry-pick dfc23a2` produces conflicts you can't resolve
mechanically, do:

```bash
git cherry-pick --abort
git checkout dfc23a2 -- src/image.ts src/image.test.ts
git add src/image.ts src/image.test.ts
# Then hand-edit src/index.ts and container/agent-runner/src/index.ts using the snippets above.
```

## Stage C — Carry-over fixes

| Order | Hash | Subject | Files |
|---|---|---|---|
| 1 | `c3d349a` | `getMessage` callback (stops "Waiting for this message") | `src/channels/whatsapp.ts:92-101` |
| 2 | `d1381ea` | Normalize LID mentions in group messages for trigger matching | `src/channels/whatsapp.ts` |
| 3 | `2186208` | `senderPn` fallback for LID→JID translation | `src/channels/whatsapp.ts:210-220` |
| 4 | `0e81baa` | Photo-array null-check + caption test update | `src/channels/telegram.ts`, `src/channels/telegram.test.ts` |
| 5 | `08a1ff3` | `thread_id` on `NewMessage` for Telegram topics | `src/types.ts:54` |
| 6 | `59c6aa6` | `message_thread_id` end-to-end | `src/channels/telegram.ts:32,105,163,328` |
| 7 | `aa7f149` | `openai` v6 bump (zod v4 compat) | `package.json` |
| 8 | `54d71df` | Image `media_type` narrowed to SDK literal union | `container/agent-runner/src/index.ts:43,416-424` |

If commits #1–#6 conflict, the underlying file probably moved. The
fixes are small enough to reapply by hand using `git show <hash>` to
read the patch. If `aa7f149` conflicts, just bump `openai` in
`package.json` to whatever current version is needed and run `npm install`.

## Stage D — Custom infra

### `ba48a32` — GH_TOKEN injection for doppenhe/* git checkouts

| | |
|---|---|
| Subject | `feat(container): inject GH_TOKEN for doppenhe/* git checkouts` |
| Adds | Credential helper line in `container/Dockerfile`, `resolveGithubTokenForMounts` function in `src/container-runner.ts`, integration in `buildContainerArgs` + `runContainerAgent`, and the test file `src/container-runner-auth.test.ts` |
| Cherry-pick | `git cherry-pick ba48a32` |

#### GH_TOKEN reapply by hand (if cherry-pick fails)

Most likely failure: `src/container-runner.ts` has been refactored
upstream and the function-insertion points moved. Reapply the four
pieces individually.

**1. Dockerfile** — add after the `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
env var (or any env-var section near the top):

```dockerfile
# Git auth for github.com: use GH_TOKEN env var (host injects for doppenhe/* repos — see src/container-runner.ts).
RUN git config --system 'credential.https://github.com.helper' '!f() { [ "$1" = get ] && printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f'
```

**2. `src/container-runner.ts`** — add this exported function at module
scope (after the `VolumeMount` type is in scope, before the runner
function):

```typescript
// Resolve a GitHub token if any writable mount is a git checkout of a doppenhe/* repo.
// Returns null when no such mount exists. Throws if the token can't be resolved —
// better to fail at spawn than silently lose push auth.
export function resolveGithubTokenForMounts(
  mounts: VolumeMount[],
): string | null {
  const needsToken = mounts.some((m) => {
    if (m.readonly) return false;
    const configPath = path.join(m.hostPath, '.git', 'config');
    if (!fs.existsSync(configPath)) return false;
    return /github\.com[/:]doppenhe\//.test(
      fs.readFileSync(configPath, 'utf-8'),
    );
  });
  if (!needsToken) return null;
  try {
    return execSync('gh auth token -u doppenhe', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(
      'Container mounts a doppenhe/* git repo but `gh auth token -u doppenhe` failed. Run: gh auth login --hostname github.com --user doppenhe',
    );
  }
}
```

Imports needed: `fs`, `path`, `{ execSync } from 'child_process'`.
Most likely already present.

**3. `src/container-runner.ts`** — wire it into the spawn flow.
Inside `runContainerAgent` (or whatever the runner entry point is
called), right after computing the `mounts` array:

```typescript
const mounts = buildVolumeMounts(group, input.isMain);
const githubToken = resolveGithubTokenForMounts(mounts);
```

Pass `githubToken != null` as a flag to `buildContainerArgs`:

```typescript
const containerArgs = await buildContainerArgs(
  mounts,
  containerName,
  agentIdentifier,
  githubToken != null,
);
```

In `buildContainerArgs`, when the flag is true, append a value-less
`-e GH_TOKEN` so the token name (but not value) appears in the args:

```typescript
if (injectGithubToken) {
  args.push('-e', 'GH_TOKEN');
}
```

In the `spawn` call, pass the actual token via `env`:

```typescript
const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: githubToken
    ? { ...process.env, GH_TOKEN: githubToken }
    : process.env,
});
```

**Why value-less `-e`:** putting `-e GH_TOKEN=<value>` in args would
leak the token into `ps` output. Naming the var without a value tells
the container runtime to inherit the value from `spawn`'s env.

**4. `src/container-runner-auth.test.ts`** — copy the file from the main
tree (it has no upstream version). It's a vitest unit test that mocks
`fs` + `child_process.execSync` and exercises `resolveGithubTokenForMounts`
across five scenarios.

### `8ffb2e8` — Wiki SKILL.md split

| | |
|---|---|
| Subject | `docs(wiki): move canonical rules to wiki/CONVENTIONS.md, thin SKILL.md to pointer` |
| Edits | `container/skills/wiki/SKILL.md` (only) |
| Cherry-pick | `git cherry-pick 8ffb2e8` |

The new `SKILL.md` is an 82-line shim that points to
`/workspace/global/wiki/CONVENTIONS.md` (which lives in the wiki repo
itself, not in this repo). If the cherry-pick conflicts, the entire
new SKILL.md content is small enough to copy from the main tree:
`cp $PROJECT_ROOT/container/skills/wiki/SKILL.md $WORKTREE/container/skills/wiki/SKILL.md`.

## Notes on commit order

- Stage B order is dictated by file dependencies. WhatsApp must come
  before WhatsApp fixes (Stage C), telegram before telegram fixes,
  image-vision before media_type narrow.
- Within Stage C, only the order shown above is dependency-driven (5 → 6
  for `thread_id` typing). Others can swap.
- Stage D doesn't depend on Stage C, but cleaner to do C first because
  `src/index.ts` and the channels stabilize sooner that way.
