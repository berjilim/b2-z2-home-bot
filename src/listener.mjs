// ============================================================
// HA Listener Daemon — zero-token trigger watcher
// ============================================================
// Ported from the original BeZa's listener.mjs. Subscribes to HA's
// WebSocket `state_changed` events, evaluates armed standing orders,
// and either notifies Telegram directly (0 tokens) or hands off to
// an injected `onWake` callback (the ACP wake-glue, see step 4).
//
// Decoupled from OpenClaw on purpose: the original posted to an
// OpenClaw hooks endpoint to wake the agent. Here, waking the agent
// is the caller's problem — this module only watches and decides.

import { WebSocket } from "ws";
import { evaluateTrigger } from "./triggers.mjs";
import { triggersOf } from "./orders.mjs";

const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export class HAListener {
    #haUrl;
    #haToken;
    #ordersStore;
    #sendTelegram;   // (text) => Promise<boolean>
    #onWake;         // (order, triggerContext) => Promise<void>
    #logger;

    #ws = null;
    #msgId = 1;
    #reconnectAttempt = 0;
    #cooldowns = new Map(); // orderId -> last-trigger timestamp
    #heartbeatTimer = null;
    #recheckTimer = null;

    /**
     * @param {object} opts
     * @param {string} opts.haUrl - Home Assistant base URL (http(s)://...)
     * @param {string} opts.haToken - long-lived access token
     * @param {import("./orders.mjs").OrdersStore} opts.ordersStore
     * @param {(text: string, order?: object) => Promise<boolean>} opts.sendTelegram
     * @param {(order: object, ctx: object) => Promise<void>} opts.onWake
     * @param {{info: Function, error: Function}} [opts.logger]
     */
    constructor({ haUrl, haToken, ordersStore, sendTelegram, onWake, logger = console }) {
        this.#haUrl = haUrl;
        this.#haToken = haToken;
        this.#ordersStore = ordersStore;
        this.#sendTelegram = sendTelegram;
        this.#onWake = onWake;
        this.#logger = logger;
    }

    start() {
        this.#logger.info("[listener] starting");
        this.#connect();
        this.#startHeartbeat();
        this.#recheckTimer = setInterval(() => this.#checkPendingRechecks(), 60_000);
    }

    stop() {
        clearInterval(this.#heartbeatTimer);
        clearInterval(this.#recheckTimer);
        this.#ws?.close();
    }

    // --- HA WebSocket lifecycle ---

    #connect() {
        const wsUrl = this.#haUrl.replace(/^https/, "wss").replace(/^http(?!s)/, "ws") + "/api/websocket";
        this.#logger.info(`[ws] connecting to ${wsUrl}`);
        this.#ws = new WebSocket(wsUrl);

        this.#ws.on("open", () => {
            this.#logger.info("[ws] connected");
            this.#reconnectAttempt = 0;
        });

        this.#ws.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            if (msg.type === "auth_required") {
                this.#ws.send(JSON.stringify({ type: "auth", access_token: this.#haToken }));
            } else if (msg.type === "auth_ok") {
                this.#logger.info("[ws] authenticated — subscribing to state_changed");
                this.#ws.send(JSON.stringify({ id: this.#msgId++, type: "subscribe_events", event_type: "state_changed" }));
            } else if (msg.type === "auth_invalid") {
                this.#logger.error(`[ws] auth invalid: ${msg.message}`);
            } else if (msg.type === "event" && msg.event?.event_type === "state_changed") {
                this.#onStateChanged(msg.event);
            }
        });

        this.#ws.on("close", () => {
            const delay = RECONNECT_MS[Math.min(this.#reconnectAttempt++, RECONNECT_MS.length - 1)];
            this.#logger.info(`[ws] disconnected — reconnecting in ${delay}ms`);
            setTimeout(() => this.#connect(), delay);
        });

        this.#ws.on("error", (e) => {
            this.#logger.error(`[ws] error: ${e.message}`);
        });
    }

    #startHeartbeat() {
        this.#heartbeatTimer = setInterval(() => {
            if (this.#ws?.readyState === WebSocket.OPEN) {
                this.#ws.send(JSON.stringify({ id: this.#msgId++, type: "ping" }));
            }
        }, 30000);
    }

    // --- Scheduled recheck poller ---

    async #checkPendingRechecks() {
        let armed;
        try {
            armed = this.#ordersStore.armed();
        } catch (e) {
            this.#logger.error(`[recheck] failed to load orders: ${e.message}`);
            return;
        }

        const now = Date.now();
        for (const order of armed) {
            if (!order.pending_recheck_at) continue;
            const recheckTime = new Date(order.pending_recheck_at).getTime();
            if (isNaN(recheckTime)) {
                this.#logger.error(`[recheck] order "${order.id}" has malformed pending_recheck_at — skipping`);
                continue;
            }
            if (recheckTime > now) continue;

            // Clear before waking so a crash/restart doesn't double-fire
            try {
                this.#ordersStore.update(order.id, { pending_recheck_at: undefined });
            } catch (e) {
                this.#logger.error(`[recheck] failed to clear pending_recheck_at for "${order.id}": ${e.message}`);
                continue;
            }

            this.#logger.info(`[recheck] order "${order.id}" recheck elapsed — waking agent`);
            try {
                await this.#onWake(order, { recheck: true });
            } catch (e) {
                this.#logger.error(`[recheck] wake failed for "${order.id}": ${e.message}`);
            }
        }
    }

    // --- Trigger evaluation & dispatch ---

    /** Test seam: drive the dispatch path with a synthetic HA event, bypassing the WS. */
    handleStateChangedForTest(event) {
        return this.#onStateChanged(event);
    }

    async #onStateChanged(event) {
        const { entity_id, new_state, old_state } = event.data ?? {};
        if (!entity_id || !new_state) return;

        const newVal = new_state.state;
        const oldVal = old_state?.state;

        let armed;
        try {
            armed = this.#ordersStore.armed();
        } catch (e) {
            this.#logger.error(`[orders] failed to load: ${e.message}`);
            return;
        }

        for (const order of armed) {
            for (const trigger of triggersOf(order)) {
                if (evaluateTrigger(trigger, entity_id, newVal, oldVal)) {
                    this.#logger.info(`[match] order "${order.id}" triggered by ${entity_id}: ${oldVal} -> ${newVal}`);
                    await this.#handleTrigger(order, { entity_id, from: oldVal, to: newVal });
                    break; // one trigger per order per event is enough
                }
            }
        }
    }

    async #handleTrigger(order, triggerContext) {
        const now = Date.now();
        const cooldownMs = (order.cooldown_seconds ?? 60) * 1000;
        const last = this.#cooldowns.get(order.id);
        if (last && now - last < cooldownMs) {
            this.#logger.info(`[cooldown] order "${order.id}" skipped (cooldown active)`);
            return;
        }
        this.#cooldowns.set(order.id, now);

        if (order.action_type === "notify") {
            const text = order.notify_on_trigger ?? `Standing order triggered: ${order.description}`;
            this.#logger.info(`[notify] sending direct Telegram for order "${order.id}"`);
            const ok = await this.#sendTelegram(text, order);
            if (ok) this.#logger.info("[notify] delivered — 0 tokens used");
            return;
        }

        // action_type "wake_agent": hand off to the injected wake mechanism
        try {
            await this.#onWake(order, triggerContext);
        } catch (e) {
            this.#logger.error(`[wake] failed for order "${order.id}": ${e.message}`);
        }
    }
}
