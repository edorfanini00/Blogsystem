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

// A direct (non-pooling) URL for DDL: the Supabase transaction pooler can
// reject multi-statement migrations, so prefer a direct connection if present.
const MIGRATION_URL =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_DB_URL ||
    DATABASE_URL;

export const isDbConfigured = !!DATABASE_URL;
export const dbSource = DB_SOURCE;

// Strip sslmode/ssl query params from a Postgres URL. Supabase's pooler uses a
// cert that Node doesn't trust ("self-signed certificate in certificate
// chain"); a connection-string sslmode can override the explicit ssl option we
// pass, so we remove it and rely on ssl: { rejectUnauthorized: false }.
function stripSslParams(u) {
    if (!u) return u;
    try {
        const url = new URL(u);
        url.searchParams.delete('sslmode');
        url.searchParams.delete('ssl');
        return url.toString();
    } catch {
        return u.replace(/([?&])sslmode=[^&]*/gi, '$1').replace(/([?&])ssl=[^&]*/gi, '$1')
            .replace(/[?&]$/, '');
    }
}

const POOL_URL = stripSslParams(DATABASE_URL);

let pool = null;

export function getPool() {
    if (!POOL_URL) return null;
    if (!pool) {
        pool = new pg.Pool({
            connectionString: POOL_URL,
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

// Split a SQL file into individual statements (our schema has no functions
// or dollar-quoted bodies, so splitting on semicolons is safe). Comments are
// stripped so they don't swallow following statements.
function splitStatements(sql) {
    return sql
        .split('\n')
        // Strip line and inline comments (our schema has no -- inside strings).
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
}

// Run the schema migration (idempotent). Uses a dedicated direct connection
// and applies statements one at a time so it works through pgBouncer too.
export async function migrate() {
    if (!MIGRATION_URL) throw new Error('DATABASE_URL not configured');
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    const statements = splitStatements(sql);

    const client = new pg.Client({
        connectionString: stripSslParams(MIGRATION_URL),
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
    });
    await client.connect();
    try {
        for (const stmt of statements) {
            await client.query(stmt);
        }
    } finally {
        await client.end().catch(() => {});
    }
    return { ok: true, statements: statements.length };
}

export async function pingDb() {
    const r = await query('select now() as now');
    return r.rows[0]?.now;
}
