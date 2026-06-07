// ============================================================
// Telegram conversational transport (step 6)
// ============================================================
// Long-polls the Bot API for DMs from allowed users (Bernard & Zane),
// keeps one persistent ACP session per user (so the agent retains the
// "reason -> clarify -> plan -> confirm -> arm" conversation across
// messages), and relays replies back. Reuses the same runner the
// wake-glue uses, but via openSession/prompt — not the one-shot
// runTurn — since a conversation needs continuity.
//
// Unlike the wake path, the agent here does NOT get a notification
// contract: every reply is relayed straight back to the user that sent
// the message that produced it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {object} opts
 * @param {import("./agent-runner.mjs").ClaudeAgentRunner} opts.runner
 * @param {string} opts.projectRoot - cwd for ACP sessions (NOT the operator's ~/.claude)
 * @param {string} opts.systemPromptPath
 * @param {string} opts.memoryDir
 * @param {Array}  opts.mcpServers - MCP server configs (e.g. Home Assistant)
 * @param {string} opts.botToken
 * @param {Record<string, string>} opts.allowedUsers - Telegram user id -> display name
 * @param {(text: string, chatId: string|number) => Promise<boolean>} opts.sendTelegram
 * @param {string} [opts.mode] - conversational session mode; default "default" (asks before acting)
 * @param {number} [opts.pollIntervalMs]
 * @param {{info: Function, error: Function}} [opts.logger]
 */
export function createTelegramBot({
    runner,
    projectRoot,
    systemPromptPath,
    memoryDir,
    mcpServers,
    botToken,
    allowedUsers,
    sendTelegram,
    mode = "default",
    pollIntervalMs = 1000,
    logger = console,
}) {
    const sessions = new Map(); // userId -> { sessionId, primed }
    let offset = 0;
    let stopped = true;
    let pollTimer = null;

    async function getOrCreateSession(userId) {
        let entry = sessions.get(userId);
        if (!entry) {
            const sessionId = await runner.openSession({ cwd: projectRoot, mode, mcpServers });
            entry = { sessionId, primed: false };
            sessions.set(userId, entry);
        }
        return entry;
    }

    async function handleMessage(userId, name, text) {
        const entry = await getOrCreateSession(userId);
        const prompt = entry.primed
            ? `${name}: ${text}`
            : buildPrimingPrompt({ systemPromptPath, memoryDir, name, text });
        entry.primed = true;

        logger.info(`[telegram-bot] turn for ${name} (${userId})`);
        const result = await runner.prompt(entry.sessionId, prompt);
        logger.info(`[telegram-bot] turn for ${name} done: stopReason=${result.stopReason} cost=${JSON.stringify(result.usage)}`);

        const reply = result.text.trim();
        if (reply) await sendTelegram(reply, userId);
    }

    async function pollOnce() {
        const updates = await fetchUpdates({ botToken, offset, logger });
        for (const update of updates) {
            offset = update.update_id + 1;
            const message = update.message;
            const userId = String(message?.from?.id ?? "");
            const text = message?.text;
            if (!userId || !text) continue;

            const name = allowedUsers[userId];
            if (!name) {
                logger.error(`[telegram-bot] ignoring message from unauthorized user ${userId}`);
                continue;
            }

            try {
                await handleMessage(userId, name, text);
            } catch (e) {
                logger.error(`[telegram-bot] turn for ${name} (${userId}) failed: ${e.message}`);
                await sendTelegram("Something went wrong on my end — try again in a moment.", userId).catch(() => {});
            }
        }
    }

    async function loop() {
        if (stopped) return;
        try {
            await pollOnce();
        } catch (e) {
            logger.error(`[telegram-bot] poll failed: ${e.message}`);
        }
        if (!stopped) pollTimer = setTimeout(loop, pollIntervalMs);
    }

    return {
        async start() {
            stopped = false;
            loop();
        },
        async stop() {
            stopped = true;
            if (pollTimer) clearTimeout(pollTimer);
            for (const { sessionId } of sessions.values()) {
                await runner.closeSession(sessionId).catch(() => {});
            }
            sessions.clear();
        },
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

/** First turn of a fresh session: system prompt + memory + the user's opening message. */
function buildPrimingPrompt({ systemPromptPath, memoryDir, name, text }) {
    const systemPrompt = readFileSync(systemPromptPath, "utf-8");
    const memory = readMemoryFiles(memoryDir);
    return [systemPrompt, memory, `${name}: ${text}`].filter(Boolean).join("\n\n---\n\n");
}

/** Long-poll the Bot API for new updates (DMs only — no SDK dependency). */
async function fetchUpdates({ botToken, offset, logger }) {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates`
        + `?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
        logger.error(`[telegram-bot] getUpdates failed: ${data.description}`);
        return [];
    }
    return data.result;
}
