---
name: add-shmem
description: Add shmem (Second Moment AI) as an MCP server for long-term cross-session agent memory. Per-group scoped via SHMEM_PROJECT tags. Triggers on "add shmem", "shmem", "second moment", "long-term memory" when the user wants the actual shmem product (vs mnemon / wiki / per-group CLAUDE.local.md).
---

# Add shmem — Cross-Session Memory

Installs `shmem-mcp` in the agent container image and wires it into one or more agent groups as a stdio MCP server. Memory lives on the host at `~/.shmem/db` (unified store, project tag per agent group) and is bind-mounted into the container at `/shmem-db`.

## What the agent gets

Three MCP tools backed by the project-tagged corpus:

- `recall_memory(query)` — keyword retrieval, no LLM
- `ask_memory(question)` — synthesized QA across multiple facts. With `SHMEM_QA_PROVIDER=mock` the synthesis is skipped and the agent does it itself from raw recall results (no extra credentials in the container).
- `add_memory(content)` — capture a fact

Memory persists across container restarts and image rebuilds. Project tags isolate groups from each other if you want, or shared if you set them to the same value.

## Provider compatibility

`shmem-mcp` is a standard stdio MCP server — works with both `AGENT_PROVIDER=claude` and `AGENT_PROVIDER=opencode`. The agent calls the tools through whatever MCP loader its provider supports.

