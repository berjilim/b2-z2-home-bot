# Build plan

1. **Spike** — get `@agentclientprotocol/claude-agent-acp` running standalone
   over stdio, confirm `initialize` → `authenticate` → `session/new` →
   `session/prompt`, capture real `authMethods` / mode IDs / MCP param shapes.
2. **Standing-orders engine** — port schema + reasoning loop from BeZa
   (`active.json`, trigger conditions, `notify` vs `wake_agent`).
3. **HA listener daemon** — adapt BeZa's `listener.mjs` (HA WebSocket,
   watches `active.json`, fires triggers).
4. **Wake → inject → run → capture glue** — listener fires → fresh
   `session/new`/`session/prompt` with trigger context + order + memory →
   agent acts via HA MCP tools → write results → notify.
5. **Memory/continuity files** — port `home-entities.md`,
   `home-deductions.md`, `active.json` conventions (plain files, no
   OpenClaw memory system needed).
6. **Telegram transport** — minimal bot adapter (lift from Sam's bot if
   straightforward, or write fresh — BeZa doesn't need WebUI/RBAC).
7. **HA Supervisor add-on packaging** — Dockerfile, s6-overlay,
   `repository.json`, templated from Sam's bot.
8. **Cutover** — run alongside Mac-hosted BeZa during burn-in, then retire it.

Currently on: **step 1**.
