// ============================================================
// Wake-glue — connects HAListener's onWake to a fresh ACP turn
// ============================================================
// This is the piece that doesn't exist in OpenClaw or in Sam's bot in
// this exact form: listener fires -> assemble context (system prompt +
// memory files + the fired order + trigger details) -> run one scoped
// ACP turn unattended -> relay the agent's final reply to Telegram as
// the single consolidated notification -> done. No persistent session.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "./prompts.mjs";

/**
 * @param {object} opts
 * @param {import("./agent-runner.mjs").ClaudeAgentRunner} opts.runner
 * @param {string} opts.projectRoot - cwd for the ACP session (NOT the operator's ~/.claude)
 * @param {string} opts.promptsDir - dir containing persona.md, system-core.md, custom-rules.md
 * @param {string} opts.memoryDir
 * @param {Array}  opts.mcpServers - MCP server configs (e.g. Home Assistant) in ACP session/new format
 * @param {(text: string, order?: object) => Promise<boolean>} opts.sendTelegram
 * @param {(order: object) => {displayName: string, userId: string}|null} [opts.getRecipient]
 * @param {string} [opts.mode] - unattended session mode; default "dontAsk"
 * @param {{info: Function, error: Function}} [opts.logger]
 * @returns {(order: object, triggerContext: object) => Promise<void>} onWake handler for HAListener
 */
export function createWakeHandler({
    runner,
    projectRoot,
    promptsDir,
    memoryDir,
    mcpServers,
    sendTelegram,
    getRecipient,
    mode = "dontAsk",
    logger = console,
}) {
    return async function onWake(order, triggerContext) {
        const recipient = getRecipient ? getRecipient(order) : null;
        const prompt = buildWakePrompt({ promptsDir, memoryDir, order, triggerContext, recipient });

        logger.info(`[wake] running scoped turn for order "${order.id}"`);
        const result = await runner.runTurn({ cwd: projectRoot, mode, mcpServers, prompt });
        logger.info(`[wake] order "${order.id}" finished: stopReason=${result.stopReason} cost=${JSON.stringify(result.usage)}`);

        const reply = result.text.trim();
        if (!reply) {
            logger.error(`[wake] order "${order.id}" produced no reply — sending fallback notification`);
            await sendTelegram(`Something happened with "${order.description}", but I didn't get a clear result back. Worth checking on.`, order);
            return;
        }

        await sendTelegram(reply, order);
    };
}

/** Read every .md file in a directory, concatenated with headers. Missing dir -> empty string. */
function readMemoryFiles(memoryDir) {
    let entries;
    try {
        entries = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    } catch {
        return "";
    }
    return entries
        .map((f) => `--- memory/${f} ---\n${readFileSync(join(memoryDir, f), "utf-8")}`)
        .join("\n\n");
}

function buildWakePrompt({ promptsDir, memoryDir, order, triggerContext, recipient }) {
    const systemPrompt = buildSystemPrompt(promptsDir);
    const memory = readMemoryFiles(memoryDir);

    const recipientCtx = recipient
        ? [
            "NOTIFICATION RECIPIENT",
            `Name: ${recipient.displayName} (telegram_id: ${recipient.userId})`,
            `Address them as "Commander". Use "you/your" when referring to them. Use third-person names for all other residents.`,
          ].join("\n")
        : null;

    const trigger = [
        "BEZA TRIGGER FIRED",
        `order_id: ${order.id}`,
        `description: ${order.description}`,
        `plan: ${order.plan}`,
        `trigger_context: ${JSON.stringify(triggerContext)}`,
    ].join("\n");

    return [systemPrompt, memory, recipientCtx, trigger].filter(Boolean).join("\n\n---\n\n");
}
