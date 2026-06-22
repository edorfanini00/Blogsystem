// ═══════════════════════════════════════════════════════════════════
// Trend Engine — shared Claude helper
// The scorer and the generator both need an LLM. This wraps the Anthropic
// SDK with the same retry behaviour the main server uses, and a JSON
// helper that tolerates fenced/preambled model output. Degrades gracefully
// when ANTHROPIC_API_KEY is absent.
// ═══════════════════════════════════════════════════════════════════
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

export const isLlmConfigured =
    !!apiKey && apiKey !== 'placeholder' && apiKey !== 'your_anthropic_api_key';

export const LLM_MODEL = process.env.TREND_LLM_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic({ apiKey: apiKey || 'placeholder' });

export async function callClaude(params, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await client.messages.create(params);
        } catch (err) {
            const status = err?.status || err?.error?.status || 0;
            const retryable =
                status === 529 || status === 429 || (err.message && err.message.includes('overloaded'));
            if (retryable && attempt < maxRetries) {
                const delay = Math.min(8000 * 2 ** (attempt - 1), 30000);
                console.warn(`⚠ Claude ${status || 'overloaded'} — retry ${attempt}/${maxRetries} in ${delay / 1000}s…`);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
}

function extractText(msg) {
    if (!msg || !Array.isArray(msg.content)) return '';
    return msg.content.map((b) => b.text || '').join('').trim();
}

// Parse JSON from a model response that may be fenced or have a preamble.
export function parseJsonLoose(text) {
    if (!text) return null;
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try {
        return JSON.parse(s);
    } catch {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try { return JSON.parse(s.slice(start, end + 1)); } catch { /* fall through */ }
        }
        return null;
    }
}

// Ask Claude for JSON. Returns the parsed object (or null on parse failure).
export async function claudeJSON(system, user, { maxTokens = 1024 } = {}) {
    if (!isLlmConfigured) throw new Error('ANTHROPIC_API_KEY not configured');
    const msg = await callClaude({
        model: LLM_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
    });
    return parseJsonLoose(extractText(msg));
}
