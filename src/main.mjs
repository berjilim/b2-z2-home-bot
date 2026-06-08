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

const required = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BERNARD_ID",
    "HA_URL",
    "HA_TOKEN",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`[main] missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
}

const allowedUsers = { [process.env.TELEGRAM_BERNARD_ID]: "Bernard" };
if (process.env.TELEGRAM_ZANE_ID) allowedUsers[process.env.TELEGRAM_ZANE_ID] = "Zane";

const systemPromptPath = join(root, "prompts", "guardian-system-prompt.md");
const memoryDir = join(root, "memory");
const ordersPath = join(root, "standing-orders", "active.json");
// Bundle the `hass-mcp` package (same one Bernard's Claude Code uses) as a
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

// Fixed-chat sender for the listener/wake-glue path (notifications and
// wake replies always go to Bernard for now — DM model, single guardian).
const notifyBernard = makeTelegramSender({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_BERNARD_ID,
    logger: console,
});

const binPath = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const runner = new ClaudeAgentRunner({ binPath, logger: console });
await runner.start();

const ordersStore = new OrdersStore(ordersPath);

const onWake = createWakeHandler({
    runner,
    projectRoot: root,
    systemPromptPath,
    memoryDir,
    mcpServers,
    sendTelegram: notifyBernard,
    mode: "bypassPermissions",
    logger: console,
});

const listener = new HAListener({
    haUrl: process.env.HA_URL,
    haToken: process.env.HA_TOKEN,
    ordersStore,
    sendTelegram: notifyBernard,
    onWake,
    logger: console,
});

const bot = createTelegramBot({
    runner,
    projectRoot: root,
    systemPromptPath,
    memoryDir,
    mcpServers,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers,
    sendTelegram: sendTelegramTo,
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
