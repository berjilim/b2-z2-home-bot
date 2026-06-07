// Smoke test: drive HAListener's dispatch path with synthetic HA events
// (via the handleStateChangedForTest seam), confirming notify vs wake_agent
// routing and cooldown behavior — no live HA connection needed.
// Run with: node src/listener.test.mjs

import { HAListener } from "./listener.mjs";
import { OrdersStore } from "./orders.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "beza-listener-"));
const store = new OrdersStore(join(dir, "active.json"));

store.add({
    id: "notify-order",
    description: "Tell me when the front door opens",
    plan: "Watch binary_sensor.front_door; notify on open",
    trigger: { entity: "binary_sensor.front_door", condition: "turns_on" },
    action_type: "notify",
    cooldown_seconds: 60,
    notify_on_trigger: "Front door just opened",
    status: "armed",
});

store.add({
    id: "wake-order",
    description: "Dry the toilet after shower",
    plan: "Watch humidity, run fan when it drops",
    trigger: { entity: "sensor.bathroom_humidity", condition: "drops_below", value: 60 },
    action_type: "wake_agent",
    cooldown_seconds: 60,
    status: "armed",
});

const notified = [];
const woken = [];

const listener = new HAListener({
    haUrl: "http://fake.local:8123",
    haToken: "fake-token",
    ordersStore: store,
    sendTelegram: async (text) => { notified.push(text); return true; },
    onWake: async (order, ctx) => { woken.push({ order: order.id, ctx }); },
    logger: { info: () => {}, error: (m) => console.error(m) },
});

const doorOpens = {
    event_type: "state_changed",
    data: { entity_id: "binary_sensor.front_door", new_state: { state: "on" }, old_state: { state: "off" } },
};
const humidityDrops = {
    event_type: "state_changed",
    data: { entity_id: "sensor.bathroom_humidity", new_state: { state: "55" }, old_state: { state: "65" } },
};

await listener.handleStateChangedForTest(doorOpens);
await listener.handleStateChangedForTest(humidityDrops);

assert.deepStrictEqual(notified, ["Front door just opened"], "notify path fired with the configured message — 0 tokens");
assert.strictEqual(woken.length, 1, "wake path fired exactly once");
assert.strictEqual(woken[0].order, "wake-order");
assert.deepStrictEqual(woken[0].ctx, { entity_id: "sensor.bathroom_humidity", from: "65", to: "55" });

// Cooldown: re-fire the same notify trigger immediately — should be suppressed
await listener.handleStateChangedForTest(doorOpens);
assert.strictEqual(notified.length, 1, "cooldown suppressed the immediate re-fire");

// Unrelated entity change — nothing fires
await listener.handleStateChangedForTest({
    event_type: "state_changed",
    data: { entity_id: "sensor.unrelated", new_state: { state: "42" }, old_state: { state: "41" } },
});
assert.strictEqual(notified.length, 1, "unrelated entity changes are ignored");
assert.strictEqual(woken.length, 1, "unrelated entity changes are ignored");

rmSync(dir, { recursive: true, force: true });
console.log("✓ listener dispatch smoke test passed");
