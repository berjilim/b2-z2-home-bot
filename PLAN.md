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

Currently on: **step 7** — packaging scaffold built (2026-06-08):
`Dockerfile`, `config.yaml`, `repository.json`, and the s6-overlay
`bz-v2` service are in place, modeled on Sam Thng's
`ha-copilot-telegram-bot` but trimmed to BZ-V2's lean shape (no
WebUI/ingress, no RBAC, no group chat — single Node process). The
`run` script translates Supervisor `options.json` into the env vars
`src/main.mjs` already expects — `CLAUDE_CODE_OAUTH_TOKEN`,
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_BERNARD_ID`/`TELEGRAM_ZANE_ID`, and
`HA_URL=http://supervisor/core` + `HA_TOKEN=$SUPERVISOR_TOKEN` (the
internal proxy — no external HA exposure needed once running as the
add-on). `main.mjs` needs **zero changes** to run this way.

Remaining for step 7: a real build/install test on an actual HA
Supervisor host (this scaffold is untested against a live Supervisor —
only validated for syntax: YAML/JSON parse, bash `-n` on the run/finish
scripts). Placeholder repo URLs (`github.com/bernardlim/beza-home-bot`)
need updating once the repo has a real remote.

Before full cutover we still need a real production entrypoint
(currently each piece — telegram-bot, listener, wake-glue — is only
wired together in spike/test scripts, not in a single `src/main.mjs`
that runs them all against a live runner). That's folded into step 7/8
work below.

## Decisions log

- **DM, not group chat** (2026-06-08) — BZ-V2 talks to Bernard & Zane via
  separate DMs, at least for now. Matches the original BeZa's model
  (single hardcoded `TELEGRAM_ID`) but needs to support *two* user IDs,
  not one — see step 6 design notes below.
- **RBAC is wanted, eventually** (2026-06-08) — Sam's bot has a full
  role/invite/audit system; Bernard wants BZ-V2 to grow toward something
  like that, even if not in the first cut. For now: keep the user model
  simple (Bernard + Zane, both full-trust), but don't paint into a corner —
  `src/orders.mjs` and the Telegram transport should key actions by user ID
  from day one (easy to layer roles on top of later) rather than assuming
  a single global user.
- **New Telegram bot needed** — BZ-V2 needs its own bot identity (own
  @BotFather token), separate from the existing OpenClaw-hosted BeZa bot,
  since it talks to Telegram directly with no gateway in between. Tron will
  walk Bernard through @BotFather setup when step 6 build reaches the
  point of needing a live token (not yet).

