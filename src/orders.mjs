// ============================================================
// Standing-orders engine — load/validate/save active.json
// ============================================================
// Pure data-layer module. No ACP, no Telegram, no HA — just the
// schema contract from standing-orders/SCHEMA.md, shared by the
// listener daemon (step 3) and the wake-glue (step 4).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const VALID_CONDITIONS = new Set([
    "state_change", "turns_on", "turns_off",
    "above", "rises_above", "below", "drops_below",
    "becomes_home", "becomes_away",
]);

const VALID_ACTION_TYPES = new Set(["notify", "wake_agent"]);
const VALID_STATUSES = new Set(["armed", "triggered", "complete", "expired", "cancelled"]);

export class OrdersStore {
    #path;

    constructor(path) {
        this.#path = path;
        if (!existsSync(path)) {
            writeFileSync(path, "[]\n", "utf-8");
        }
    }

    /** Read the full order list from disk. */
    load() {
        const raw = readFileSync(this.#path, "utf-8");
        const orders = JSON.parse(raw);
        if (!Array.isArray(orders)) {
            throw new Error(`${this.#path} must contain a JSON array`);
        }
        return orders;
    }

    /** Write the full order list back to disk. */
    save(orders) {
        for (const order of orders) this.#assertValid(order);
        writeFileSync(this.#path, JSON.stringify(orders, null, 2) + "\n", "utf-8");
    }

    /** Orders currently being watched by the listener. */
    armed() {
        return this.load().filter((o) => o.status === "armed");
    }

    /** Look up a single order by id. */
    find(id) {
        return this.load().find((o) => o.id === id);
    }

    /** Append a new order (must already be a complete, valid object). */
    add(order) {
        this.#assertValid(order);
        const orders = this.load();
        if (orders.some((o) => o.id === order.id)) {
            throw new Error(`Order id "${order.id}" already exists`);
        }
        orders.push(order);
        this.save(orders);
        return order;
    }

    /** Update an existing order by id via a patch object; returns the updated order. */
    update(id, patch) {
        const orders = this.load();
        const idx = orders.findIndex((o) => o.id === id);
        if (idx === -1) throw new Error(`No order with id "${id}"`);
        const updated = { ...orders[idx], ...patch };
        this.#assertValid(updated);
        orders[idx] = updated;
        this.save(orders);
        return updated;
    }

    #assertValid(order) {
        if (!order.id || typeof order.id !== "string") {
            throw new Error("Order missing string id");
        }
        if (!order.description || !order.plan) {
            throw new Error(`Order "${order.id}" missing description or plan`);
        }
        const triggers = order.triggers ?? (order.trigger ? [order.trigger] : []);
        if (triggers.length === 0) {
            throw new Error(`Order "${order.id}" has no trigger(s)`);
        }
        for (const t of triggers) {
            if (!t.entity || !VALID_CONDITIONS.has(t.condition)) {
                throw new Error(`Order "${order.id}" has an invalid trigger: ${JSON.stringify(t)}`);
            }
        }
        if (!VALID_ACTION_TYPES.has(order.action_type)) {
            throw new Error(`Order "${order.id}" has invalid action_type "${order.action_type}"`);
        }
        if (!VALID_STATUSES.has(order.status)) {
            throw new Error(`Order "${order.id}" has invalid status "${order.status}"`);
        }
    }
}

/** Normalize an order's trigger(s) into a flat array, regardless of single/plural form. */
export function triggersOf(order) {
    return order.triggers ?? (order.trigger ? [order.trigger] : []);
}
