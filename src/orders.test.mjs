// Quick smoke test for the orders engine — run with: node src/orders.test.mjs
import { OrdersStore, triggersOf } from "./orders.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const dir = mkdtempSync(join(tmpdir(), "beza-orders-"));
const path = join(dir, "active.json");
const store = new OrdersStore(path);

assert.deepStrictEqual(store.load(), [], "starts empty");

const order = {
    id: "dry-toilet-after-shower",
    description: "When I'm done showering, dry the toilet",
    plan: "Watch master bathroom humidity; when it drops back to baseline, run the exhaust fan for 10 minutes",
    trigger: { entity: "sensor.master_bathroom_humidity", condition: "drops_below", value: 60 },
    action_type: "wake_agent",
    cooldown_seconds: 300,
    notify_on_trigger: "Looks like you're done showering — drying the toilet now",
    notify_on_complete: "Toilet's dry. All set.",
    status: "armed",
};

store.add(order);
assert.strictEqual(store.armed().length, 1, "one armed order");
assert.deepStrictEqual(triggersOf(order), [order.trigger], "single trigger normalizes to array");

const updated = store.update(order.id, { status: "complete" });
assert.strictEqual(updated.status, "complete");
assert.strictEqual(store.armed().length, 0, "no longer armed after completion");

assert.throws(() => store.add({ id: "bad", description: "x", plan: "y", action_type: "notify", status: "armed" }),
    /no trigger/, "rejects order with no trigger");

assert.throws(() => store.add({ ...order, id: order.id }), /already exists/, "rejects duplicate id");

rmSync(dir, { recursive: true, force: true });
console.log("✓ orders engine smoke test passed");
