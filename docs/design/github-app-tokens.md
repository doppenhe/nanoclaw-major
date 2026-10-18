# Design: short-lived GitHub tokens via a GitHub App

**Status: designed, not built.** Nothing in this document is implemented. The
shipping mechanism is the long-lived PAT described in
[LOCAL.md](../LOCAL.md#github-credential-injection-for-doppenhe-mounts).

## The problem

Agents can push to `doppenhe/major_wiki` and `doppenhe/major_content`. Today the
host resolves a token with `gh auth token -u doppenhe`, writes it to
`data/gh-tokens/<session>.token` at 0600, and mounts it read-only into the
container. The 2026-08-23 rework changed *how the credential travels* — a mount
instead of an environment variable, so upstream's admission rules can see it —
but not who can read it.

What the agent holds is a **long-lived fine-grained PAT**. Concretely:

- It does not expire on any timescale relevant to a session. A token exfiltrated
  through a prompt injection, a compromised MCP server, or a bug that logs it
  stays valid until noticed and manually rotated.
- Its scope is the whole PAT: Contents:RW on `major_content` **and**
  `major_wiki`, for every session, whether or not that session mounts either.
- Revocation is all-or-nothing and manual. There is no per-session handle to cut.

None of this is new — the pre-2026-08-23 env-var shape had exactly the same
exposure. The rework simply made it visible enough to be worth fixing.

## The proposal

Replace the PAT with a **GitHub App installation access token**, minted per
session. GitHub App installation tokens expire after **60 minutes** and can be
scoped, at mint time, to specific repositories and permissions.

That TTL fits this system well. `ABSOLUTE_CEILING_MS` in `src/host-sweep.ts` is
30 minutes: the sweep kills a container that has run longer without a declared
extension. So in the normal case a minted token comfortably outlives the session
that holds it, and no refresh machinery is needed. (The ceiling is
`Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0)`, so a session declaring a
long bash timeout can exceed 60 minutes — see "Open questions".)

The exposure becomes: a leaked token is valid for at most an hour, carries only
the repositories that session actually mounted, and can be revoked individually
via `DELETE /installation/token`.

### What changes

Only the inside of `resolveGithubTokenForMounts` changes. The by-reference
plumbing built on 2026-08-23 — the 0600 file, the read-only mount at
`/run/nanoclaw/gh-token`, `GH_TOKEN_FILE`, the credential helper, the cleanup on
exit — is exactly right for this and stays untouched. That is the payoff of
having isolated it in `src/fork-github-auth.ts`.

```
resolveGithubTokenForMounts(mounts)
  1. Determine which doppenhe/* repos are actually mounted writable
     (already done — the scan exists, it just discards the repo names today).
  2. Read the App's private key + App ID from the OneCLI vault.
  3. Sign a short JWT (RS256, iss = App ID, exp <= 10 min).
  4. GET  /app/installations                → installation id (cacheable)
  5. POST /app/installations/<id>/access_tokens
       { repositories: [<the mounted ones>],
         permissions: { contents: "write" } }
     → { token, expires_at }
  6. Return token.
```

Steps 3–5 are the only new code: roughly 60 lines, no new dependency if we sign
the JWT with `node:crypto` (`crypto.createSign('RSA-SHA256')`).

Step 1 is the scope win and is nearly free — the mount scan already visits every
`.git/config` and matches `doppenhe/`; it just needs to collect the repo names
instead of returning a boolean.

### Setup this requires from a human

This is why it is not built. Someone has to:

1. Register a GitHub App under the `doppenhe` account. Permissions:
   **Contents: Read and write**, nothing else. No webhook.
2. Install it on `doppenhe/major_wiki` and `doppenhe/major_content` only.
3. Generate a private key (`.pem`) and record the App ID.
4. Store both in the OneCLI vault. The private key is a real secret and must not
   land in `.env` or a plaintext file — the ban in
   [LOCAL.md](../LOCAL.md#credential-pattern-post-2026-05-20-consolidation)
   applies.
5. Keep the PAT until the App path is verified end to end, then revoke it.

Steps 1–3 cannot be automated from here and involve choices — App name,
visibility, which account owns it — that are the owner's to make.

## Why not the alternatives

**OneCLI vault injection.** The natural answer, and it does not work for GitHub.
The gateway special-cases `github.com`, ignores `generic` vault secrets for that
host, and expects its own OAuth-app connection; a raw PAT returns
`HTTP 401 invalid credentials`. Verified 2026-05-20. This is the reason the
`NO_PROXY=github.com` bypass exists at all.

**A deploy key per repo.** Narrower than a PAT and simple, but SSH-only (so the
credential-helper path is replaced by an SSH agent or a mounted key), still
long-lived, and needs one key per repo. Strictly worse than an App token on the
dimension that matters — lifetime.

**A host-side git proxy** that agents push through, with the credential never
entering the container at all. Genuinely the strongest option: the token stops
being something the agent holds. Also by far the most work — a service, a
protocol, and a new failure mode between the agent and every push. Worth
revisiting if agents ever need write access to repos we do not own.

**Doing nothing.** Defensible, and it is the current state. The blast radius is
two repos of our own content, on a single-user host, and the wiki is
reconstructible from history. The argument for fixing it is that the cost is
about a day and the exposure is permanent until someone spends it.

## Open questions

- **Sessions that outlive 60 minutes.** A declared long bash timeout raises the
  sweep ceiling past the token's TTL, and a push at minute 70 fails with a
  confusing `401`. Options: mint on demand instead of at spawn (needs a
  host-side channel from container to host — the mailbox could carry it, but
  that is a new message kind); have the host rewrite the token file in place
  before expiry (the mount is a bind, so the container sees the new bytes with
  no restart — probably the cheapest correct answer); or accept it and make the
  failure legible. **Recommendation: rewrite in place**, driven off the existing
  sweep tick, which already runs every 60s and already knows which sessions are
  alive.
- **Rate limits.** Installation token creation is not generously limited. One
  mint per spawn is fine at this install's volume; a crash-looping container
  would not be. Worth a cache keyed on `(installation, repo set)` reusing a
  token until it is within ~10 minutes of expiry.
- **Does `gh` inside the container care?** The credential helper feeds git
  directly, so `git push` is fine. Any agent workflow calling `gh` as a CLI
  would need `GH_TOKEN` too — check whether the container skills do before
  removing the fallback in the Dockerfile helper.

## If we build it

Suggested order, each step independently verifiable:

1. Collect mounted repo names in the scan (pure refactor, no behavior change,
   tests stay green).
2. Add the App client behind a flag, defaulting off; unit-test JWT signing and
   the mint call against a fake.
3. Flip one agent group to the App path; verify a real push end to end using
   the Step 8b procedure in [UPGRADE-2026-08-23.md](../UPGRADE-2026-08-23.md).
4. Add in-place refresh for long sessions.
5. Flip the default, keep the PAT path behind the flag for one week.
6. Revoke the PAT, delete the flag.

`src/fork-github-auth.test.ts` already pins the admission-shape invariants, so
none of this can silently regress into putting a credential back on the env
lane — a token minted by an App is still a `ghs_`-prefixed value that
`looksLikeCredential` refuses.
