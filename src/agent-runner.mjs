// ============================================================
// ClaudeAgentRunner — drives @agentclientprotocol/claude-agent-acp
// ============================================================
// Owns the spawned ACP subprocess and the JSON-RPC/NDJSON plumbing.
// Exposes a single high-level operation, `runTurn`, that creates a
// fresh session, sets its mode, sends one prompt, and resolves with
// the agent's final assistant text — matching BeZa's "wake, do one
// scoped thing, sleep again" usage pattern (no persistent conversation
// state needed between wakes).
//
// Auto-handles `session/request_permission` by approving in modes that
// don't need a human in the loop (`dontAsk`, `acceptEdits`) and rejecting
// in `plan` — there is no Telegram round trip during a trigger-driven wake.
// Note: `bypassPermissions` is blocked by the ACP package when running as
// root (which HA add-ons do), so wake turns use `dontAsk` instead.

import { spawn } from "node:child_process";

export class ClaudeAgentRunner {
    #binPath;
    #env;
    #logger;

    #process = null;
    #buffer = "";
    #nextId = 1;
    #pending = new Map();

    constructor({ binPath, env = process.env, logger = console }) {
        this.#binPath = binPath;
        this.#env = env;
        this.#logger = logger;
    }

    async start() {
        if (this.#process) return;
        this.#process = spawn(process.execPath, [this.#binPath], {
            stdio: ["pipe", "pipe", "pipe"],
            env: this.#env,
        });
        this.#process.stdin.on("error", () => {});
        this.#process.stdout.on("data", (chunk) => this.#onData(chunk));
        this.#process.stderr.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text) this.#logger.error(`[acp:stderr] ${text}`);
        });
        this.#process.on("exit", (code, signal) => {
            this.#logger.info(`[acp] process exited code=${code} signal=${signal}`);
            this.#rejectAll(new Error(`ACP process exited: code=${code} signal=${signal}`));
            this.#process = null;
        });

        const init = await this.#send("initialize", {
            protocolVersion: 1,
            clientCapabilities: { elicitation: { form: {} } },
        });
        this.#logger.info(`[acp] initialized: ${init.agentInfo?.name} v${init.agentInfo?.version}`);
        return init;
    }

    async stop() {
        if (!this.#process) return;
        this.#process.kill();
        this.#process = null;
    }

    get alive() {
        return !!this.#process;
    }

    /**
     * Open a new session, scoped to `cwd` (project-scoped — NOT the operator's
     * ~/.claude) with the given mode and MCP servers. Returns the sessionId;
     * the caller is responsible for closing it via `closeSession`.
     *
     * @param {object} opts
     * @param {string} opts.cwd
     * @param {string} [opts.mode] - "default" | "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "auto"
     * @param {Array}  [opts.mcpServers] - MCP server configs in ACP session/new format
     * @returns {Promise<string>} sessionId
     */
    async openSession({ cwd, mode = "default", mcpServers = [] }) {
        const session = await this.#send("session/new", { cwd, mcpServers });
        const sessionId = session.sessionId;
        if (mode !== (session.modes?.currentModeId ?? "default")) {
            await this.#send("session/set_mode", { sessionId, modeId: mode });
        }
        return sessionId;
    }

    /**
     * Send one prompt on an existing (possibly already-used) session and
     * resolve with the agent's full final assistant text for that turn.
     *
     * @returns {Promise<{ text: string, stopReason: string, usage: object }>}
     */
    async prompt(sessionId, text) {
        let reply = "";
        const onUpdate = (params) => {
            if (params.sessionId !== sessionId) return;
            const update = params.update;
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                reply += update.content.text;
            }
        };

        this.#notificationHandlers.add(onUpdate);
        try {
            const result = await this.#send("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text }],
            }, 10 * 60 * 1000);
            return { text: reply, stopReason: result.stopReason, usage: result.usage };
        } finally {
            this.#notificationHandlers.delete(onUpdate);
        }
    }

    async closeSession(sessionId) {
        await this.#send("session/cancel", { sessionId }).catch(() => {});
    }

    /**
     * Run one scoped turn in a brand-new session, then let the session end.
     * Convenience wrapper for the wake path — fresh session per call,
     * matches BeZa's "wake, do one scoped thing, sleep again" pattern.
     *
     * @param {object} opts
     * @param {string} opts.cwd - working directory for the session (project-scoped, NOT ~/.claude)
     * @param {string} [opts.mode]
     * @param {Array}  [opts.mcpServers]
     * @param {string} opts.prompt - the full prompt text (system context + trigger context, etc.)
     * @returns {Promise<{ text: string, stopReason: string, usage: object, sessionId: string }>}
     */
    async runTurn({ cwd, mode = "default", mcpServers = [], prompt }) {
        const sessionId = await this.openSession({ cwd, mode, mcpServers });
        try {
            const result = await this.prompt(sessionId, prompt);
            return { ...result, sessionId };
        } finally {
            await this.closeSession(sessionId);
        }
    }

    // --- JSON-RPC plumbing ---

    #notificationHandlers = new Set();

    #send(method, params, timeoutMs = 60_000) {
        const id = this.#nextId++;
        const msg = { jsonrpc: "2.0", id, method, params };
        this.#process.stdin.write(JSON.stringify(msg) + "\n");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.#pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        });
    }

    #respond(id, result) {
        this.#process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    }

    #onData(chunk) {
        this.#buffer += chunk.toString();
        let idx;
        while ((idx = this.#buffer.indexOf("\n")) >= 0) {
            const line = this.#buffer.slice(0, idx).trim();
            this.#buffer = this.#buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            this.#handleMessage(msg);
        }
    }

    #handleMessage(msg) {
        // Response to one of our requests
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.#pending.has(msg.id)) {
            const { resolve, reject } = this.#pending.get(msg.id);
            this.#pending.delete(msg.id);
            if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? {})})`));
            else resolve(msg.result);
            return;
        }

        // Server -> client requests that need a response
        if (msg.id !== undefined && msg.method) {
            if (msg.method === "session/request_permission") {
                return this.#autoRespondPermission(msg);
            }
            if (msg.method === "elicitation/create" || msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
                // Not expected during unattended wakes (no human, no editor-style fs proxy needed —
                // the agent's own filesystem tools handle file I/O against `cwd`). Reject cleanly.
                this.#process.stdin.write(JSON.stringify({
                    jsonrpc: "2.0", id: msg.id,
                    error: { code: -32601, message: "Not supported in unattended wake mode" },
                }) + "\n");
                return;
            }
            return; // unknown server request — ignore
        }

        // Notifications (session/update, etc.)
        if (msg.method === "session/update") {
            for (const handler of this.#notificationHandlers) handler(msg.params);
            return;
        }
        if (msg.method) {
            this.#logger.info(`[acp] notification: ${msg.method}`);
        }
    }

    #autoRespondPermission(msg) {
        const options = msg.params?.options ?? [];
        const approve = options.find((o) => o.kind === "allow_always" || o.kind === "allow_once") ?? options[0];
        if (approve) {
            this.#logger.info(`[acp] auto-approving permission request: ${approve.optionId ?? approve.kind}`);
            this.#respond(msg.id, { outcome: { outcome: "selected", optionId: approve.optionId } });
        } else {
            this.#respond(msg.id, { outcome: { outcome: "cancelled" } });
        }
    }

    #rejectAll(err) {
        for (const { reject } of this.#pending.values()) reject(err);
        this.#pending.clear();
    }
}
