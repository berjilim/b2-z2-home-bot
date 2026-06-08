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

// Placeholder + edit-in-place ("thinking..." -> real reply): track both legs
const placeholders = []; // { chatId, text }
const edits = []; // { chatId, messageId, text }
let nextMessageId = 1;
const sendPlaceholder = async (chatId, text) => {
    placeholders.push({ chatId, text });
    return nextMessageId++;
};
const editReply = async (chatId, messageId, text) => {
    edits.push({ chatId, messageId, text });
    return true;
};

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
    sendPlaceholder,
    editReply,
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

// Replies use the placeholder -> edit-in-place flow, not a fresh send each
// time: a "thinking..." placeholder fires immediately, then gets swapped for
// the real reply once the turn resolves — both legs routed to Bernard's chat,
// stranger ignored entirely (no placeholder/reply for them at all).
assert.strictEqual(placeholders.length, 2, "one placeholder per turn");
assert.ok(placeholders.every((p) => p.chatId === "111" && /Thinking/.test(p.text)));
assert.strictEqual(edits.length, 2, "each placeholder gets edited in place with the real reply");
assert.ok(edits.every((e) => e.chatId === "111"));
assert.deepStrictEqual(edits.map((e) => e.messageId), placeholders.map((_, i) => i + 1), "edits target the placeholder message ids returned by sendPlaceholder");
assert.match(edits[0].text, /^\[reply to:/);
assert.strictEqual(sent.length, 0, "plain sendTelegram is bypassed in favor of placeholder+edit when both are wired up");

// --- idle-timeout recycling: a session sitting idle past idleTimeoutMs gets
// closed and replaced with a fresh (re-primed) one on the next message ---
const closed = [];
const recyclingRunner = {
    ...fakeRunner,
    closeSession: async (sessionId) => { closed.push(sessionId); },
};
const recyclingOpened = [];
recyclingRunner.openSession = async (opts) => {
    const sessionId = `recycle-sess-${nextSessionId++}`;
    recyclingOpened.push({ sessionId, ...opts });
    return sessionId;
};
const recyclingPrompts = [];
recyclingRunner.prompt = async (sessionId, text) => {
    recyclingPrompts.push({ sessionId, text });
    return { text: "[reply]", stopReason: "end_turn", usage: { totalTokens: 10 } };
};

// Time-gated (not batch-index-gated) so the gap between the two messages is
// real wall-clock time greater than idleTimeoutMs — that's what we're testing.
const start = Date.now();
let firstSent = false;
let secondSent = false;
globalThis.fetch = async (url) => {
    assert.match(url, /getUpdates/);
    const elapsed = Date.now() - start;
    let result = [];
    if (!firstSent) {
        firstSent = true;
        result = [{ update_id: 10, message: { from: { id: 111 }, text: "first message" } }];
    } else if (!secondSent && elapsed > 50) { // well past idleTimeoutMs of 20ms
        secondSent = true;
        result = [{ update_id: 11, message: { from: { id: 111 }, text: "second message, after idling" } }];
    }
    return { json: async () => ({ ok: true, result }) };
};

const recyclingBot = createTelegramBot({
    runner: recyclingRunner,
    projectRoot: dir,
    systemPromptPath: promptPath,
    memoryDir,
    mcpServers: [],
    botToken: "fake-token",
    allowedUsers: { "111": "Bernard" },
    sendTelegram: async () => true,
    pollIntervalMs: 5,
    idleTimeoutMs: 20, // tiny — second message arrives well past this
    logger: { info: () => {}, error: () => {} },
});

await recyclingBot.start();
await new Promise((r) => setTimeout(r, 200)); // covers: first message, idle gap (>50ms), second message + recycle
await recyclingBot.stop();

assert.strictEqual(recyclingOpened.length, 2, "idle session recycled — second message opens a fresh one");
// closeSession fires twice: once for the idle recycle, once for bot.stop()'s cleanup
assert.strictEqual(closed.length, 2);
assert.ok(closed.includes(recyclingOpened[0].sessionId), "the stale session was explicitly closed on recycle (not just at shutdown)");
assert.notStrictEqual(recyclingPrompts[1].sessionId, recyclingPrompts[0].sessionId, "second turn runs on the fresh session");
assert.match(recyclingPrompts[1].text, /You are BeZa\. Be terse\./, "fresh session is re-primed with the system prompt");

rmSync(dir, { recursive: true, force: true });
console.log("✓ telegram-bot smoke test passed");