Note: shmem ships an auto-capture hook flow (`shmem hook user-message` / `response`) but those hooks target Claude Code Desktop/CLI, not the NanoClaw agent-runner. **In NanoClaw, the agent decides when to call `add_memory`** — the discipline goes in `CLAUDE.local.md` (Phase 6).

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q SHMEM_VERSION container/Dockerfile && echo "Dockerfile layer present" || echo "Not yet applied"
shmem --version 2>/dev/null || echo "Host CLI not installed"
```

If both are already present, skip to Phase 5 (wire per group) for any new groups you want to enable.

### Tap and check latest version

```bash
brew tap second-moment-ai/tap 2>/dev/null
FORMULA=/home/linuxbrew/.linuxbrew/Homebrew/Library/Taps/second-moment-ai/homebrew-tap/shmem.rb
# macOS path: /opt/homebrew/Library/Taps/second-moment-ai/homebrew-tap/shmem.rb (Apple Silicon)
#             /usr/local/Library/Taps/second-moment-ai/homebrew-tap/shmem.rb (Intel)
grep -E '^\s+version "' "$FORMULA"
grep -A1 'linux_amd64.tar.gz' "$FORMULA" | grep sha256
```

Note the version and the **linux_amd64 SHA256** — both go into the Dockerfile in Phase 4.

> The source repo `github.com/second-moment-ai/shmem` returns 404. The release artifacts live on the **tap** repo (`github.com/second-moment-ai/homebrew-tap/releases`). The brew formula above is the authoritative pointer for URL + SHA.

### Decide scope (ask the user)

1. **Which agent group(s)?** Use `./bin/ncl groups list` to enumerate.
2. **`SHMEM_PROJECT` name?** Single-word, lowercase. Typically matches the agent's identity name (e.g. `major`). Use the same value across multiple groups if you want shared memory; different values for isolation.
3. **Hydration?** Recommend starting empty for the first install — confirm the wiring works before importing past data. `shmem import --from files <dir>` and `shmem add` (NDJSON via `--batch`) are options later.

## Phase 2: Host install + project

```bash
brew install second-moment-ai/tap/shmem
shmem admin project create <PROJECT_NAME>
shmem admin project list                       # confirm tag is registered
ls -la ~/.shmem/db/facts/shmem.db              # confirm DB materialized
```

## Phase 3: Mount allowlist

NanoClaw refuses additional mounts that aren't in `~/.config/nanoclaw/mount-allowlist.json`. Add `~/.shmem/db` with read-write:

```json
{
  "allowedRoots": [
    {
      "path": "/home/<user>/.shmem/db",
      "allowReadWrite": true,
      "description": "shmem unified memory DB"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

Then **open perms** so the in-container user can read+write — shmem creates the directory `0700` by default:

```bash
chmod -R 0777 ~/.shmem/db
```

The container `node` user (uid 1000 typically) doesn't match the host user (often 1000 or 1005), so `0700` will produce permission-denied at `/shmem-db/facts/`. On a single-user machine `0777` is fine and matches the trust boundary of other agent mounts. On a multi-user host, `chgrp -R <container-uid> && chmod -R 0770` is stricter — but requires the gid actually exists in the container's `/etc/group` for the kernel to honor it across user namespaces.

## Phase 4: Container image

Add this layer to `container/Dockerfile`. Best placement: after the Playwright/Chromium env block, **before** the Bun runtime section — it's cached behind rarely-bumped layers but above the volatile claude-code / agent-browser installs:

```dockerfile
# ---- shmem-mcp — long-term agent memory --------------------------------------
ARG SHMEM_VERSION=<from formula>
ARG SHMEM_SHA256=<linux_amd64 sha from formula>
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then SHMEM_ARCH=amd64; \
    elif [ "$ARCH" = "arm64" ]; then SHMEM_ARCH=arm64; \
    else echo "unsupported arch for shmem: $ARCH" && exit 1; fi && \
    curl -fsSL -o /tmp/shmem.tgz \
      "https://github.com/second-moment-ai/homebrew-tap/releases/download/v${SHMEM_VERSION}/shmem_${SHMEM_VERSION}_linux_${SHMEM_ARCH}.tar.gz" && \
    if [ "$SHMEM_ARCH" = "amd64" ]; then echo "${SHMEM_SHA256}  /tmp/shmem.tgz" | sha256sum -c -; fi && \
    tar -xzf /tmp/shmem.tgz -C /usr/local/bin shmem-mcp && \
    chmod +x /usr/local/bin/shmem-mcp && \
    rm /tmp/shmem.tgz
```

Rebuild + verify:

```bash
./container/build.sh
# The image name is install-slug-dependent (nanoclaw-agent-v2-<slug>:latest).
# Pull it from the build output, then:
docker run --rm --entrypoint sh <image>:latest -c 'shmem-mcp -version'
```

## Phase 5: Wire shmem into each chosen group

For each `<GROUP_ID>`:

```bash
./bin/ncl groups config add-mcp-server --id <GROUP_ID> \
  --name shmem --command shmem-mcp \
  --env '{"SHMEM_PROJECT":"<PROJECT_NAME>","SHMEM_TREE_PATH":"/shmem-db","SHMEM_QA_PROVIDER":"mock"}'
```

`ncl` doesn't expose `additional_mounts`, so add the host DB mount via direct DB write:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs \
   SET additional_mounts = '[{\"hostPath\":\"/home/<user>/.shmem/db\",\"containerPath\":\"/shmem-db\",\"readonly\":false}]', \
       updated_at = datetime('now') \
   WHERE agent_group_id = '<GROUP_ID>'"
```

**If the group already has other additional mounts**, merge instead of overwrite — read the current array first and append:

```bash
./bin/ncl groups config get --id <GROUP_ID> | python3 -c 'import json,sys; print(json.load(sys.stdin)["additional_mounts"])'
```

Verify:

```bash
./bin/ncl groups config get --id <GROUP_ID> | grep -A20 -E 'mcp_servers|additional_mounts'
```

## Phase 6: Write discipline in CLAUDE.local.md

**Critical step.** Without explicit instructions, the agent will write the same fact to multiple stores and trust none. Add a section to each group's `CLAUDE.local.md` that maps each storage surface to its purpose.

Template — adapt to the surfaces your group actually has:

```markdown
## Memory surfaces (write discipline)

| Where | What goes there |
|---|---|
| `<wiki path, if any>` | Curated stable knowledge — methodologies, entity profiles, principles |
| `CLAUDE.local.md` | Identity, non-negotiable rules, indexes pointing at files in /workspace/agent/ |
| `/workspace/agent/*.md` | Canonical structured records — published artifacts, ground truth |
| **shmem** (MCP) | Cross-session conversational state — drafts considered, user pushback patterns, "we touched X already" |

Do not write the same fact into two places. If a fact stops being conversational and becomes a stable principle, promote it out of shmem.

## shmem (long-term memory)

You have an MCP server called `shmem`. Three tools backed by a unified store tagged `project=<PROJECT_NAME>`. Store lives at `/shmem-db` and persists across container restarts.

- At the start of any task that could repeat prior work: call `recall_memory` with a tight keyword query. **Always check for repetition before suggesting a new angle.**
- When the user finalizes / approves / rejects work: call `add_memory` with the suggested version, the final version, and a one-line reason for any edit.
- When the user pushes back on a pattern: capture it via `add_memory`. Source as `tool` so it's distinguishable from user-direct input.
- For open-ended history questions ("what have we covered on X?"): prefer `ask_memory` — it synthesizes across facts.

NOT for shmem: identity/rules (CLAUDE.local.md), canonical records (/workspace/agent files), stable methodology (wiki), sensitive private content that shouldn't live in a written archive.
```

If multiple groups share identity (like Major Telegram + DMO Command and Conquer), keep their `CLAUDE.local.md` files identical — note the source-of-truth rule in `docs/LOCAL.md`.

## Phase 7: Restart + verify

```bash
./bin/ncl groups restart --id <GROUP_ID>
```

**Watch for slug-mismatched orphans.** If the host's install slug (from `setup/lib/install-slug.sh`) changed since the currently-running container spawned, `ncl groups restart` may kill a phantom container while the real one survives. Check:

```bash
docker ps --filter name=nanoclaw --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
```

If the running container's image tag has a different `agent-v2-<slug>:latest` than `./container/build.sh` produced, `docker stop <container-name>` it manually. The next agent message will spawn from the correct image.

Smoke test the wiring directly (before the agent uses it):

```bash
# 1. Image has the binary + can see the mount
docker run --rm \
  -e SHMEM_PROJECT=<PROJECT_NAME> \
  -e SHMEM_TREE_PATH=/shmem-db \
  -e SHMEM_QA_PROVIDER=mock \
  -v /home/<user>/.shmem/db:/shmem-db:rw \
  --entrypoint sh \
  <image>:latest \
  -c 'shmem-mcp -version && ls -la /shmem-db/facts/'

# 2. Host can query the DB
shmem admin project list
shmem query --project <PROJECT_NAME> -n 5 ""
```

Then send a message to the agent that should trigger memory use. Watch container logs / agent-runner logs for an MCP call to `shmem.recall_memory`. If you started empty, expect an empty result on the first call.

## Migration guide update

If you use `/migrate-nanoclaw`, add to `.nanoclaw-migrations/05-dockerfile.md`:

```dockerfile
# (the shmem-mcp ARG/RUN block from Phase 4, with version + SHA filled in)
```

And to your DB migration notes (often `06-db.md` or similar):

- Re-tap brew + reinstall `shmem` on the new host
- Restore `~/.shmem/db/` from backup, or `shmem admin project create <name>` to start fresh
- Add `~/.shmem/db` to `~/.config/nanoclaw/mount-allowlist.json` `allowedRoots`
- Re-add `mcp_servers.shmem` per group via `ncl groups config add-mcp-server`
- Re-add the `additional_mounts` row in `container_configs` via the SQL in Phase 5

## Troubleshooting

### `shmem-mcp: executable file not found in $PATH`

The image wasn't rebuilt with the new layer, or the rebuild used a different image tag than the host service expects. Rebuild and verify the image tag the host actually spawns:

```bash
./container/build.sh
docker run --rm --entrypoint sh <new-image>:latest -c 'which shmem-mcp'
```

If the running container uses a different tag, see "slug-mismatched orphans" in Phase 7.

### `permission denied` on /shmem-db inside the container

Host directory is too restrictive. shmem creates it `0700` by default — that excludes the in-container user. Run `chmod -R 0777 ~/.shmem/db` (single-user host) or `chgrp -R + chmod 0770` with matching uid/gid (multi-user).

### Agent never calls `recall_memory` or `add_memory`

The MCP server is wired but the agent isn't using it. Two checks:

1. **`CLAUDE.local.md` actually has the shmem instructions** (Phase 6). Without them, the model has no signal for when to call. The tool listing alone is rarely enough.
2. **The MCP server actually started.** Look for shmem-mcp startup errors in the agent-runner output / container logs. Container logs are lost on container exit (`--rm` flag in NanoClaw), so check while the container is alive: `docker logs <container> 2>&1 | grep -i shmem`.

If the tool is being called but returning nothing meaningful, you may need to seed the DB — go back to Phase 1 and do hydration via `shmem import --from files <dir>` or a Twitter/X export.

### Bumping shmem version

Update **both** `SHMEM_VERSION` and `SHMEM_SHA256` in the Dockerfile. Always pull the SHA from the current brew formula — don't reuse old ones. Rebuild + restart.

### Removing shmem from a group

```bash
./bin/ncl groups config remove-mcp-server --id <GROUP_ID> --name shmem
# Then strip the additional_mounts entry via SQL:
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs SET additional_mounts = '[]', updated_at = datetime('now') WHERE agent_group_id = '<GROUP_ID>'"
./bin/ncl groups restart --id <GROUP_ID>
```

If the group had other mounts, edit the JSON array surgically rather than zeroing it.
