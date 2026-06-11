// ============================================================
// Entrypoint — wires every piece into one running process
// ============================================================
// telegram-bot (conversational) + HAListener (trigger watcher) +
// wake-glue (unattended scoped turns) all share one ClaudeAgentRunner
// and one Telegram identity. This is what the HA Supervisor add-on
// container actually runs.
//
// Run with: node src/main.mjs   (or `npm start`)

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { ClaudeAgentRunner } from "./agent-runner.mjs";
import { OrdersStore } from "./orders.mjs";
import { HAListener } from "./listener.mjs";
import { createWakeHandler } from "./wake-glue.mjs";
import { createTelegramBot } from "./telegram-bot.mjs";
import { makeTelegramSender } from "./telegram.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

loadEnv(join(root, ".env"));
delete process.env.ANTHROPIC_API_KEY; // force subscription auth via CLAUDE_CODE_OAUTH_TOKEN

// Support both new (OWNER_CHAT_ID) and legacy (TELEGRAM_BERNARD_ID) env var names.
const ownerChatId = process.env.OWNER_CHAT_ID || process.env.TELEGRAM_BERNARD_ID;

const required = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "HA_URL",
    "HA_TOKEN",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length || !ownerChatId) {
    if (!ownerChatId) missing.push("OWNER_CHAT_ID");
    console.error(`[main] missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
}

const allowedUsers = { [ownerChatId]: "Owner" };

const systemPromptPath = join(root, "prompts", "guardian-system-prompt.md");
// MEMORY_DIR points at the add-on's persistent /data/memory (seeded from
// the image's memory/ on first boot — see rootfs run script) so learned
// rules survive updates. Falls back to the repo dir for local dev.
const memoryDir = process.env.MEMORY_DIR || join(root, "memory");
// ORDERS_PATH points at /data/standing-orders/active.json (persistent volume)
// so armed orders survive add-on updates — same fix as MEMORY_DIR above.
const ordersPath = process.env.ORDERS_PATH || join(root, "standing-orders", "active.json");
// AGENT_CWD is the working directory for all ACP agent sessions. On the
// Supervisor this is /data (persistent volume) so BZ's file tool writes
// (memory/home-deductions.md, standing-orders/active.json etc.) land in
// /data/... and survive add-on updates. Falls back to /app for local dev.
const agentCwd = process.env.AGENT_CWD || root;
// Bundle the `hass-mcp` package as a
// stdio MCP server — full REST/WebSocket entity access via HA_URL/HA_TOKEN,
// not the Assist-exposure-scoped surface HA's built-in MCP Server integration
// offers. Runs as a subprocess of the agent session over the internal
// Supervisor proxy (HA_URL=http://supervisor/core, HA_TOKEN=$SUPERVISOR_TOKEN).
const mcpServers = [
    {
        type: "stdio",
        name: "home-assistant",
        command: "node",
        args: [join(root, "node_modules", "hass-mcp", "dist", "index.js")],
        env: [
            { name: "HASS_URL", value: process.env.HA_URL },
            { name: "HASS_TOKEN", value: process.env.HA_TOKEN },
        ],
    },
];

// Direct, per-chat sender for the conversational transport (replies go
// back to whoever DM'd, not a fixed chat).
async function sendTelegramTo(text, chatId) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram] send failed: ${data.description}`);
    return data.ok;
}

// "Processing..." placeholder + edit-in-place pattern: send a placeholder the
// instant a message lands (so there's an immediate visual cue that something
// is happening — turns can take 10-30s with HA tool calls in the loop), then
// swap its content for the real reply once the turn completes. Telegram
// animates the text change client-side — feels far more polished than a
// typing bubble that auto-expires after 5s on a long-running turn.
async function sendTelegramPlaceholder(chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json();
    if (!data.ok) {
        console.error(`[telegram] placeholder send failed: ${data.description}`);
        return null;
    }
    return data.result.message_id;
}

async function editTelegramMessage(chatId, messageId, text) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram] edit failed: ${data.description}`);
    return data.ok;
}

// Fixed-chat sender for the listener/wake-glue path — notifications and
// wake replies go to the owner (single-user model until RBAC is wired in).
const notifyOwner = makeTelegramSender({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: ownerChatId,
    logger: console,
});

const binPath = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const runner = new ClaudeAgentRunner({ binPath, logger: console });
await runner.start();

const ordersStore = new OrdersStore(ordersPath);

const onWake = createWakeHandler({
    runner,
    projectRoot: agentCwd,
    systemPromptPath,
    memoryDir,
    mcpServers,
    sendTelegram: notifyOwner,
    mode: "dontAsk",
    logger: console,
});

const listener = new HAListener({
    haUrl: process.env.HA_URL,
    haToken: process.env.HA_TOKEN,
    ordersStore,
    sendTelegram: notifyOwner,
    onWake,
    logger: console,
});

const bot = createTelegramBot({
    runner,
    projectRoot: agentCwd,
    systemPromptPath,
    memoryDir,
    mcpServers,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers,
    sendTelegram: sendTelegramTo,
    sendPlaceholder: sendTelegramPlaceholder,
    editReply: editTelegramMessage,
    mode: "default",
    logger: console,
});

listener.start();
await bot.start();
console.log("[main] BZ-V2 is up — listener watching HA, bot watching Telegram");

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[main] ${signal} received — shutting down`);
    listener.stop();
    await bot.stop();
    await runner.stop();
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function loadEnv(envPath) {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) process.env[m[1]] = m[2].trim();
    }
}
