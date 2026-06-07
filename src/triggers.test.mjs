import { evaluateTrigger } from "./triggers.mjs";
import assert from "node:assert";

// state_change with to/from filter
assert.strictEqual(evaluateTrigger({ entity: "x", condition: "state_change", to: "on" }, "x", "on", "off"), true);
assert.strictEqual(evaluateTrigger({ entity: "x", condition: "state_change", to: "on" }, "x", "off", "on"), false);

// numeric crossing — drops_below fires once on the falling edge, not repeatedly
assert.strictEqual(evaluateTrigger({ entity: "h", condition: "drops_below", value: 60 }, "h", "55", "65"), true);
assert.strictEqual(evaluateTrigger({ entity: "h", condition: "drops_below", value: 60 }, "h", "50", "55"), false, "no re-fire while staying below");
assert.strictEqual(evaluateTrigger({ entity: "h", condition: "rises_above", value: 60 }, "h", "65", "55"), true);

// turns_on / turns_off edge-only
assert.strictEqual(evaluateTrigger({ entity: "l", condition: "turns_on" }, "l", "on", "off"), true);
assert.strictEqual(evaluateTrigger({ entity: "l", condition: "turns_on" }, "l", "on", "on"), false, "no re-fire while staying on");

// presence
assert.strictEqual(evaluateTrigger({ entity: "p", condition: "becomes_away" }, "p", "not_home", "home"), true);
assert.strictEqual(evaluateTrigger({ entity: "p", condition: "becomes_home" }, "p", "home", "not_home"), true);

// wrong entity never matches
assert.strictEqual(evaluateTrigger({ entity: "a", condition: "turns_on" }, "b", "on", "off"), false);

console.log("✓ trigger evaluation smoke test passed");
