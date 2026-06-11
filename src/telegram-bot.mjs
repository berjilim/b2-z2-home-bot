// ============================================================
// Telegram conversational transport (step 6)
// ============================================================
// Long-polls the Bot API for DMs from allowed users,
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
 * @param {(chatId: string|number, text: string) => Promise<number|null>} [opts.sendPlaceholder] -
 *   sends a "processing..." placeholder immediately on receipt, returns its message_id
 * @param {(chatId: string|number, messageId: number, text: string) => Promise<boolean>} [opts.editReply] -
 *   swaps the placeholder's content for the real reply once the turn completes
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
    sendPlaceholder,
    editReply,
    mode = "default",
    pollIntervalMs = 1000,
    // How long a user's session can sit idle before we recycle it. Persistent
    // sessions exist so multi-turn flows (reason -> clarify -> plan -> confirm
    // -> arm) keep continuity — they do NOT need to remember a conversation
    // from days/weeks ago. Left unbounded, history (and cost) grows forever;
    // recycling on idle keeps cost flat and matches the "you wake up fresh —
    // memory files are your continuity" design the wake path already follows.
    idleTimeoutMs = 4 * 60 * 60 * 1000,
    logger = console,
}) {
    const sessions = new Map(); // userId -> { sessionId, primed, lastActivity }
    let offset = 0;
    let stopped = true;
    let pollTimer = null;

    async function getOrCreateSession(userId) {
        let entry = sessions.get(userId);
        if (entry && Date.now() - entry.lastActivity > idleTimeoutMs) {
            logger.info(`[telegram-bot] recycling idle session for ${userId} (idle ${Math.round((Date.now() - entry.lastActivity) / 60000)}m)`);
            await runner.closeSession(entry.sessionId).catch(() => {});
            sessions.delete(userId);
            entry = null;
        }
        if (!entry) {
            const sessionId = await runner.openSession({ cwd: projectRoot, mode, mcpServers });
            entry = { sessionId, primed: false, lastActivity: Date.now() };
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
        entry.lastActivity = Date.now();

        // Fire the "processing..." placeholder immediately — turns can take
        // 10-30s with HA tool calls in the loop, and there's otherwise no
        // visual cue anything is happening until the reply lands.
        const placeholderId = sendPlaceholder ? await sendPlaceholder(userId, "🤖 Processing…") : null;

        logger.info(`[telegram-bot] turn for ${name} (${userId})`);
        const result = await runner.prompt(entry.sessionId, prompt);
        logger.info(`[telegram-bot] turn for ${name} done: stopReason=${result.stopReason} cost=${JSON.stringify(result.usage)}`);

        const reply = result.text.trim() || "(no reply this turn)";
        if (placeholderId && editReply) {
            await editReply(userId, placeholderId, reply);
        } else if (result.text.trim()) {
            await sendTelegram(reply, userId);
        }
    }

    async function pollOnce() {
        const updates = await fetchUpdates({ botToken, offset, logger });
        for (const update of updates) {
            offset = update.update_id + 1;
            const message = update.message;
            const userId = String(message?.from?.id ?? "");
            const text = message?.text;
            if (!userId || !text) continue;

            // TEMP DIAGNOSTIC: chat.id should equal from.id for DMs — if they
            // differ, replies (sent to from.id) will fail with "chat not found"
            // because the bot has no private conversation with that user id.
            logger.info(`[telegram-bot] DEBUG message from.id=${message?.from?.id} chat.id=${message?.chat?.id} chat.type=${message?.chat?.type}`);

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
