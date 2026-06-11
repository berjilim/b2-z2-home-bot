# BZ-V2 Home Guardian

An always-on AI home guardian that runs as a Home Assistant Supervisor add-on and talks to you over Telegram. Powered by Claude via the official ACP adapter.

## What it does

- **Standing orders** — give it natural-language instructions like *"tell me when someone enters the master toilet"* or *"turn everything off when nobody's home for 30 minutes"*
- **Always watching** — runs on your HA box, not your laptop; never misses a trigger
- **Zero-token notify path** — simple alerts fire instantly without waking the AI
- **Bayesian verification** — compound conditions (nobody home, everyone asleep) are checked against multiple signals before acting
- **Persistent memory** — learns your home's entity quirks and inference rules; survives add-on updates

## Requirements

- Home Assistant OS or Supervised
- A Telegram account and bot token (via [@BotFather](https://t.me/BotFather))
- A Claude subscription token (`claude setup-token` from the Claude CLI)

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**
2. Open **⋮ → Repositories** and add:
   ```
   https://github.com/berjilim/b2-z2-home-bot
   ```
3. Install **BZ-V2 Home Guardian**
4. In the **Configuration** tab, set:
   - `claude_oauth_token` — your Claude subscription token
   - `telegram_bot_token` — your BotFather token
   - `owner_chat_id` — your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))
5. **Start** the add-on and send your bot a message

## Usage

Just message your bot naturally. Examples:

- *"Notify me when someone enters the master toilet"*
- *"Turn off all lights and ACs when nobody's home for 30 minutes"*
- *"What's the current state of the living room?"*
- *"List my standing orders"*

## Auth

Uses a Claude subscription token, not a metered API key — no per-token cost for conversations.
