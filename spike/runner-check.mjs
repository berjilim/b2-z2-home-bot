// Live check: drive ClaudeAgentRunner.runTurn against the real ACP binary
// with a trivial, tool-free prompt — confirms the higher-level runner
// (built on top of the spike's raw plumbing) works end to end.
// Run with: node spike/runner-check.mjs

import { ClaudeAgentRunner } from "../src/agent-runner.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const envPath = join(root, ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) process.env[m[1]] = m[2].trim();
    }
}
delete process.env.ANTHROPIC_API_KEY;

const binPath = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
const runner = new ClaudeAgentRunner({ binPath, logger: console });

await runner.start();
const result = await runner.runTurn({
    cwd: root,
    mode: "bypassPermissions",
    mcpServers: [],
    prompt: "Reply with exactly: runner check OK. Do not use any tools.",
});
console.log("\n=== runTurn result ===");
console.log(JSON.stringify(result, null, 2));

await runner.stop();
process.exit(0);
