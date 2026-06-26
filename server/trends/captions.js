// ═══════════════════════════════════════════════════════════════════
// Video Generation — captions (burned, word-synced)
// Short-form lives or dies on captions. We synthesize the voiceover via the
// ElevenLabs "with-timestamps" endpoint, which returns per-character timing,
// turn that into punchy 1-3 word pops, and render a styled ASS subtitle that
// Assembly burns into the final cut with libass + a bundled display font (so
// it renders identically on the serverless runtime, which has no system fonts).
// ═══════════════════════════════════════════════════════════════════
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, CAPTIONS_ENABLED, CAPTION_MAX_WORDS,
    VOICE_MATCH_ENABLED, VOICE_LIBRARY,
} from './config.js';

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAPTION_FONT_PATH = path.join(HERE, 'assets', 'caption-font.ttf');
export const CAPTION_FONT_NAME = 'Anton';
export const isCaptionsConfigured = CAPTIONS_ENABLED && !!ELEVENLABS_KEY;

// Pick the ElevenLabs voice that best matches the analyzed source's delivery.
// Scores library voices on gender (highest weight), then energy, then age.
// Falls back to the configured default when matching is off or no profile.
export function pickVoiceId(voiceProfile) {
    if (!VOICE_MATCH_ENABLED || !voiceProfile || !Array.isArray(VOICE_LIBRARY) || !VOICE_LIBRARY.length) {
        return ELEVENLABS_VOICE_ID;
    }
    const want = {
        gender: String(voiceProfile.gender || '').toLowerCase(),
        age: String(voiceProfile.age || '').toLowerCase(),
        energy: String(voiceProfile.energy || '').toLowerCase(),
    };
    // Map "hyped"/"moderate" synonyms onto the library's energy buckets.
    const energyAlias = (e) => (e === 'hyped' ? 'high' : e === 'medium' ? 'moderate' : e);
    want.energy = energyAlias(want.energy);

    let best = null, bestScore = -1;
    for (const v of VOICE_LIBRARY) {
        let score = 0;
        if (want.gender && v.gender && want.gender === String(v.gender).toLowerCase()) score += 10;
        if (want.energy && v.energy && want.energy === energyAlias(String(v.energy).toLowerCase())) score += 4;
        if (want.age && v.age && want.age === String(v.age).toLowerCase()) score += 2;
        if (score > bestScore) { bestScore = score; best = v; }
    }
    return (best && best.id) ? best.id : ELEVENLABS_VOICE_ID;
}

// Synthesize VO with character-level timestamps. Writes the mp3 to `dest` and
// returns { path, alignment } (alignment may be null if the API shape changes).
// `voiceId` defaults to the configured voice; pass a per-video match to vary it.
export async function synthVoiceoverTimed(text, dest, voiceId = ELEVENLABS_VOICE_ID) {
    if (!ELEVENLABS_KEY || !text || !text.trim()) return null;
    const useVoice = voiceId || ELEVENLABS_VOICE_ID;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${useVoice}/with-timestamps`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            text,
            model_id: ELEVENLABS_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`ElevenLabs timestamps ${r.status}: ${body.slice(0, 160)}`);
    }
    const data = await r.json();
    if (!data.audio_base64) throw new Error('ElevenLabs returned no audio');
    await fs.writeFile(dest, Buffer.from(data.audio_base64, 'base64'));
    const alignment = data.alignment || data.normalized_alignment || null;
    return { path: dest, alignment };
}

// Group character timings → words → short caption cues.
export function cuesFromAlignment(alignment, { maxWords = CAPTION_MAX_WORDS } = {}) {
    if (!alignment) return [];
    const chars = alignment.characters || [];
    const starts = alignment.character_start_times_seconds || [];
    const ends = alignment.character_end_times_seconds || [];
    if (!chars.length) return [];

    // Build words with start/end times.
    const words = [];
    let cur = null;
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const isSpace = /\s/.test(ch);
        if (isSpace) { if (cur) { words.push(cur); cur = null; } continue; }
        if (!cur) cur = { text: '', start: starts[i] ?? 0, end: ends[i] ?? 0 };
        cur.text += ch;
        cur.end = ends[i] ?? cur.end;
    }
    if (cur) words.push(cur);
    if (!words.length) return [];

    // Chunk words into cues: cap at maxWords and ~18 chars, break on sentence
    // punctuation so a cue feels like a beat.
    const cues = [];
    let chunk = [];
    const flush = () => {
        if (!chunk.length) return;
        cues.push({
            text: chunk.map((w) => w.text).join(' '),
            start: chunk[0].start,
            end: chunk[chunk.length - 1].end,
        });
        chunk = [];
    };
    for (const w of words) {
        chunk.push(w);
        const joined = chunk.map((c) => c.text).join(' ');
        const endsSentence = /[.!?,:;]$/.test(w.text);
        if (chunk.length >= maxWords || joined.length >= 18 || endsSentence) flush();
    }
    flush();
    return cues;
}

function assTime(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const cs = Math.round((s - Math.floor(s)) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(t) {
    return String(t).replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

// Build an ASS subtitle file (1080x1920) with a bold, outlined, lower-third
// caption style. Captions are uppercased for impact (Anton is a display face).
export function buildAss(cues, { width = 1080, height = 1920 } = {}) {
    const fontSize = Math.round(width * 0.085); // ~92px at 1080 wide
    const outline = Math.round(width * 0.006);
    const marginV = Math.round(height * 0.20);  // sit in the lower third
    const header = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        'WrapStyle: 1',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // White fill, black outline, soft shadow, bottom-center.
        `Style: Pop,${CAPTION_FONT_NAME},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},3,2,80,80,${marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const events = cues.map((c) => {
        // A subtle pop-in scale so the caption feels alive.
        const fx = '{\\fad(60,40)\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}';
        return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Pop,,0,0,0,,${fx}${assEscape(c.text).toUpperCase()}`;
    });
    return header.concat(events).join('\n') + '\n';
}
