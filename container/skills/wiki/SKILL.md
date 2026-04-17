# Wiki

You maintain a persistent knowledge base at `/workspace/global/wiki/`. Raw sources live at `/workspace/global/sources/`. This wiki spans personal knowledge and business/work topics.

## Key Files

- `wiki/index.md` — catalog of all pages by category. Read this first when answering queries or deciding where new content belongs. Update it on every ingest.
- `wiki/log.md` — append-only chronological log. Add an entry for every ingest, query-filed-as-page, and lint pass.

## Operations

### Ingest

When the user provides a source (URL, PDF, image, voice note, document):

1. Save the raw source to `/workspace/global/sources/` — never modify source files after saving.
2. Read the source thoroughly.
3. Discuss key takeaways with the user before writing pages.
4. Create/update wiki pages: summary, entity pages, concept pages, cross-references, comparisons as appropriate.
5. Update `wiki/index.md` with new/changed pages.
6. Append to `wiki/log.md`: `## [YYYY-MM-DD] ingest | Source Title`

**Critical:** Process one source at a time. Finish completely (all pages updated, index updated, log entry written) before moving to the next source. Never batch-read multiple sources then process them together — this produces shallow, generic pages.

#### URL sources

For web articles where full text matters, download the content rather than relying on summaries:

```bash
curl -sLo sources/filename.html "https://example.com/article"
```

For pages that need JavaScript rendering, use `agent-browser`:

```bash
agent-browser open https://example.com/article
agent-browser snapshot -i
```

#### PDF sources

Use `pdftotext` if available:

```bash
pdftotext sources/document.pdf sources/document.txt
```

### Query

When the user asks a question against the wiki:

1. Read `wiki/index.md` to locate relevant pages.
2. Read those pages.
3. Synthesize an answer with citations (reference which wiki pages/sources informed the answer).
4. If the answer is substantial and reusable, offer to file it as a new wiki page.

### Lint

Health-check the wiki for:

- Contradictions between pages or with newer sources
- Orphan pages (not linked from index or other pages)
- Missing cross-references between related topics
- Important concepts mentioned but lacking their own page
- Stale claims superseded by newer sources
- Data gaps worth investigating

Report findings and offer to fix issues.

## Page Conventions

- Use markdown with clear headings.
- Cross-reference other wiki pages with relative links: `[Entity Name](entity-name.md)`
- Include a "Sources" section at the bottom of each page listing which raw sources informed it.
- Use descriptive filenames: `entity-name.md`, `concept-topic.md`, `comparison-x-vs-y.md`, `summary-source-title.md`
