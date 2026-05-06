# Wiki

You maintain a persistent knowledge base at `/workspace/global/wiki/`. Raw sources live at `/workspace/global/sources/`. The wiki is shared across multiple agents (NanoClaw, Hermes, Claude clients on other machines) via the `doppenhe/major_wiki` git repo.

> **Read this first, in every session that touches the wiki:**
> `/workspace/global/wiki/CONVENTIONS.md`
>
> That's the canonical rules file — page structure, confidence markers, stub discipline, cross-reference policy, workflow-vs-durable distinction, hot-page handling, index/log maintenance, category taxonomy, the full sync contract. This file (`SKILL.md`) only covers **container-specific workflow**: the bash commands, the workspace paths, and how the container runtime fits in.
>
> If this SKILL.md and CONVENTIONS.md disagree on anything, **CONVENTIONS.md wins.**

---

## Container Workspace Paths

| Path | What it is |
|---|---|
| `/workspace/global/` | The wiki repo root (git checkout of `doppenhe/major_wiki`). |
| `/workspace/global/wiki/` | The wiki pages. |
| `/workspace/global/wiki/CONVENTIONS.md` | Canonical rules. Read first. |
| `/workspace/global/wiki/index.md` | Page catalog by category. Read first when querying. |
| `/workspace/global/wiki/log.md` | Chronological activity log. Append after every write. |
| `/workspace/global/sources/` | Raw source files. Gitignored, local-only. |
| `/workspace/global/wiki/conflicts/` | Where drafts go when push fails. |

---

## Sync Commands (container-specific)

Per CONVENTIONS.md §9, pull before reading or writing, commit + push after writing.

```bash
# Before any read or write:
cd /workspace/global && git pull --rebase

# After every write operation (ingest, update, lint, query-filed):
cd /workspace/global && git add wiki/ && git commit -m "<action>: <title>" && git push
```

Action values: `ingest`, `update`, `lint`, `query-filed`, `conflict`. Commit title is the page or operation name.

On push conflict, see CONVENTIONS.md §9.3 — save draft to `wiki/conflicts/{YYYY-MM-DD}-{slug}.md`, log it, notify user, never force-push.

---

## Container-Specific Source Tools

When ingesting, save raw sources to `/workspace/global/sources/` before processing.

**Web pages (static HTML):**

```bash
curl -sLo /workspace/global/sources/filename.html "https://example.com/article"
```

**Web pages (needs JS rendering):**

```bash
agent-browser open https://example.com/article
agent-browser snapshot -i
```

**PDFs:**

```bash
pdftotext /workspace/global/sources/document.pdf /workspace/global/sources/document.txt
```

Save sources before processing so a future agent can reread them without re-fetching. Sources are gitignored per §1 of CONVENTIONS.md — they don't sync cross-machine. If another agent references a source you don't have, trust the page; the page is the durable artifact.

---

## Host-Side Auto-Sync (operational warning)

The host runs a systemd timer `major-repo-sync.timer` every 30 min that pulls + pushes the wiki as belt-and-suspenders reconciliation. If it fires while you're mid-edit across multiple files, it may commit and push your in-progress state, leaving cross-links to not-yet-pushed pages for a ~2-min window. Mitigations are in CONVENTIONS.md §9.4: commit+push at atomic milestones within a session, not only at the end.

---

## Everything Else

All rules about page structure, confidence markers, stubs, cross-references, workflow-vs-durable, hot-page handling, index and log maintenance, operations (ingest/query/lint), and category taxonomy live in `/workspace/global/wiki/CONVENTIONS.md`. Go there.
