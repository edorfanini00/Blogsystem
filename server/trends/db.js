// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Postgres (Supabase) connection
// Lazy pool. Stays dormant and the rest of the app boots fine when
// DATABASE_URL is not configured.
// ═══════════════════════════════════════════════════════════════════
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supabase connection string. Use the pooled (pgBouncer) URL in serverless.
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

export const isDbConfigured = !!DATABASE_URL;

let pool = null;

export function getPool() {
    if (!DATABASE_URL) return null;
    if (!pool) {
        pool = new pg.Pool({
            connectionString: DATABASE_URL,
            // Supabase requires TLS; relax cert check for the pooler endpoint.
            ssl: { rejectUnauthorized: false },
            max: 5,
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 8000,
        });
        pool.on('error', (err) => console.error('Postgres pool error:', err.message));
    }
    return pool;
}

export async function query(text, params) {
    const p = getPool();
    if (!p) throw new Error('DATABASE_URL not configured');
    return p.query(text, params);
}

// Run the schema migration (idempotent).
export async function migrate() {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    await query(sql);
    return { ok: true };
}

export async function pingDb() {
    const r = await query('select now() as now');
    return r.rows[0]?.now;
}
