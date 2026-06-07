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

Currently on: **step 4**.

## Step 3 (DONE)
- `src/triggers.mjs` — pure trigger-evaluation logic, extracted & tested
- `src/listener.mjs` — `HAListener`: HA WebSocket connection, reconnect/
  heartbeat, hot-reloads `active.json` via `OrdersStore`, dispatches to
  direct Telegram notify (0 tokens) or an injected `onWake(order, ctx)`
  callback. **Decoupled from OpenClaw on purpose** — the original posted
  to an OpenClaw hooks endpoint; here, waking the agent is the caller's
  job (wired up properly in step 4's ACP glue).
- `src/telegram.mjs` — minimal Bot API sender, no SDK dependency
- All three test suites passing (`npm test`)

## Step 2 (DONE)
- `standing-orders/SCHEMA.md`, `prompts/guardian-system-prompt.md`,
  `memory/{home-entities,home-deductions}.md` (carried over from BeZa —
  same house), `src/orders.mjs` (OrdersStore data layer, tested).

## Step 1 findings (spike — DONE, round trip confirmed)

- Auth: subscription tokens (`claude setup-token`) go in env var
  **`CLAUDE_CODE_OAUTH_TOKEN`**, NOT `ANTHROPIC_API_KEY` (that's reserved for
  metered Console billing — setting both causes `authentication_failed`).
- Real session modes returned by `session/new`: `auto`, `default`,
  `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. For unattended
  trigger-driven runs, `dontAsk` or `bypassPermissions` are the candidates
  (no Telegram approval round-trip for routine HA actions).
- Real model options: `default` (Opus 4.8), `sonnet` (4.6), `sonnet[1m]`,
  `haiku`, plus an `effort` dial (`low`→`max`). Use `haiku` or
  `sonnet`+`effort:low` for a lightweight always-on guardian — not the
  default Opus.
- Cost is visible per-turn via `session/update` → `usage_update.cost.amount`
  (USD) — wire this into the guardian's own notify/wake cost tracking.
- IMPORTANT: must set `cwd` and `CLAUDE_CONFIG_DIR` to a project-scoped dir,
  NOT inherit the operator's `~/.claude` — otherwise it picks up unrelated
  slash commands/memory (confirmed: spike auto-loaded Tron's commands).
- Spike harness lives at `spike/acp-roundtrip.mjs`, run via `npm run spike`.
