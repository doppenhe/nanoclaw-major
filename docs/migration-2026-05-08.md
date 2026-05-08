# v1 → v2 migration completion (2026-05-08)

`bash migrate-v2.sh` ran on 2026-05-04 from v1 path `/home/diego/dmo-projects/nanoclaw-major` (v1.2.53). All deterministic steps succeeded; service was switched to `nanoclaw-v2-30518667.service` and v1 disabled. Messages have been delivering on Telegram for several days by the time this note was written.

## Handoff snapshot (from `logs/setup-migration/handoff.json`)

```json
{
  "version": 1,
  "started_at": "2026-05-08T14:39:39Z",
  "v1_path": "/home/diego/dmo-projects/nanoclaw-major",
  "v1_version": "1.2.53",
  "overall_status": "success",
  "source": "migrate-v2.sh",
  "channels_installed": ["telegram"],
  "onecli_healthy": true,
  "service_switched": false,
  "steps": {
    "1a-env": "success",
    "1b-db": "success",
    "1c-groups": "success",
    "1d-sessions": "success",
    "1e-tasks": "success",
    "2b-channel-auth": "success",
    "2c-install-telegram": "skipped (already-installed)",
    "3b-onecli": "success",
    "3c-auth": "success",
    "3e-build": "success"
  }
}
```

`service_switched: false` in the handoff is stale — the v2 unit was loaded and started in a later session; v1's `nanoclaw.service` is now `disabled / inactive (dead)`.

## What `/migrate-from-v1` verified on 2026-05-08

- **Owner:** `telegram:5214488088` (D O) holds the global `owner` role in `user_roles`.
- **Active CLAUDE.local.md:** `groups/telegram_main/` and `groups/telegram_dmo-command-and-conquer/` are 38-line identity-only files (Major's content mission + voice rules). No v1 boilerplate left.
- **container.json:** both telegram groups have empty `additionalMounts` — correct, since `/workspace/agent` and `/workspace/global` come from baseline group/global mounts (see `docs/LOCAL.md`).
- **Access policy:** both messaging groups at `unknown_sender_policy = strict`. v1 history shows only the owner (`5214488088`) ever sent messages in `tg:-5223551468` (DMO Command and Conquer), so nothing to seed into `agent_group_members`. Strict is correct.
- **Fork customizations:** five commits on top of upstream (build cache mounts removed, GH_TOKEN injection for `doppenhe/*` mounts, `groups/global/` preservation, container skills `pdf-reader`/`status`/`capabilities`/`wiki`). All catalogued in [`docs/LOCAL.md`](LOCAL.md).
- **Orphaned group folders** kept in place (gitignored): `groups/main`, `groups/whatsapp_main` (heavy with sessions/screenshots), `groups/whatsapp_ai-gossip`, `groups/whatsapp_pef-ai-experimentation`. Not in DB; may be revived later.
- **`groups/global/CLAUDE.md` + `CLAUDE.local.md`** left in place — global is mounted as `/workspace/global` (the major_wiki repo); v2 doesn't compose its own CLAUDE.md there but the leftover files are harmless.

## Notes for future sessions

- `groups/telegram_dmo-command-and-conquer/` had no `.claude-shared.md` symlink or `.claude-fragments/` dir as of this date because its session has not been spawned since migration (`container_status = stopped`, `last_active = NULL`). Both will be created automatically by `composeGroupClaudeMd()` on first spawn.
- `groups/telegram_main/CLAUDE.local.md` and `groups/telegram_dmo-command-and-conquer/CLAUDE.local.md` are kept identical by hand (same identity content). When updating one, copy to the other — see `docs/LOCAL.md` "Per-group memory".
