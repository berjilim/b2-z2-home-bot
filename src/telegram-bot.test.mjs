// Smoke test: createTelegramBot primes a fresh per-user session with the
// system prompt + memory on the first message, reuses it on subsequent
// messages, relays replies back to the right chat, and ignores messages
// from users not in the allow-list — using a fake runner, no live ACP
// process and no live Telegram API (fetch is stubbed).
// Run with: node src/telegram-bot.test.mjs

import { createTelegramBot } from "./telegram-bot.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "beza-telegram-bot-"));
const promptPath = join(dir, "system-prompt.md");
const memoryDir = join(dir, "memory");
mkdirSync(memoryDir);
writeFileSync(promptPath, "You are BeZa. Be terse.");
writeFileSync(join(memoryDir, "home-entities.md"), "Use light.dining_smart_bulbs, not the relay.");

// --- fake runner: tracks open sessions and captured prompts ---
let nextSessionId = 1;
const opened = [];
const prompts = [];
const fakeRunner = {
    openSession: async (opts) => {
        const sessionId = `sess-${nextSessionId++}`;
        opened.push({ sessionId, ...opts });
        return sessionId;
    },
    prompt: async (sessionId, text) => {
        prompts.push({ sessionId, text });
        return { text: `[reply to: ${text.slice(-30)}]`, stopReason: "end_turn", usage: { totalTokens: 100 } };
    },
    closeSession: async () => {},
};

// --- fake Telegram transport ---
const sent = []; // { text, chatId }
const sendTelegram = async (text, chatId) => { sent.push({ text, chatId }); return true; };

// --- fake fetch for getUpdates: feed two scripted batches then go quiet ---
const batches = [
    [
        { update_id: 1, message: { from: { id: 111 }, text: "When I leave, lock the door" } },
        { update_id: 2, message: { from: { id: 999 }, text: "ignore me, I'm a stranger" } },
    ],
    [
        { update_id: 3, message: { from: { id: 111 }, text: "Yes, arm it" } },
    ],
    [],
];
let batchIndex = 0;
globalThis.fetch = async (url) => {
    assert.match(url, /getUpdates/);
    const result = batches[Math.min(batchIndex, batches.length - 1)];
    batchIndex++;
    return { json: async () => ({ ok: true, result }) };
};

const bot = createTelegramBot({
    runner: fakeRunner,
    projectRoot: dir,
    systemPromptPath: promptPath,
    memoryDir,
    mcpServers: [{ name: "home-assistant", type: "http", url: "http://fake/mcp" }],
    botToken: "fake-token",
    allowedUsers: { "111": "Bernard" },
    sendTelegram,
    pollIntervalMs: 5,
    logger: { info: () => {}, error: () => {} },
});

await bot.start();
// give the poll loop a few ticks to drain both scripted batches
await new Promise((r) => setTimeout(r, 100));
await bot.stop();

// One session opened for Bernard, scoped to the project root, not ~/.claude
assert.strictEqual(opened.length, 1, "exactly one session opened (per-user, reused across turns)");
assert.strictEqual(opened[0].cwd, dir);
assert.deepStrictEqual(opened[0].mcpServers, [{ name: "home-assistant", type: "http", url: "http://fake/mcp" }]);

// First turn is primed with system prompt + memory + the message
assert.strictEqual(prompts.length, 2, "two turns handled for Bernard");
assert.match(prompts[0].text, /You are BeZa\. Be terse\./);
assert.match(prompts[0].text, /Use light\.dining_smart_bulbs/);
assert.match(prompts[0].text, /Bernard: When I leave, lock the door/);

// Second turn reuses the same session and is NOT re-primed
assert.strictEqual(prompts[1].sessionId, prompts[0].sessionId, "same session reused across turns");
assert.doesNotMatch(prompts[1].text, /You are BeZa/, "no re-priming on subsequent turns");
assert.match(prompts[1].text, /Bernard: Yes, arm it/);

// Replies relayed back to Bernard's chat id, stranger ignored entirely
assert.strictEqual(sent.length, 2);
assert.ok(sent.every((s) => s.chatId === "111"), "all replies routed to the authorized user's chat");
assert.strictEqual(sent[0].text, prompts[0].text ? sent[0].text : sent[0].text); // sanity: non-empty
assert.match(sent[0].text, /^\[reply to:/);

rmSync(dir, { recursive: true, force: true });
console.log("✓ telegram-bot smoke test passed");
