// Smoke test: createWakeHandler assembles a prompt (system + memory +
// trigger) and relays the agent's final reply to Telegram as the single
// notification — using a fake runner, no live ACP process.
// Run with: node src/wake-glue.test.mjs

import { createWakeHandler } from "./wake-glue.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "beza-wake-"));
const promptsDir = join(dir, "prompts");
const memoryDir = join(dir, "memory");
mkdirSync(promptsDir);
mkdirSync(memoryDir);
writeFileSync(join(promptsDir, "system-core.md"), "You are BeZa. Be terse.");
writeFileSync(join(memoryDir, "home-entities.md"), "Use light.dining_smart_bulbs, not the relay.");

const order = {
    id: "dry-toilet",
    description: "Dry the toilet after shower",
    plan: "Run exhaust fan 10 minutes when humidity drops",
};
const ctx = { entity_id: "sensor.bathroom_humidity", from: "65", to: "55" };

let capturedPrompt = null;
const fakeRunner = {
    runTurn: async ({ prompt, mode, mcpServers, cwd }) => {
        capturedPrompt = { prompt, mode, mcpServers, cwd };
        return { text: "Done — ran the exhaust fan for 10 minutes. Toilet should be dry now.", stopReason: "end_turn", usage: { totalTokens: 500 } };
    },
};

const sent = [];
const onWake = createWakeHandler({
    runner: fakeRunner,
    projectRoot: dir,
    promptsDir,
    memoryDir,
    mcpServers: [{ name: "home-assistant", type: "http", url: "http://fake/mcp" }],
    sendTelegram: async (text) => { sent.push(text); return true; },
    logger: { info: () => {}, error: () => {} },
});

await onWake(order, ctx);

// Prompt assembly: system prompt + memory + trigger context all present
assert.match(capturedPrompt.prompt, /You are BeZa\. Be terse\./);
assert.match(capturedPrompt.prompt, /Use light\.dining_smart_bulbs/);
assert.match(capturedPrompt.prompt, /BEZA TRIGGER FIRED/);
assert.match(capturedPrompt.prompt, /order_id: dry-toilet/);
assert.match(capturedPrompt.prompt, /"to":"55"/);
assert.strictEqual(capturedPrompt.cwd, dir, "session runs scoped to project root, not operator's ~/.claude");
assert.strictEqual(capturedPrompt.mode, "dontAsk", "default unattended mode");

// The agent's final reply IS the one notification — relayed verbatim
assert.deepStrictEqual(sent, ["Done — ran the exhaust fan for 10 minutes. Toilet should be dry now."]);

// Empty reply -> fallback notification, not silence
const silentRunner = { runTurn: async () => ({ text: "   ", stopReason: "end_turn", usage: {} }) };
const sent2 = [];
const onWake2 = createWakeHandler({
    runner: silentRunner, projectRoot: dir, promptsDir, memoryDir, mcpServers: [],
    sendTelegram: async (text) => { sent2.push(text); return true; },
    logger: { info: () => {}, error: () => {} },
});
await onWake2(order, ctx);
assert.strictEqual(sent2.length, 1, "fallback notification sent on empty reply");
assert.match(sent2[0], /didn't get a clear result/);

rmSync(dir, { recursive: true, force: true });
console.log("✓ wake-glue smoke test passed");
