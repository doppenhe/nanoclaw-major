# Design: Autonomous Major ↔ Cee interaction, mirrored into *DMO Command and Conquer*

**Status:** Design / not built. **Owner:** Diego. **Created:** 2026-07-01.
**Scope:** spans two systems — NanoClaw (this repo, "Major") and Hermes (`~/.hermes/hermes-agent/`, "Cee").

Goal: let Major and Cee — two independently-hosted agents that share the Telegram
group *DMO Command and Conquer* — hold an autonomous, open-ended conversation, with
the exchange **mirrored into that room** so a human can watch it live.

---

## 1. The hard constraint (why the obvious approach is impossible)

Both agents reach Telegram as **Bot API bots** (BotFather tokens, long-polling):

- **Major** — this NanoClaw install. `TELEGRAM_BOT_TOKEN` in `.env`; adapter
  `@chat-adapter/telegram` in `mode: 'polling'` (`src/channels/telegram.ts`).
- **Cee** — Hermes gateway. `TELEGRAM_BOT_TOKEN` in `~/.hermes/.env`;
  `hermes-gateway.service`, gateway state `telegram: connected`.

Telegram's Bot API **deliberately strips bot-authored messages from other bots'
updates**. Major never receives Cee's messages and vice versa. No trigger rule,
wiring, or config on either side changes this — it is a Telegram platform rule.

**Consequence:** the conversation cannot flow *through* the Telegram room. It must
flow over a **backchannel**, with the room used only as the display surface. Each
agent keeps posting to the room under its own bot identity, but they *hear* each
other over the backchannel, not via Telegram.

## 2. Current wiring (facts, as of 2026-07-01)

Central DB `data/v2.db`:

| Entity | ID | Notes |
|---|---|---|
| Agent group "Major Telegram" | `ag-1777914843751-fv7my8` | folder `telegram_main` |
| Agent group "DMO Command and Conquer" | `ag-1777914843751-b0l4bv` | folder `telegram_dmo-command-and-conquer` — this is **Major's** presence in the room |
| Messaging group "DMO Command and Conquer" | `mg-1777914843751-13py7e` | `telegram:-5223551468`, `is_group=1` |
| Wiring (room → Major) | — | `session_mode=shared`, `engage_pattern=@Major`, `sender_scope=all`, `ignored_message_policy=drop` |

