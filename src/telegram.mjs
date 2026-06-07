// ============================================================
// Minimal Telegram sender — direct fetch to the Bot API
// ============================================================
// No SDK dependency. Used by the listener for zero-token direct
// notifications, and reusable by the bot transport (step 6).

export function makeTelegramSender({ botToken, chatId, logger = console }) {
    return async function sendTelegram(text) {
        if (!botToken) {
            logger.error("[telegram] no bot token configured");
            return false;
        }
        try {
            const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.description);
            return true;
        } catch (e) {
            logger.error(`[telegram] send failed: ${e.message}`);
            return false;
        }
    };
}
