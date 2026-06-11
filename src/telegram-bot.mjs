// ============================================================
// Telegram conversational transport (step 6)
// ============================================================
// Long-polls the Bot API for DMs from authorized users,
// keeps one persistent ACP session per user (so the agent retains the
// "reason -> clarify -> plan -> confirm -> arm" conversation across
// messages), and relays replies back. Reuses the same runner the
// wake-glue uses, but via openSession/prompt — not the one-shot
// runTurn — since a conversation needs continuity.
//
// Authorization is handled via RbacStore. Unknown users are rejected
// unless they're redeeming a valid invite token (/start invite_TOKEN).
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
 * @param {import("./rbac.mjs").RbacStore} opts.rbac
 * @param {string} [opts.botUsername] - Telegram @username of this bot (for invite links)
 * @param {(text: string, chatId: string|number) => Promise<boolean>} opts.sendTelegram
 * @param {(chatId: string|number, text: string) => Promise<number|null>} [opts.sendPlaceholder]
 * @param {(chatId: string|number, messageId: number, text: string) => Promise<boolean>} [opts.editReply]
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
    rbac,
    botUsername,
    sendTelegram,
    sendPlaceholder,
    editReply,
    mode = "default",
    pollIntervalMs = 1000,
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

    async function handleMessage(userId, user, text) {
        const entry = await getOrCreateSession(userId);
        const prompt = entry.primed
            ? `${user.displayName}: ${text}`
            : buildPrimingPrompt({ systemPromptPath, memoryDir, user, text, botUsername });
        entry.primed = true;
        entry.lastActivity = Date.now();

        const placeholderId = sendPlaceholder ? await sendPlaceholder(userId, "🤖 Processing…") : null;

        logger.info(`[telegram-bot] turn for ${user.displayName} (${userId}, role: ${user.role})`);
        const result = await runner.prompt(entry.sessionId, prompt);
        logger.info(`[telegram-bot] turn for ${user.displayName} done: stopReason=${result.stopReason} cost=${JSON.stringify(result.usage)}`);

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

            logger.info(`[telegram-bot] DEBUG message from.id=${message?.from?.id} chat.id=${message?.chat?.id} chat.type=${message?.chat?.type}`);

            // Invite redemption: /start invite_TOKEN (Telegram deep-link)
            const inviteMatch = text.match(/^\/start invite_([A-Za-z0-9]+)$/);
            if (inviteMatch) {
                const token = inviteMatch[1];
                const firstName = message?.from?.first_name ?? "";
                const lastName = message?.from?.last_name ?? "";
                const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
                const result = rbac.redeemInvite(token, userId, displayName);
                if (result.ok) {
                    logger.info(`[telegram-bot] invite redeemed by ${userId} → role: ${result.role}`);
                    await sendTelegram(
                        `Access granted — ${result.role} role. You can now give me orders, Commander.`,
                        userId
                    );
                } else {
                    logger.info(`[telegram-bot] invite redemption failed for ${userId}: ${result.error}`);
                    await sendTelegram(
                        `This invite link is ${result.error}. Request a new one from the owner.`,
                        userId
                    );
                }
                continue;
            }

            const user = rbac.getUser(userId);
            if (!user) {
                logger.error(`[telegram-bot] ignoring message from unauthorized user ${userId}`);
                // Send one-time rejection so the user knows why nothing happens
                await sendTelegram("Access denied. This unit is not authorized to respond to unknown contacts.", userId).catch(() => {});
                continue;
            }

            try {
                await handleMessage(userId, user, text);
            } catch (e) {
                logger.error(`[telegram-bot] turn for ${user.displayName} (${userId}) failed: ${e.message}`);
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

/** First turn of a fresh session: system prompt + session context + memory + opening message. */
function buildPrimingPrompt({ systemPromptPath, memoryDir, user, text, botUsername }) {
    const systemPrompt = readFileSync(systemPromptPath, "utf-8");
    const memory = readMemoryFiles(memoryDir);
    const sessionCtx = [
        "SESSION CONTEXT",
        `User: ${user.displayName} [role: ${user.role}] (telegram_id: ${user.userId})`,
        botUsername ? `Bot username: @${botUsername}` : null,
    ].filter(Boolean).join("\n");
    return [systemPrompt, sessionCtx, memory, `${user.displayName}: ${text}`].filter(Boolean).join("\n\n---\n\n");
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
