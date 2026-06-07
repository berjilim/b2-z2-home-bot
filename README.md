# BeZa Home Bot

A standalone, always-on home guardian for Bernard & Zane — lives as a Home
Assistant Supervisor add-on (so it never depends on a laptop being awake),
talks over Telegram, and runs on the Claude Agent SDK via ACP
(`@agentclientprotocol/claude-agent-acp`).

This is **not** an OpenClaw agent. It's a lean, self-contained process:
auth, sessions, memory, and triggers are all handled here directly — no
gateway, no orchestration layer.

## Why this exists

The original BeZa runs as an OpenClaw agent on a MacBook. That's fine for
reasoning and chat, but its listener daemon dies whenever the laptop sleeps
or shuts down — a real gap for a "guardian" that's supposed to watch the
home 24/7. This project ports BeZa's actual logic (standing orders, trigger
listener, zero-token notify path) onto infrastructure that's always on:
the same box that runs Home Assistant.

Packaging/hosting pattern is adapted from
[`ha-copilot-telegram-bot`](https://github.com/layman-smart-home-people/ha-copilot-telegram-bot)
(Sam Thng) — Dockerfile, s6-overlay service, HA Supervisor add-on structure —
with the agent swapped from GitHub Copilot CLI to Claude (via the official
ACP adapter on top of the Claude Agent SDK).

## Status

🚧 Scaffolding — see `PLAN.md` for the build order.

## Auth

Uses a Claude subscription token (`claude setup-token`), not a metered API
key — kept in a local `.env` file, never committed (see `.gitignore`).
