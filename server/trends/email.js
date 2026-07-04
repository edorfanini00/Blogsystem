// ═══════════════════════════════════════════════════════════════════
// Trend Engine — Review-by-email workflow
// When a generation finishes rendering (status → 'review') we email a reviewer
// a self-contained link to: watch the video, Approve & Post it to Instagram, or
// request changes (which regenerates a fresh version and, when THAT finishes,
// emails again — closing the loop).
//
// Email is sent over SMTP via nodemailer. By default it reuses the app's
// existing Gmail credentials (EMAIL_USER / EMAIL_PASSWORD — a Gmail App
// Password), so review emails work with no extra setup. Override with a generic
// SMTP server if you prefer:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS
//   SMTP_SECURE=true        (only for port 465 / implicit TLS)
//   EMAIL_FROM              (default: "CeleriTech Studio <sender>")
//   REVIEW_EMAIL_TO         (default: edoardo.orfanini@celeritech.biz)
//   APP_URL                 (public base URL for the action links)
//   REVIEW_SECRET           (HMAC secret for the no-login action tokens)
// Silently no-ops when no mail credentials exist, so the pipeline never blocks.
// ═══════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { query } from './db.js';

// Generic SMTP override (takes precedence when a host is given).
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;

// Existing app Gmail credentials (fallback / default transport).
const GMAIL_USER = process.env.EMAIL_USER;
const GMAIL_PASS = process.env.EMAIL_PASSWORD;

const useSmtp = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const useGmail = !useSmtp && !!(GMAIL_USER && GMAIL_PASS);

const SENDER = useSmtp ? SMTP_USER : GMAIL_USER;
const EMAIL_FROM = process.env.EMAIL_FROM || (SENDER ? `CeleriTech Studio <${SENDER}>` : null);
const REVIEW_EMAIL_TO = process.env.REVIEW_EMAIL_TO || 'edoardo.orfanini@celeritech.biz';

export const isEmailConfigured = useSmtp || useGmail;

let transporter = null;
function getTransport() {
    if (!isEmailConfigured) return null;
    if (!transporter) {
        transporter = useSmtp
            ? nodemailer.createTransport({
                host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
                auth: { user: SMTP_USER, pass: SMTP_PASS },
            })
            : nodemailer.createTransport({
                host: 'smtp.gmail.com', port: 465, secure: true,
                auth: { user: GMAIL_USER, pass: GMAIL_PASS },
            });
    }
    return transporter;
}

// ─── No-login action tokens ─────────────────────────────────────
// Email recipients act on a generation without a session, so each link carries
// an HMAC of the generation id. Forged/wrong ids are rejected. Rotate by
// setting REVIEW_SECRET (falls back to CRON_SECRET, then a constant).
const REVIEW_SECRET = process.env.REVIEW_SECRET || process.env.CRON_SECRET || 'celeritech-review-secret-v1';

export function makeReviewToken(id) {
    return crypto.createHmac('sha256', REVIEW_SECRET).update(String(id)).digest('hex').slice(0, 32);
}

export function verifyReviewToken(id, token) {
    if (!token) return false;
    const expected = makeReviewToken(id);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Public base URL for building action links. Prefers the live request host, then
// APP_URL, then the Vercel deployment URL, then the known production domain.
export function appBaseUrl(req = null) {
    if (req?.headers?.host) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        return `${proto}://${req.headers.host}`;
    }
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return 'https://blogsystem-rho.vercel.app';
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ─── The review email ───────────────────────────────────────────
function buildReviewEmail(gen, { baseUrl, token }) {
    const reviewUrl = `${baseUrl}/api/trends/review/${gen.id}?token=${token}`;
    const title = gen.resolved_target || gen.caption || 'New remake';
    const kind = gen.output_type === 'slideshow' ? 'slideshow' : 'video';
    const regenLine = gen.regen_count > 0
        ? `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Revision #${gen.regen_count} — regenerated from your previous feedback.</p>`
        : '';
    const caption = gen.caption
        ? `<div style="margin:0 0 20px;padding:14px 16px;background:#f9fafb;border-radius:10px;color:#374151;font-size:14px;line-height:1.5;"><strong style="color:#111827;">Caption</strong><br>${esc(gen.caption)}</div>`
        : '';

    const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px 28px;">
      <div style="color:#ffffff;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;opacity:0.9;">CeleriTech Studio</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">A new ${kind} is ready for review</div>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 6px;font-size:18px;color:#111827;">${esc(title)}</h1>
      ${regenLine}
      ${caption}
      <p style="margin:0 0 20px;color:#4b5563;font-size:15px;line-height:1.6;">Open the review page to watch it, approve &amp; post it to Instagram, or send back notes on what to change (it'll regenerate and email you the new version).</p>
      <a href="${reviewUrl}" style="display:block;text-align:center;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 20px;border-radius:10px;">▶︎ Review, approve or request changes</a>
      <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">If the button doesn't work, paste this link into your browser:<br><span style="color:#6b7280;word-break:break-all;">${esc(reviewUrl)}</span></p>
    </div>
  </div>
</body></html>`;

    const text = `A new ${kind} is ready for review: ${title}\n\n`
        + (gen.caption ? `Caption: ${gen.caption}\n\n` : '')
        + `Review, approve & post, or request changes here:\n${reviewUrl}\n`;

    return {
        subject: `🎬 Review ready${gen.regen_count > 0 ? ` (rev #${gen.regen_count})` : ''}: ${title}`,
        html,
        text,
    };
}

export async function sendMail({ to, subject, html, text }) {
    const t = getTransport();
    if (!t) return { skipped: 'email not configured' };
    return t.sendMail({ from: EMAIL_FROM, to: to || REVIEW_EMAIL_TO, subject, html, text });
}

// ─── Idempotent "ready for review" notification ─────────────────
// Safe to call from anywhere a generation may have reached 'review' (chain
// cron, manual assemble/slides). Emails at most once per generation, guarded by
// the review_email_sent column. Returns a small status object; never throws.
export async function notifyReviewReady(generationId, { req = null } = {}) {
    try {
        const { rows } = await query(
            `select g.id, g.status, g.caption, g.resolved_target, g.output_type,
                    g.asset_url, g.regen_count, g.review_email_sent
               from generations g where g.id = $1`,
            [generationId]
        );
        const gen = rows[0];
        if (!gen) return { skipped: 'not found' };
        if (gen.status !== 'review') return { skipped: `status ${gen.status}` };
        if (gen.review_email_sent) return { skipped: 'already sent' };
        if (!isEmailConfigured) {
            // Nothing to send, but don't mark as sent so it goes out once SMTP is set.
            return { skipped: 'email not configured' };
        }
        const baseUrl = appBaseUrl(req);
        const token = makeReviewToken(gen.id);
        const { subject, html, text } = buildReviewEmail(gen, { baseUrl, token });
        await sendMail({ to: REVIEW_EMAIL_TO, subject, html, text });
        await query('update generations set review_email_sent = true where id = $1', [gen.id]).catch(() => {});
        return { sent: true, to: REVIEW_EMAIL_TO };
    } catch (err) {
        console.error('notifyReviewReady error:', err.message);
        return { error: err.message };
    }
}

export const reviewEmailTo = REVIEW_EMAIL_TO;
