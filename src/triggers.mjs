// ============================================================
// Pure trigger-evaluation logic — extracted for testability
// ============================================================
// Given a trigger definition and an entity's old/new state, decide
// whether it fires. No I/O, no HA connection — just the rules from
// standing-orders/SCHEMA.md.

export function evaluateTrigger(trigger, entityId, newState, oldState) {
    if (trigger.entity !== entityId) return false;

    switch (trigger.condition) {
        case "state_change":
            if (trigger.to && newState !== trigger.to) return false;
            if (trigger.from && oldState !== trigger.from) return false;
            return true;

        case "above":
        case "rises_above": {
            const val = parseFloat(newState);
            const prev = parseFloat(oldState);
            return !isNaN(val) && val > trigger.value && (isNaN(prev) || prev <= trigger.value);
        }
        case "below":
        case "drops_below": {
            const val = parseFloat(newState);
            const prev = parseFloat(oldState);
            return !isNaN(val) && val < trigger.value && (isNaN(prev) || prev >= trigger.value);
        }
        case "turns_on":
            return newState === "on" && oldState !== "on";
        case "turns_off":
            return newState === "off" && oldState !== "off";
        case "becomes_home":
            return newState === "home" && oldState !== "home";
        case "becomes_away":
            return newState !== "home" && oldState === "home";
        default:
            return false;
    }
}