## Step 6 (DONE — live-verified 2026-06-08)
- `src/agent-runner.mjs` refactored: `runTurn()` is now a thin wrapper
  over three new primitives — `openSession()`, `prompt(sessionId, text)`,
  `closeSession(sessionId)`. The wake path still uses `runTurn` (one
  session per wake, matches BeZa's pattern); the conversational path
  needs a session that survives across multiple user messages, hence
  the split.
- `src/telegram-bot.mjs` — `createTelegramBot()`: long-polls
  `getUpdates` (no SDK — same `fetch`-direct style as `telegram.mjs`),
  filters to `allowedUsers` (Telegram user id -> name, keyed per-user
  from day one per the RBAC decision above), keeps **one persistent ACP
  session per user** so the agent retains conversation state through
  the order-taking reasoning loop, primes the *first* turn with the
  system prompt + all `memory/*.md` (subsequent turns are just
  `"<name>: <message>"` — the session already has context), and relays
  every reply straight back to that user's chat. Unauthorized senders
  are logged and silently ignored (DM model — no group RBAC needed yet).
- `src/telegram-bot.test.mjs` — smoke test against a fake runner +
  stubbed `fetch`; verifies one session opens per user, the first turn
  is primed and later turns aren't, replies route to the right chat,
  and unauthorized users are dropped. Passing (`npm test`).
- **Live-verified 2026-06-08:** real `@b2z2_home_bot` token + Bernard's
  Telegram user ID in `.env`, ran `npm run` equivalent of the live check
  (`spike/telegram-bot-check.mjs`) against the real Bot API + ACP runner,
  Bernard DM'd the bot from Telegram, two turns completed cleanly
  (`stopReason=end_turn`), reply content confirmed correct. Single-user
  for now (`allowedUsers` = Bernard only; Zane to be added later).
- **Production entrypoint built (2026-06-08):** `src/main.mjs` (run via
  `npm start`) wires `ClaudeAgentRunner` + `OrdersStore` + `HAListener`
  + `createWakeHandler` + `createTelegramBot` into one process. Loads
  `.env`, validates required vars fail-fast (`CLAUDE_CODE_OAUTH_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BERNARD_ID`, `HA_URL`, `HA_TOKEN`,
  optional `TELEGRAM_ZANE_ID`), and handles SIGINT/SIGTERM shutdown
  (stops listener, bot, and runner cleanly). `mcpServers: []` for now —
  HA MCP wiring is still TODO (tracked separately, not blocking step 7
  packaging). Verified: `node --check` passes, full `npm test` suite
  passes, and a dry run correctly fails fast on missing `HA_URL`/`HA_TOKEN`.
- **Full live-stack run + both action paths verified (2026-06-08):**
  Bernard supplied `HA_URL=http://homeassistant.local:8123` + a long-lived
  HA token; `npm start` ran the entire process live — ACP runner, HA
  WebSocket listener (connected, authenticated, subscribed to
  `state_changed`), and Telegram bot, all together for the first time.
  Armed two throwaway test orders against `light.entrance_dining_right`
  (now removed — `active.json` back to `[]`):
  - **`notify` path** (zero-token): `turns_on` → listener matched →
    direct Telegram send → `[notify] delivered — 0 tokens used`.
    Bernard confirmed the message landed.
  - **`wake_agent` path**: `turns_off` → listener matched → fresh scoped
    ACP turn spun up with trigger context injected → Claude reasoned
    (903 output tokens, `stopReason=end_turn`) → reply relayed to
    Telegram. Bernard confirmed the message landed and content was sane.
  - Both paths fired correctly *while* the conversational bot was also
    live — proves the shared-runner design holds under concurrent use.
  - **Minor cosmetic issue noted:** ACP binary logs a noisy stderr
    warning (`"Method not found": session/cancel`) on session close —
    already swallowed by `.catch(() => {})` in `agent-runner.mjs:119`,
    doesn't affect correctness, but worth skipping the call outright
    later since this ACP version (`v0.42.0`) doesn't support
    `session/cancel`.
  - **Step 7 core wiring is now fully proven live, end to end.**

## Step 4 (DONE)
- `src/agent-runner.mjs` — `ClaudeAgentRunner`: owns the spawned ACP
  subprocess, JSON-RPC/NDJSON plumbing, and one high-level op `runTurn()`
  that creates a fresh session, sets its mode, sends one prompt, captures
  the streamed final assistant text + usage, then lets the session end.
  Auto-approves `session/request_permission` (no human in the loop during
  unattended wakes — that's what `bypassPermissions`/`dontAsk` mode is for).
  **Verified against the live binary** via `npm run runner-check`.
- `src/wake-glue.mjs` — `createWakeHandler()`: the actual "wake → inject →
  run → capture" glue. Assembles the prompt (system prompt + all memory/*.md
  + order + trigger context), runs one scoped turn via the runner, and
  relays the agent's final reply to Telegram **as the single notification**
  (updated the system prompt's contract accordingly — the agent's last
  message IS the notification; it doesn't call a messaging tool itself).
  Falls back to a generic "something happened, worth checking" message if
  the agent produces an empty reply (never silent on failure).
- `src/wake-glue.test.mjs` — tests prompt assembly and notify-relay against
  a fake runner; passing.

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
