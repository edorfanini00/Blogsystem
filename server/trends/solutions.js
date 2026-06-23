// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Solutions knowledge base ("the brain")
// Each solution is a sellable offering with attached knowledge files.
// The scorer and generator read the selected solution + its file text
// when producing video, instead of the single hardcoded message bank.
// ═══════════════════════════════════════════════════════════════════
import { query } from './db.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }

// Extract plain text from an uploaded file buffer for LLM context.
export async function extractText(buffer, filename, mimeType) {
    const name = (filename || '').toLowerCase();
    const isPdf = name.endsWith('.pdf') || mimeType === 'application/pdf';
    if (isPdf && pdfParse) {
        try {
            const parsed = await pdfParse(buffer);
            return (parsed.text || '').trim();
        } catch (err) {
            console.error('Solution file PDF parse error:', err.message);
            return '';
        }
    }
    // Treat everything else as UTF-8 text (txt, md, csv, json, etc.).
    try {
        return buffer.toString('utf-8').trim();
    } catch {
        return '';
    }
}

// Coerce a field that may arrive as an array or a newline/comma string into a
// clean string[] for the text[] product columns.
function toArray(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v)
        .split(/\r?\n|;|,/)
        .map((x) => x.trim())
        .filter(Boolean);
}

function toEditorial(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
}

// ─── Solutions CRUD ─────────────────────────────────────────────
export async function createSolution(fields = {}) {
    const {
        name, description, buyer, pains, hooks,
        one_liner, proof_points, visual_cues, message_bank, editorial,
    } = fields;
    const r = await query(
        `insert into solutions
            (name, description, buyer, pains, hooks,
             one_liner, proof_points, visual_cues, message_bank, editorial)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [
            name, description || null, buyer || null, pains || null, hooks || null,
            one_liner || null,
            toArray(proof_points),
            toArray(visual_cues),
            toArray(message_bank),
            editorial ? JSON.stringify(toEditorial(editorial)) : null,
        ]
    );
    return r.rows[0];
}

export async function listSolutions() {
    const r = await query(
        `select s.*,
                coalesce(f.file_count, 0)::int as file_count
         from solutions s
         left join lateral (
            select count(*) as file_count from solution_files where solution_id = s.id
         ) f on true
         order by s.created_at desc`
    );
    return r.rows;
}

export async function getSolution(id) {
    const s = await query('select * from solutions where id = $1', [id]);
    if (!s.rows[0]) return null;
    const files = await query(
        `select id, filename, mime_type, size_bytes, blob_url, created_at,
                length(extracted_text) as text_length
         from solution_files where solution_id = $1
         order by created_at asc`,
        [id]
    );
    return { ...s.rows[0], files: files.rows };
}

export async function updateSolution(id, fields) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const key of ['name', 'description', 'buyer', 'pains', 'hooks', 'one_liner']) {
        if (fields[key] !== undefined) {
            sets.push(`${key} = $${i++}`);
            vals.push(fields[key]);
        }
    }
    for (const key of ['proof_points', 'visual_cues', 'message_bank']) {
        if (fields[key] !== undefined) {
            sets.push(`${key} = $${i++}`);
            vals.push(toArray(fields[key]));
        }
    }
    if (fields.editorial !== undefined) {
        sets.push(`editorial = $${i++}`);
        vals.push(fields.editorial ? JSON.stringify(toEditorial(fields.editorial)) : null);
    }
    if (!sets.length) return getSolution(id);
    sets.push(`updated_at = now()`);
    vals.push(id);
    const r = await query(
        `update solutions set ${sets.join(', ')} where id = $${i} returning *`,
        vals
    );
    return r.rows[0] || null;
}

export async function deleteSolution(id) {
    await query('delete from solutions where id = $1', [id]);
    return { ok: true };
}

// ─── Files ──────────────────────────────────────────────────────
export async function addFile(solutionId, { filename, mimeType, sizeBytes, extractedText, blobUrl }) {
    const r = await query(
        `insert into solution_files
            (solution_id, filename, mime_type, size_bytes, extracted_text, blob_url)
         values ($1,$2,$3,$4,$5,$6)
         returning id, filename, mime_type, size_bytes, blob_url, created_at`,
        [solutionId, filename, mimeType || null, sizeBytes || null, extractedText || '', blobUrl || null]
    );
    return r.rows[0];
}

export async function deleteFile(solutionId, fileId) {
    await query('delete from solution_files where id = $1 and solution_id = $2', [fileId, solutionId]);
    return { ok: true };
}

// Assemble the full knowledge context for a solution (used by the
// generator in step 6). Concatenates the profile and all file text.
export async function getSolutionContext(id) {
    const s = await query('select * from solutions where id = $1', [id]);
    if (!s.rows[0]) return null;
    const sol = s.rows[0];
    const files = await query(
        'select filename, extracted_text from solution_files where solution_id = $1 order by created_at asc',
        [id]
    );
    const fileBlocks = files.rows
        .filter((f) => f.extracted_text)
        .map((f) => `# ${f.filename}\n${f.extracted_text}`)
        .join('\n\n');
    return {
        id: sol.id,
        name: sol.name,
        description: sol.description,
        buyer: sol.buyer,
        pains: sol.pains,
        hooks: sol.hooks,
        one_liner: sol.one_liner,
        proof_points: sol.proof_points || [],
        visual_cues: sol.visual_cues || [],
        message_bank: sol.message_bank || [],
        editorial: sol.editorial || null,
        knowledge: fileBlocks,
    };
}

// Full self-contained product entry per the Video Generation spec §2, used by
// the Director. Same as the context but shaped as the spec's product object.
export async function getProductEntry(id) {
    const ctx = await getSolutionContext(id);
    if (!ctx) return null;
    return {
        product_id: ctx.id,
        name: ctx.name,
        one_liner: ctx.one_liner || ctx.description || '',
        buyer: ctx.buyer || '',
        pains: Array.isArray(ctx.pains) ? ctx.pains : (ctx.pains ? toArray(ctx.pains) : []),
        proof_points: ctx.proof_points || [],
        visual_cues: ctx.visual_cues || [],
        message_bank: ctx.message_bank || [],
        editorial: ctx.editorial || { banned_terms: [], required_framing: '', notes: '' },
        knowledge: ctx.knowledge || '',
    };
}

// Lightweight list for the Director's auto-select (name + one_liner + buyer).
export async function listProductsBrief() {
    const r = await query(
        `select id, name, coalesce(one_liner, description, '') as one_liner,
                coalesce(buyer, '') as buyer
         from solutions order by created_at desc`
    );
    return r.rows;
}
