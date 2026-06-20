// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Step 7: review notifications
// When a generation is ready for review or gets approved, ping the team on
// Telegram and/or Slack. Configured via env; silently no-ops when neither
// is set so the pipeline never blocks on notifications.
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   SLACK_WEBHOOK_URL
// ═══════════════════════════════════════════════════════════════════

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SLACK = process.env.SLACK_WEBHOOK_URL;

export const isNotifyConfigured = !!((TG_TOKEN && TG_CHAT) || SLACK);

export const notifyChannels = [
    ...(TG_TOKEN && TG_CHAT ? ['telegram'] : []),
    ...(SLACK ? ['slack'] : []),
];

export async function notify(text) {
    const out = { sent: [], errors: [] };

    if (TG_TOKEN && TG_CHAT) {
        try {
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: false }),
            });
            out.sent.push('telegram');
        } catch (err) {
            out.errors.push(`telegram: ${err.message}`);
        }
    }

    if (SLACK) {
        try {
            await fetch(SLACK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            out.sent.push('slack');
        } catch (err) {
            out.errors.push(`slack: ${err.message}`);
        }
    }

    return out;
}
