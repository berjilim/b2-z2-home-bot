// Live check: run createTelegramBot end-to-end against the real Bot API
// and a real ClaudeAgentRunner (no HA MCP wiring yet — that's the
// entrypoint's job). Confirms the conversational loop actually works:
// send the bot a Telegram DM, watch it reply.
// Run with: node spike/telegram-bot-check.mjs
// Stop with Ctrl+C.

import { ClaudeAgentRunner } from "../src/agent-runner.mjs";
import { createTelegramBot } from "../src/telegram-bot.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const envPath = join(root, ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) process.env[m[1]] = m[2].trim();
    }
}
delete process.env.ANTHROPIC_API_KEY;

const binPath = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const runner = new ClaudeAgentRunner({ binPath, logger: console });
await runner.start();

// telegram-bot needs to send to whichever chat sent the message —
// telegram.mjs's sender is bound to a fixed chatId, so send raw here.
async function sendTelegram(text, chatId) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[telegram] send failed: ${data.description}`);
    return data.ok;
}

const bot = createTelegramBot({
    runner,
    projectRoot: root,
    systemPromptPath: join(root, "prompts", "guardian-system-prompt.md"),
    memoryDir: join(root, "memory"),
    mcpServers: [], // no HA tools in this check — pure conversation-loop smoke test
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers: { [process.env.TELEGRAM_BERNARD_ID]: "Bernard" },
    sendTelegram,
    mode: "default",
    logger: console,
});

console.log(`\n=== telegram-bot live check ===`);
console.log(`Message your BZ-V2 bot on Telegram now (DM it anything).`);
console.log(`Watching for replies from user id ${process.env.TELEGRAM_BERNARD_ID}... (Ctrl+C to stop)\n`);

await bot.start();

process.on("SIGINT", async () => {
    console.log("\nstopping...");
    await bot.stop();
    await runner.stop();
    process.exit(0);
});
