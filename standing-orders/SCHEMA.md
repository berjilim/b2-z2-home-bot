# Standing Orders — Schema & Engine Rules

Ported from the original BeZa (`workspace-beza/AGENTS.md`), adapted for a
standalone Claude+ACP agent with no OpenClaw substrate underneath it.

Orders live in `standing-orders/active.json` as a JSON array. Only orders
with `"status": "armed"` are watched by the listener daemon (see step 3).

## Exact schema

```json
{
  "id": "unique-kebab-slug",
  "description": "What was asked, in the user's words",
  "outcome": "The desired real-world end-state (separate from implementation)",
  "plan": "Plain English: what will be watched, and what happens when triggered",
  "confidence": "high | medium — one-line reason, e.g. 'medium — covers Bernard+Zane, blind to guests'",
  "trigger": {
    "entity": "sensor.entity_id_here",
    "condition": "see condition list below",
    "value": 65,
    "to": "on",
    "from": "off"
  },
  "verify_condition": "Plain English: what to check on wake before acting (omit for simple orders)",
  "action_type": "notify",
  "cooldown_seconds": 60,
  "notify_on_trigger": "Message to send when the trigger fires (before acting)",
  "notify_on_complete": "Message to send when the order is fully fulfilled",
  "re_arm": false,
  "expires_at": "2026-06-07T12:00:00+08:00",
  "status": "armed"
}
```

## Fields for complex orders

**`outcome`** — The desired real-world end-state in the user's words. Keeps you anchored to *what matters* when you wake, vs. the specific implementation you chose.

**`confidence`** — Your honest assessment of the implementation quality. Always include a brief reason so the user understands the limitation. E.g. `"medium — person entities reliable for Bernard+Zane but blind to guests"`.

**`verify_condition`** — Present when candidate trigger(s) alone aren't sufficient to confirm the condition (compound presence, multi-signal logic). When you wake and find this field, run a Bayesian evidence sweep before acting (see system prompt). If confidence is below threshold after the sweep, stand down and log.

**`re_arm`** (default `false`) — If `true`, set `status` back to `"armed"` after executing. Use for recurring orders ("every time nobody's home…", "whenever I leave…"). If `false`, order goes to `"complete"` after the first execution.

**`pending_recheck_at`** (ISO 8601 timestamp, optional) — Set this when you wake on a candidate trigger but want to verify the condition has *persisted* before acting (e.g. confirm nobody returned home after 30 minutes). The listener polls every 60 seconds and re-wakes you when the timestamp elapses, passing `{ recheck: true }` in the trigger context. The daemon clears the field before the recheck wake to prevent double-fire. Use alongside `verify_condition` — `verify_condition` for signal-based checking, `pending_recheck_at` for time-based persistence checking.

## `action_type` — the cost/latency split

| value | what happens | cost |
|---|---|---|
| `"notify"` | Listener sends the Telegram message directly. The agent never wakes. | **$0 — zero tokens** |
| `"wake_agent"` | Listener spins up a fresh ACP session, injects trigger context, the agent reasons and acts via HA tools. | ~$0.01–0.05 per wake (haiku/sonnet, low effort — see PLAN.md cost notes) |

**Default to `"notify"` unless the order genuinely requires HA service calls
or multi-step reasoning.** Most "let me know when X" orders are `"notify"`.

## Supported trigger conditions

| condition | fires when |
|---|---|
| `state_change` | entity state changes (use `to`/`from` to filter) |
| `turns_on` / `turns_off` | entity state becomes `on` / `off` |
| `above` / `rises_above` | numeric value crosses above `value` (rising edge) |
| `below` / `drops_below` | numeric value crosses below `value` (falling edge) |
| `becomes_home` / `becomes_away` | person/device state enters/leaves `home` |

## Multiple triggers (OR logic)

Use `"triggers": [...]` (array) instead of `"trigger"` (single object) for
any-of matching.

## The reasoning loop (system-prompt contract)

When a message reads like an order (not a question, not chitchat):

0. **Survey** — use your HA MCP tools to read entities relevant to the order
   (person entities, device trackers, sensors, automations). Don't assume
   what's available — look first. Skip for simple orders where the entity is
   obvious and unambiguous (e.g. a dedicated sensor).
1. **Reason** — identify the desired `outcome`, then find the best available
   implementation using what you found. For compound conditions (multi-person
   presence, "nobody home", multi-signal logic): use `triggers` (array) for
   candidate entities and set `verify_condition` so you can do a Bayesian
   check on wake. Assess your `confidence` honestly.
2. **Clarify** — if anything is ambiguous, ask ONE focused question. Never
   stack multiple questions.
3. **Plan** — present: what you'll watch, what happens on trigger, your
   `confidence` level, and any stated gaps (e.g. "blind to guests").
4. **Confirm** — wait for explicit approval ("yes", "go ahead", "do it") before
   arming.
5. **Arm** — read `active.json`, append the new order, write the full array
   back, with `"status": "armed"`.
6. **Execute on wake** — when the listener wakes the agent:
   - Re-read `active.json` to get the full order
   - **If `verify_condition` is present:** run a Bayesian evidence sweep
     before acting (see system prompt). Stand down if confidence < 80%;
     log the reason and set status to `"armed"` (don't consume the trigger).
   - Take the appropriate actions via HA MCP tools
   - Send a Telegram notification
   - If `re_arm: true`, set `status` back to `"armed"`. Otherwise set to
     `"complete"` (or `"triggered"` if genuinely ongoing).
   - Write the updated array back

## Multi-step task discipline

When an order requires several actions ("turn everything off except the
ACs" → many `light`/`switch` calls):

- Do all the steps first, then send **one** consolidated summary. Don't
  notify after each individual action.
- The summary reads like a result, not a transcript: "Done — turned off
  living room, kitchen, and bedroom lights. ACs left running."
- **Self-watchdog**: if a task will genuinely take a while, say so up front
  in one short line, then still close with a single consolidated result.
- If part of a task fails, report what succeeded and what didn't in the
  *same* final message — no separate follow-up "oops".

## Differences from the original (OpenClaw-hosted) BeZa

- No gateway/orchestration layer — this agent never talks to Tron, never
  shares OpenClaw's memory system. Continuity is **plain files** in
  `memory/` and `standing-orders/active.json`, read at the start of every
  session and written back at the end (see `prompts/guardian-system-prompt.md`).
- Each wake is a **fresh, scoped ACP session** (`session/new` +
  `session/prompt`), not a persistent conversation — matches the
  sleep/wake/sleep usage pattern exactly, and keeps cost predictable.
