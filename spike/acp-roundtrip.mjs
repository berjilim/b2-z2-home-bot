// Spike: spawn @agentclientprotocol/claude-agent-acp over stdio and drive it
// through initialize -> authenticate -> session/new -> session/prompt.
// Goal: confirm the round-trip works and capture real authMethods / mode IDs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load .env manually (no need for dotenv dependency for one var)
const envPath = join(root, ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) process.env[m[1]] = m[2].trim();
    }
}

const binPath = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");

console.log(`[spike] spawning: node ${binPath}`);
const child = spawn(process.execPath, [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
});

let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { console.log(`[stdout:raw] ${line}`); continue; }
        handleMessage(msg);
    }
});

child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[stderr] ${text}`);
});

child.on("exit", (code, signal) => {
    console.log(`[spike] process exited code=${code} signal=${signal}`);
    process.exit(code ?? 0);
});

function send(method, params, id = nextId++) {
    const msg = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(JSON.stringify(msg) + "\n");
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
    });
}

function handleMessage(msg) {
    console.log(`[recv] ${JSON.stringify(msg).slice(0, 500)}`);
    if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
    }
    // Server -> client requests (permission, elicitation) need a response too —
    // for this spike we just log them, no response (will likely time out agent-side).
}

(async () => {
    try {
        console.log("\n=== 1. initialize ===");
        const initResult = await send("initialize", {
            protocolVersion: 1,
            clientCapabilities: { elicitation: { form: {} } },
        });
        console.log("authMethods:", JSON.stringify(initResult.authMethods, null, 2));
        console.log("agentInfo:", JSON.stringify(initResult.agentInfo, null, 2));

        console.log("\n=== 2. authenticate ===");
        if (initResult.authMethods?.length) {
            try {
                const authResult = await send("authenticate", { methodId: initResult.authMethods[0].id });
                console.log("auth result:", JSON.stringify(authResult));
            } catch (err) {
                console.log("auth error (may be OK if already authed via env):", err.message);
            }
        } else {
            console.log("no authMethods returned — assuming env-based auth");
        }

        console.log("\n=== 3. session/new ===");
        const sessionResult = await send("session/new", {
            cwd: root,
            mcpServers: [],
        });
        console.log("session:", JSON.stringify(sessionResult, null, 2));
        const sessionId = sessionResult.sessionId;

        console.log("\n=== 4. session/prompt ===");
        const promptResult = await send("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly: ACP round-trip OK" }],
        });
        console.log("prompt result:", JSON.stringify(promptResult, null, 2));

        console.log("\n[spike] DONE — round trip succeeded");
    } catch (err) {
        console.error("[spike] FAILED:", err);
    } finally {
        setTimeout(() => child.kill(), 500);
    }
})();