Cee is **not** a NanoClaw agent group. It is a Hermes agent ("part of my group of AI
workers") whose Telegram bot is managed by the Hermes gateway. Major and Cee already
**share the `major` shmem project** over the shared HTTP MCP server
(`172.17.0.1:8705`), but that is memory, not a real-time message bus — neither is
*woken* by the other's writes.

## 3. Landscape — how the field solves cross-agent talk (2026)

| Protocol | Standardizes | Fit here |
|---|---|---|
| **A2A (Agent2Agent)** — Google → Linux Foundation, v1.0 early 2026, 150+ orgs | Peer agents discovering + delegating over HTTP (Agent Cards at `/.well-known/agent`, executor + event-queue/SSE) | The vendor-neutral answer for *symmetric* peer talk. Neither side speaks it today — adopting it is real work. Future-proofing, not phase 1. |
| **MCP** — Anthropic | One agent calling another's tools (client→server, **asymmetric**) | Cheap + native for us. Hermes ships `mcp_serve.py`; NanoClaw containers already mount MCP servers (shmem precedent). Good for "Major calls Cee," weak for peer symmetry. |
| **ACP / ANP** | Enterprise mesh / decentralized marketplaces | Overkill for two personal agents. |

**Loop mechanics** — reference design is AutoGen's two-agent conversation:
`max_turns`, `is_termination_msg`, `max_consecutive_auto_reply`. Even for
"open-ended", this machinery is what stops open-ended from becoming a runaway spend.
Keep the kill-switch; set the ceiling high rather than removing it.

## 4. Build surface already present on each side

**Cee / Hermes** (`~/.hermes/hermes-agent/`):
- `gateway/platforms/api_server.py` → **OpenAI-compatible HTTP API**:
  `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/runs`,
  `GET /v1/runs/{id}`, `/api/sessions/*`. `API_SERVER_ENABLED: true` in
  `~/.hermes/config.yaml` **but gateway state reports `api_server: disconnected`** —
  there is a bind-guard (`tests/gateway/test_api_server_bind_guard.py`); it must be
  bound (likely `127.0.0.1` or docker bridge `172.17.0.1`) + auth before use.
  *(Hermes-side prerequisite.)*
- `mcp_serve.py` → can expose Cee as an MCP server.
- `tools/delegate_tool.py`, `tools/async_delegation.py` → Hermes already has an
  internal agent-handoff/delegation concept.

**Major / NanoClaw** (this repo):
- Host writes a session's `inbound.db` (`messages_in`) → a host-side relay can
  **inject a synthetic inbound "from Cee"**, waking Major to reply in-room normally.
- Host reads `outbound.db` (`messages_out`) → the relay can **tap Major's outgoing
  turn** and forward it to Cee.
- Containers are MCP-native → alternatively give Major a `cee` MCP tool instead of
  injecting (same pattern as shmem wiring in `container_configs.mcp_servers`).

## 5. Candidate architectures

### A — Host-side relay / conductor  ← recommended for phase 1
A small mediator owns the turn-taking loop:
1. **Kick-off** — human drops a topic in the room (or a `/pair` command).
2. Relay forwards the current message to the *next speaker's* native inbound:
   Cee via `POST /v1/chat/completions` (returns text; does **not** auto-post to
   Telegram); Major via a synthetic `messages_in` inject into its session.
3. Relay posts that reply into the DMO room **under that agent's own bot token**
   (Major posts via its normal delivery path; Cee's text posted by the relay using
   Cee's bot token) → both voices show correct identity, no double-posts.
4. Hand the reply to the other agent. Repeat until a termination condition, idle
   timeout, turn cap, or human `stop`.

*Pros:* uses only existing APIs; central control of turn-taking + safety; clean
identities; fastest to working. *Cons:* bespoke glue we maintain; one Hermes-side
config change (bind `api_server`).

### B — MCP tool ("Major consults Cee")
Wire `mcp_serve.py` as a `cee` MCP server in Major's `container_configs` (identical
to the shmem wiring). Major calls Cee as a tool and posts the result.
*Pros:* extremely natural for NanoClaw; minimal new code. *Cons:* **asymmetric** —
Major initiates, Cee cannot independently start a turn. "Major with a Cee
consultant," not two peers. Does not fully satisfy "interact autonomously."

### C — A2A on both sides (standards-pure, future-proof)
Stand up an A2A server + Agent Card in front of each agent; they become
vendor-neutral peers. *Pros:* the actual industry answer; reusable for any future
agent. *Cons:* most work; neither speaks A2A today; over-engineered for two agents.

## 6. Recommendation

**Phase 1: Architecture A** (host-side conductor), mirrored into the DMO room, with
AutoGen-style safety rails. Shortest path to a real autonomous exchange watchable in
Telegram; reuses existing surfaces on both systems. The only cross-system change is
binding Hermes's already-enabled `api_server` — to be shown before touching the
Hermes box.

**Phase 2 (optional):** if this should be reusable beyond Major↔Cee, harden the
conductor into an **A2A** front on each side (Cee is already reachable via
`mcp_serve.py`/`api_server`; Major gets a thin A2A adapter). Upgrades the bespoke
relay to the standard without changing UX.

## 7. Safety rails (baked in even for "open-ended")
- **Turn ceiling** (high, e.g. 40 round-trips) + **idle auto-stop** + a hard
  `stop`/`pause` keyword anyone can drop in the room.
- **Dual cost meter** — every turn spends on *both* Anthropic (Major) and
  gpt-5.5/OpenAI (Cee). Per-session budget cap that pauses and pings Diego.
- **Loop detector** — halt on semantic echo/looping.

## 8. Open decisions (resolve before build)
1. **Kick-off model** — always human-seeded in the room, or can either agent
   self-initiate a topic?
2. **Where the conductor lives** — a new small host service, or a NanoClaw module?
3. **Hermes `api_server` binding** — OK to bind to docker bridge (`172.17.0.1`, like
   OneCLI/shmem) with a bearer token, reachable only by local host/containers?
4. **Phase 2 A2A** — worth it for reuse, or keep it a dedicated Major↔Cee bridge?

## 9. Sources
- Agent Interoperability Protocols 2026 (Zylos) — https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/
- A2A/MCP/ACP/ANP survey (arXiv) — https://arxiv.org/html/2505.02279v1
- A2A + AG-UI agent-to-agent (CopilotKit) — https://www.copilotkit.ai/blog/how-to-make-agents-talk-to-each-other-and-your-app-using-a2a-ag-ui
- AutoGen conversable agents & group chat — https://callsphere.ai/blog/autogen-microsoft-conversable-agents-group-chat
- AutoGen max_turns / termination (AutoGen 0.2 docs) — https://microsoft.github.io/autogen/0.2/docs/reference/agentchat/conversable_agent/
- Multi-agent coordination guide 2026 — https://www.developersdigest.tech/blog/how-to-coordinate-multiple-ai-agents
