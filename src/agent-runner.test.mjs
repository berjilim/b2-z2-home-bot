// Smoke test: ClaudeAgentRunner serializes the heavy part of prompt() (the
// session/prompt JSON-RPC call, which is what spawns the underlying agent
// subprocess) across concurrent callers, FIFO, so wake-glue and
// telegram-bot can never drive two heavy subprocesses at once — this is
// the fix for the OOM-killer SIGKILLs on memory-constrained hardware.
// Stubs out #send via a fake #process-free approach: we subclass-free stub
// by monkey-patching the private JSON-RPC plumbing isn't possible (private
// fields), so instead we drive `prompt()` directly and stub the underlying
// `#send` call indirectly by faking `this.#process` is unnecessary — we
// only need to observe ordering/timing of `session/prompt` calls, which we
// do by overriding `#send` isn't accessible either. Instead we fake a
// minimal ACP child process whose stdout responds to `session/prompt`
// requests after a controllable delay, the same approach a real subprocess
// integration would need, mirroring the JSON-RPC line-protocol contract
// `#onData`/`#handleMessage` expect.
// Run with: node src/agent-runner.test.mjs

import { ClaudeAgentRunner } from "./agent-runner.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert";

// Minimal fake child process: captures writes to stdin, and lets the test
// control exactly when each JSON-RPC response is flushed back on stdout.
function makeFakeProcess() {
    const proc = new EventEmitter();
    proc.stdin = { write: () => {}, on: () => {} };
    const stdout = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    proc.writes = [];
    const realWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk) => {
        proc.writes.push(chunk);
        const msg = JSON.parse(chunk);
        // Defer to the next tick — mirrors a real subprocess, where the
        // write to stdin is always async relative to `#send()` registering
        // its pending-request entry. A synchronous call here would let a
        // synchronous `onMessage` handler "respond" before `#send` has even
        // stored the resolve/reject callbacks, which can't happen for a
        // real OS pipe.
        queueMicrotask(() => proc.onMessage?.(msg));
        return true;
    };
    proc.respond = (id, result) => {
        stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"));
    };
    return proc;
}

function makeRunner() {
    const runner = new ClaudeAgentRunner({ binPath: "/dev/null", logger: { info: () => {}, error: () => {} } });
    const proc = makeFakeProcess();
    // Reach into the runner to install our fake process the same way
    // `start()` would, without going through `spawn()`.
    runner._installFakeProcessForTest(proc);
    return { runner, proc };
}

// agent-runner.mjs doesn't expose a test seam by default — add one minimal
// hook so this test can inject the fake process without touching private
// fields from outside. (See patch applied below in agent-runner.mjs.)

const { runner, proc } = makeRunner();

// Track session/prompt call ordering: record when each session/prompt
// request is SENT (i.e. the heavy work actually started).
const promptStarts = [];
const pendingPromptIds = new Map(); // id -> sessionId, for session/prompt requests only

proc.onMessage = (msg) => {
    if (msg.method === "session/new") {
        proc.respond(msg.id, { sessionId: `sess-${msg.id}`, modes: { currentModeId: "default" } });
        return;
    }
    if (msg.method === "session/prompt") {
        promptStarts.push(msg.params.sessionId);
        pendingPromptIds.set(msg.id, msg.params.sessionId);
        // Do NOT respond yet — the test controls completion timing below.
        return;
    }
    if (msg.method === "session/cancel") {
        proc.respond(msg.id, {});
        return;
    }
};

const sessionA = await runner.openSession({ cwd: "/tmp" });
const sessionB = await runner.openSession({ cwd: "/tmp" });

// Fire two concurrent prompt() calls on different sessions.
const promptAPromise = runner.prompt(sessionA, "do thing A");
const promptBPromise = runner.prompt(sessionB, "do thing B");

// Give the event loop a tick — only A's session/prompt should have been sent.
await new Promise((r) => setTimeout(r, 20));
assert.deepStrictEqual(promptStarts, [sessionA], "B's heavy work must not start while A is in flight");

// Resolve A's session/prompt now.
const idForA = [...pendingPromptIds.entries()].find(([, sid]) => sid === sessionA)[0];
proc.respond(idForA, { stopReason: "end_turn", usage: { totalTokens: 10 } });
const resultA = await promptAPromise;
assert.strictEqual(resultA.stopReason, "end_turn");

// Now B's session/prompt should have been sent (queue advanced).
await new Promise((r) => setTimeout(r, 20));
assert.deepStrictEqual(promptStarts, [sessionA, sessionB], "B's heavy work starts only after A resolves");

const idForB = [...pendingPromptIds.entries()].find(([, sid]) => sid === sessionB)[0];
proc.respond(idForB, { stopReason: "end_turn", usage: { totalTokens: 5 } });
const resultB = await promptBPromise;
assert.strictEqual(resultB.stopReason, "end_turn");

console.log("✓ concurrent prompt() calls are serialized FIFO through the queue");

// --- Part 2: a rejected turn must not poison the queue for the next turn ---

const { runner: runner2, proc: proc2 } = makeRunner();
const ids2 = new Map();
proc2.onMessage = (msg) => {
    if (msg.method === "session/new") {
        proc2.respond(msg.id, { sessionId: `sess-${msg.id}`, modes: { currentModeId: "default" } });
        return;
    }
    if (msg.method === "session/prompt") {
        ids2.set(msg.params.sessionId, msg.id);
        return;
    }
};

const sA = await runner2.openSession({ cwd: "/tmp" });
const sB = await runner2.openSession({ cwd: "/tmp" });

const failingPrompt = runner2.prompt(sA, "this will fail");
const followingPrompt = runner2.prompt(sB, "this should still run");

await new Promise((r) => setTimeout(r, 20));
// Reject turn A's session/prompt via a JSON-RPC error response.
proc2.stdout.emit("data", Buffer.from(JSON.stringify({
    jsonrpc: "2.0", id: ids2.get(sA), error: { message: "boom" },
}) + "\n"));

await assert.rejects(failingPrompt, /boom/, "first queued turn rejects as expected");

// The second turn must still run normally afterward.
await new Promise((r) => setTimeout(r, 20));
assert.ok(ids2.has(sB), "second queued turn's session/prompt was sent after the first turn's rejection");
proc2.respond(ids2.get(sB), { stopReason: "end_turn", usage: { totalTokens: 1 } });
const resultB2 = await followingPrompt;
assert.strictEqual(resultB2.stopReason, "end_turn", "second queued turn resolves normally despite the first one's rejection");

console.log("✓ a rejected turn does not poison the queue for subsequent turns");
