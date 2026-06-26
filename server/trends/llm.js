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

// Strip trailing commas (",}" / ",]") that strict JSON.parse rejects but LLMs
// occasionally emit. Conservative: only removes a comma immediately before a
// closing brace/bracket (optionally across whitespace).
function stripTrailingCommas(s) {
    return s.replace(/,(\s*[}\]])/g, '$1');
}

// Repair a JSON object that was cut off (model hit max_tokens mid-output). We
// close any string still open, drop a dangling "key": with no value, strip a
// trailing comma, and append the closing brackets the open stack still needs.
// Best-effort: recovers the completed prefix instead of failing outright.
function repairTruncatedJson(str) {
    const start = str.indexOf('{');
    if (start === -1) return null;
    let s = str.slice(start);
    let inStr = false, esc = false;
    const stack = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) s += '"';                       // close an open string
    s = s.replace(/,\s*$/, '');                // strip trailing comma
    s = s.replace(/,?\s*"[^"]*"\s*:\s*$/, ''); // drop a dangling "key":
    s = s.replace(/,\s*$/, '');
    while (stack.length) s += stack.pop();      // balance brackets
    return s;
}

// Parse JSON from a model response that may be fenced or have a preamble.
export function parseJsonLoose(text) {
    if (!text) return null;
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const attempt = (str) => {
        try { return JSON.parse(str); } catch { /* try next */ }
        try { return JSON.parse(stripTrailingCommas(str)); } catch { return undefined; }
    };
    let out = attempt(s);
    if (out !== undefined) return out;
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
        out = attempt(s.slice(start, end + 1));
        if (out !== undefined) return out;
    }
    // Last resort: the output was truncated (no valid closing). Repair + parse.
    const repaired = repairTruncatedJson(s);
    if (repaired) {
        out = attempt(repaired);
        if (out !== undefined) return out;
    }
    return null;
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
