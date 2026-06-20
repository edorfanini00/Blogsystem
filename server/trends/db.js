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

// Resolve the Postgres connection string. The Vercel + Supabase/Postgres
// integration injects the connection under several possible names, so we
// check all of them and prefer a pooled (pgBouncer) URL for serverless.
const DB_ENV_VARS = [
    'DATABASE_URL',
    'POSTGRES_URL',          // Vercel Postgres / Supabase integration (pooled)
    'POSTGRES_PRISMA_URL',   // pooled with pgbouncer=true
    'SUPABASE_DB_URL',
    'POSTGRES_URL_NON_POOLING', // direct connection fallback
];

let DATABASE_URL = null;
let DB_SOURCE = null;
for (const key of DB_ENV_VARS) {
    if (process.env[key]) {
        DATABASE_URL = process.env[key];
        DB_SOURCE = key;
        break;
    }
}

export const isDbConfigured = !!DATABASE_URL;
export const dbSource = DB_SOURCE;

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
