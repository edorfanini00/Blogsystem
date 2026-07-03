import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import nodemailer from 'nodemailer';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { createRequire } from 'module';
// @vercel/blob/client is loaded lazily to avoid hanging in local dev
let generateClientTokenFromReadWriteToken;
const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isVercel = !!process.env.VERCEL;

if (!isVercel) {
    dotenv.config({ path: join(__dirname, '.env') });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Multer for file uploads ────────────────────────────────────
const uploadsDir = isVercel ? '/tmp/uploads' : join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── File Upload Endpoint ───────────────────────────────────────
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
    try {
        const results = [];
        for (const file of req.files) {
            let text = '';
            try {
                const buf = readFileSync(file.path);
                if (file.originalname.toLowerCase().endsWith('.pdf')) {
                    const pdf = await pdfParse(buf);
                    text = pdf.text;
                } else {
                    text = buf.toString('utf-8');
                }
            } catch {
                text = `[Could not parse: ${file.originalname}, ${(file.size / 1024).toFixed(1)} KB]`;
            }
            results.push({ name: file.originalname, size: file.size, text: text.slice(0, 50000) });
        }
        res.json({ files: results });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Email Configuration (Gmail SMTP) ───────────────────────────
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

if (!EMAIL_USER || !EMAIL_PASSWORD) {
    console.warn('⚠️  EMAIL_USER or EMAIL_PASSWORD not set in .env — email sending will be disabled.');
    console.warn('   To enable: add EMAIL_USER=your@gmail.com and EMAIL_PASSWORD=your_app_password to server/.env');
    console.warn('   Generate an App Password at: https://myaccount.google.com/apppasswords');
}

// Create a reusable transporter (only if credentials exist)
let emailTransporter = null;
let transporterVerified = false;

if (EMAIL_USER && EMAIL_PASSWORD) {
    emailTransporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASSWORD,
        },
    });

    // Verify on startup (non-blocking)
    emailTransporter.verify()
        .then(() => {
            transporterVerified = true;
            console.log('✅ Email transporter verified — Gmail SMTP ready');
        })
        .catch(err => {
            console.error('❌ Email transporter verification failed:', err.message);
            console.error('   Check your EMAIL_USER and EMAIL_PASSWORD in .env');
            console.error('   Make sure you are using a Gmail App Password, NOT your regular password.');
        });
}

app.post('/api/send-email', async (req, res) => {
    const { subject, htmlContent, textContent, recipientEmail } = req.body;
    const to = recipientEmail || 'Karla@kromaticos.com';

    // --- Guard: no credentials configured ---
    if (!emailTransporter) {
        console.error('📧 Email send attempted but no credentials configured');
        return res.status(503).json({
            error: 'Email not configured. Add EMAIL_USER and EMAIL_PASSWORD to server/.env',
        });
    }

    try {
        const info = await emailTransporter.sendMail({
            from: `"Celeritech Orbit" <${EMAIL_USER}>`,
            to,
            subject: subject || 'New Ad Creative from Celeritech Orbit',
            text: textContent,
            html: htmlContent || `<pre style="font-family:sans-serif;white-space:pre-wrap;">${textContent}</pre>`,
        });

        console.log(`📧 Email sent to ${to} (messageId: ${info.messageId})`);
        res.json({ success: true, to, messageId: info.messageId });
    } catch (err) {
        console.error('❌ Email send error:', err);

        // Provide a user-friendly error message
        let userMessage = err.message;
        if (err.code === 'EAUTH') {
            userMessage = 'Authentication failed. Make sure EMAIL_PASSWORD is a Gmail App Password (not your regular password). Generate one at https://myaccount.google.com/apppasswords';
        } else if (err.code === 'ESOCKET' || err.code === 'ECONNECTION') {
            userMessage = 'Could not connect to Gmail SMTP server. Check your internet connection.';
        }

        res.status(500).json({ error: userMessage });
    }
});

const PORT = process.env.PORT || 3001;

// ─── Data Persistence ────────────────────────────────────────────
const dataDir = isVercel ? '/tmp/data' : join(__dirname, 'data');
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// Ensure users.json exists
const usersFile = join(dataDir, 'users.json');
if (!existsSync(usersFile)) {
    writeFileSync(usersFile, JSON.stringify([]));
    console.log('Created users.json file.');
}

// ─── Redis via ioredis (uses REDIS_URL directly) ────────────────
import Redis from 'ioredis';

const REDIS_URL = process.env.KV_URL || process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
const useKV = !!REDIS_URL;
let redis = null;

function getRedis() {
    if (!redis && REDIS_URL) {
        redis = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            commandTimeout: 5000,
            lazyConnect: true,
            tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
        });
        redis.on('error', (err) => console.error('Redis error:', err.message));
    }
    return redis;
}

if (useKV) {
    console.log('✅ Redis configured via REDIS_URL');
} else if (!isVercel) {
    console.log('ℹ️  Redis not configured — using local users.json');
} else {
    console.error('❌ No REDIS_URL found.');
}

// ─── User Storage (Redis on Vercel, local JSON fallback) ────────
async function getUsers() {
    if (useKV) {
        const r = getRedis();
        await r.connect().catch(() => { });
        const data = await r.get('orbit_users');
        if (!data) return [];
        try { return JSON.parse(data); }
        catch (err) { console.error('Corrupt orbit_users in Redis:', err.message); return []; }
    }
    try {
        return JSON.parse(readFileSync(usersFile, 'utf-8'));
    } catch { return []; }
}

async function saveUsers(users) {
    if (useKV) {
        const r = getRedis();
        await r.connect().catch(() => { });
        await r.set('orbit_users', JSON.stringify(users));
    } else {
        writeFileSync(usersFile, JSON.stringify(users, null, 2));
    }
}

async function redisSet(key, value) {
    const r = getRedis();
    await r.connect().catch(() => { });
    await r.set(key, JSON.stringify(value));
}

// ─── Redis Connection Test ──────────────────────────────────────
app.get('/api/test-redis', async (req, res) => {
    if (!useKV) {
        return res.json({
            ok: false, error: 'No REDIS_URL env var found', envVars: {
                REDIS_URL: !!process.env.REDIS_URL,
                KV_URL: !!process.env.KV_URL,
            }
        });
    }
    try {
        const r = getRedis();
        await r.connect().catch(() => { });
        const pong = await r.ping();
        res.json({ ok: true, ping: pong });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        let users = await getUsers();

        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            id: Date.now().toString(),
            name,
            email: email.toLowerCase(),
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        await saveUsers(users);

        // Delete password from response
        const { password: _, ...userWithoutPassword } = newUser;
        res.json({ success: true, user: userWithoutPassword });

    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: err.message || 'Server error during registration' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const users = await getUsers();

        const user = users.find(u => u.email === email.toLowerCase());

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const { password: _, ...userWithoutPassword } = user;
        res.json({ success: true, user: userWithoutPassword });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message || 'Server error during login' });
    }
});

// ─── Clients ─────────────────────────────────────────────────────
// Disable the SDK's built-in retries (we run our own retry loop below) and give
// every request a hard timeout so a single hung upstream call can never stall an
// entire blog generation past Vercel's 300s function limit.
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder',
    maxRetries: 0,
    timeout: 120000,
});

// ─── Claude Retry Wrapper (handles 529 overloaded + 429 rate limit) ──
// `opts.timeoutMs` bounds each individual request; `opts.maxRetries` bounds how
// many times we retry transient overload/rate-limit/timeout failures. Callers can
// still pass a plain number as the 2nd arg for backwards compatibility.
async function callClaude(params, opts = {}) {
    if (typeof opts === 'number') opts = { maxRetries: opts };
    const { maxRetries = 3, timeoutMs = 120000 } = opts;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await anthropic.messages.create(params, { timeout: timeoutMs });
        } catch (err) {
            const status = err?.status || err?.error?.status || 0;
            const isTimeout = err?.name === 'APIConnectionTimeoutError' || /tim|ETIMEDOUT|ECONNRESET|socket hang up/i.test(err?.message || '');
            const isRetryable = status === 529 || status === 429 || isTimeout || (err.message && err.message.includes('overloaded'));
            if (isRetryable && attempt < maxRetries) {
                const delay = Math.min(8000 * Math.pow(2, attempt - 1), 30000); // 8s, 16s, 30s
                console.warn(`⚠ Claude ${status || (isTimeout ? 'timeout' : 'overloaded')} — retry ${attempt}/${maxRetries} in ${delay / 1000}s…`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
}

// OpenRouter client (for image generation)
const openrouter = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
    baseURL: 'https://openrouter.ai/api/v1',
});

// Perplexity client
const perplexity = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY || 'placeholder',
    baseURL: 'https://api.perplexity.ai',
});

// ─── Perplexity Research ─────────────────────────────────────────
async function runPerplexityResearch(keywords, description, customization = {}) {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey || apiKey === 'your_perplexity_api_key') {
        console.warn('⚠ Perplexity API key not set, skipping research');
        return null;
    }

    try {
        console.log('🔍 Running Perplexity deep SEO/GEO research…');

        const response = await perplexity.chat.completions.create({
            model: 'sonar',
            messages: [
                {
                    role: 'system',
                    content: `You are an elite SEO strategist, audience researcher, and Generative Engine Optimization (GEO) specialist. Your job is to produce a comprehensive research brief that will inform the creation of highly targeted, search-dominating blog content.

Your research must cover ALL of these areas:

## 1. TARGET AUDIENCE DEEP DIVE
- WHO is the exact target segment (job titles, company sizes, industries, demographics)
- What SPECIFIC PAIN POINTS they express in their own words on Reddit, X/Twitter, forums
- What LANGUAGE, PHRASES, and JARGON they use when discussing this problem
- What QUESTIONS they commonly ask (these become H2/H3 headings)
- What OBJECTIONS or SKEPTICISMS they have about existing solutions
- What EMOTIONAL triggers drive their decisions

## 2. SEMANTIC SEO & KEYWORD RESEARCH (NLP-first)
- Primary keyword (high volume, moderate competition)
- 5-10 secondary/long-tail keywords
- SYNONYM & WORD-FORM BANK (critical): for the primary keyword AND each major secondary keyword, list a rich set of synonyms, paraphrases, and natural word-form variants — different parts of speech and inflections (e.g. for "optimize": optimizing, optimization, optimized, fine-tune, streamline, improve, refine). The writer will use these to AVOID repeating the exact keyword and to write naturally.
- Semantically related terms & ENTITIES (people, brands, products, tools, places, concepts) that modern NLP models (Google BERT/MUM, Gemini) associate with this topic
- Question-based keywords ("how to…", "what is…", "why does…")
- Competitor keywords — what top-ranking articles target
- Search intent classification for each keyword (informational, navigational, transactional, commercial)

## 3. COMPETITOR CONTENT ANALYSIS
- What are the top 5 articles currently ranking for this topic?
- What do they cover well? What do they MISS?
- What content gaps can we exploit?
- Average word count of top-ranking content
- What headings/structure do top articles use?

## 4. GEO (GENERATIVE ENGINE OPTIMIZATION)
- What entities, brands, and authoritative sources should be mentioned to be cited by AI engines (ChatGPT, Perplexity, Google AI Overview)?
- What statistics and data points make content citation-worthy?
- What structured claims with evidence would AI engines extract as answers?
- What "definitive statements" should the article make to be selected as an AI-generated answer?

## 5. CONTENT STRUCTURE RECOMMENDATIONS
- Recommended H1 title (with primary keyword, under 60 chars)
- Recommended meta description (with primary keyword, under 155 chars)
- Suggested H2/H3 outline based on search intent and questions found
- Internal linking opportunities
- Recommended schema markup type (Article, HowTo, FAQ, etc.)

Format as a structured research brief with clear sections and bullet points. Include specific examples from Reddit/X posts where possible.`
                },
                {
                    role: 'user',
                    content: `Do comprehensive SEO and audience research for this blog topic: "${keywords}"
Additional context: ${description}
Target audience: ${customization.target || 'General'}
Product/service type: ${customization.product || 'General'}
Trend focus: ${customization.trends || 'None'}
Desired tone: ${customization.tone || 'Professional'}

Scan Reddit posts, X/Twitter discussions, Quora, industry forums, and top-ranking Google results.
Identify the exact search terms people use, the questions they ask, the pain points they express.
Analyze what the top 5 competing articles do well and what content gaps exist.
Provide a rich synonym & word-form bank for the main keywords (so the writer can vary language instead of repeating phrases), plus semantically related terms, entities, long-tail variations, and question-based keywords.
Include GEO optimization recommendations — what makes content get cited by AI engines.
Focus specifically on the ${customization.target || 'general'} audience and ${customization.product || 'general'} industry.
Be extremely specific and actionable.`
                }
            ],
            max_tokens: 4000,
        }, { timeout: 55000, maxRetries: 1 });

        const research = response.choices?.[0]?.message?.content;
        if (research) {
            console.log('✅ Perplexity SEO/GEO research complete');
            return research;
        }
        return null;
    } catch (err) {
        console.error('Perplexity error:', err.message);
        return null;
    }
}

// ─── Claude System Prompt ────────────────────────────────────────
function buildSystemPrompt(keywords, description, wordCount, researchInsights, imageUrls, customization = {}) {
    const researchBlock = researchInsights
        ? `\n\n═══ RESEARCH BRIEF (all research has already been completed for you — use it directly) ═══\n${researchInsights}\n═══ END RESEARCH BRIEF ═══\n\nYOU MUST USE THE RESEARCH ABOVE — do NOT guess, invent stats, or do your own research. Everything you need is in the brief above. Specifically:\n- Treat the FIRST item in the synonym bank (or the primary keyword) as the single FOCUS KEYPHRASE for this article\n- Use the EXACT focus keyphrase in: the H1, the first sentence of the intro (within the first 100 words), at least one H2/H3 subheading, the SEO title (at the very start), the meta description, the URL slug, and at least one image alt text\n- Use the exact focus keyphrase a few more times across the body so its density lands around 0.5–1.5% (roughly once every 200–300 words) — enough for Yoast to detect it, never so much it feels stuffed\n- Everywhere ELSE, reach for SYNONYMS, paraphrases, and varied WORD FORMS from the synonym bank instead of repeating the exact phrase. The focus keyphrase is the only term you may repeat verbatim; balancing exact keyphrase placement with synonym variety is what passes both the "keyphrase density" and "synonyms & word form recognition" SEO checks\n- Weave secondary/long-tail keywords and semantically related terms in naturally, ONLY where they genuinely fit the sentence — never force them\n- Keep keyword density low (~1-2%). Prioritize semantic variety and meaning over repetition. If any sentence sounds repetitive or keyword-stuffed when read aloud, rewrite it\n- Build topical authority by covering the related ENTITIES (brands, tools, people, concepts) from the research, not by repeating keywords\n- Turn question-based keywords into H2/H3 headings, rephrased in natural, human language rather than pasted verbatim\n- Echo the audience's real concerns and pain points, but paraphrase them in fresh wording instead of copying the same phrases over and over\n- Fill the content gaps identified in competitor analysis\n- Include the specific statistics, data points, and authoritative sources from the research for GEO optimization\n- Make definitive, citation-worthy statements that AI engines can extract\n`
        : '';

    // Build image injection instructions
    let imageBlock = '';
    if (imageUrls && imageUrls.length > 0) {
        imageBlock = `\n\nIMAGES AVAILABLE — INSERT THESE IN THE HTML:
You have ${imageUrls.length} images available. Insert them above or below the relevant section headings using full <img> tags.
Use these EXACT URLs:
${imageUrls.map((img, i) => `Image ${i + 1}: ${img.url} (alt: "${img.alt}")`).join('\n')}

Place them naturally throughout the article — one after each major H2 section heading.
Use this format: <img src="FULL_URL_HERE" alt="descriptive alt text" style="width:100%;height:auto;margin:32px 0;display:block;" />\n`;
    }

    return `You are a professional blog writer and world-class SEO copywriter. You have a completed research brief with real data, keywords, audience insights, and competitor analysis. Your job is to USE that research to write a stunning, fully styled HTML blog post optimized for WordPress.

Do NOT make up statistics or data — everything you need is in the research brief provided below.

TOPIC: ${keywords}
CONTEXT: ${description}
TARGET WORD COUNT: ${wordCount} words
TARGET AUDIENCE: ${customization.target || 'General'}
PRODUCT/SERVICE: ${customization.product || 'General'}
TRENDS FOCUS: ${customization.trends || 'None'}
TONE: ${customization.tone || 'Professional'}

CONTENT CUSTOMIZATION RULES:
- Write specifically for the ${customization.target || 'general'} audience — use their language, address their pain points, reference their world
- Frame all examples and use cases around the ${customization.product || 'general'} industry
- ${customization.trends && customization.trends !== 'None' ? `Weave in the "${customization.trends}" trend throughout — show how it impacts the topic and what readers should do about it` : 'Focus on evergreen, timeless advice'}
- Maintain a ${customization.tone || 'professional'} tone throughout the entire article
${researchBlock}${imageBlock}
STRICT OUTPUT RULES — YOU MUST FOLLOW THESE EXACTLY:

1. Output ONLY valid, clean HTML — no markdown, no escape characters, no control characters, no code fences.
2. Wrap the entire blog in: <div style="max-width:780px;margin:0 auto;padding:40px 20px;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#333;line-height:1.8;font-size:17px;">

3. HEADING STYLES:
   - H1 (title): <h1 style="font-family:'Montserrat',sans-serif;color:#FF8300;font-size:2.4em;font-weight:800;line-height:1.2;margin-bottom:24px;">
   - H2 (sections): <h2 style="font-family:'Montserrat',sans-serif;color:#FF8300;font-size:1.8em;font-weight:700;margin-top:56px;margin-bottom:20px;">
   - H3 (sub-sections): <h3 style="font-family:'Montserrat',sans-serif;font-size:1.3em;font-weight:700;color:#1a1a1a;margin-top:40px;margin-bottom:16px;padding-left:16px;border-left:4px solid #FF8300;">

4. BODY TEXT: <p style="font-family:'Inter',sans-serif;margin-bottom:20px;">

5. SPECIAL CALLOUT BADGES (use these throughout):
   - <span style="display:inline-block;background:#FF8300;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Result:</span>
   - <span style="display:inline-block;background:#FF8300;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Pro tip:</span>
   - <span style="display:inline-block;background:#FF8300;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Case in point:</span>

6. BENEFIT LABELS: <strong style="color:#FF8300;">Label text:</strong> followed by text

7. LISTS:
   - <ul style="margin-bottom:24px;padding-left:28px;"> with <li style="margin-bottom:8px;">
   - <ol> for numbered sequences

8. IMAGES: Insert the provided images using full <img> tags with the URLs provided above. Place one image after each major H2 heading.

9. BLOCKQUOTES: <blockquote style="border-left:4px solid #FF8300;background:#fff7ed;padding:16px 24px;margin:24px 0;font-style:italic;color:#92400e;">

10. CTA SECTION at the end: <div style="margin-top:56px;padding-top:32px;border-top:2px solid #FF8300;"> with an orange H2 heading inside.

11. HORIZONTAL RULES between major sections: <hr style="border:none;height:1px;background:#e5e5e5;margin:48px 0;">

CONTENT OBJECTIVES:
- Start with a strong, curiosity-driven H1 headline
- Write an introduction that hooks the reader by addressing their pain points
- Structure the post as a journey using storytelling patterns
- Include real examples, data, and demonstrations
- Write for the skeptical reader — justify every claim
- End with a clear CTA section that feels earned
- Make the tone conversational, confident, and human

NATURAL LANGUAGE & READABILITY — write for a human first, the algorithm second:
- Vary your vocabulary. Never repeat the same keyword or noun phrase sentence after sentence — swap in synonyms, paraphrases, and different word forms (e.g. "boost / improve / lift / strengthen" instead of "improve, improve, improve").
- Vary sentence length and rhythm. Mix short, punchy sentences with longer flowing ones so the prose reads like a skilled human writer, not a template.
- Use natural transitions and connective phrases between ideas so the article flows instead of feeling like a keyword checklist.
- Prefer plain, conversational language. Use contractions, address the reader as "you", and avoid stiff, robotic phrasing.
- Read every sentence aloud in your head — if it sounds repetitive, stuffed, or unnatural, rewrite it.
- Demonstrate topical depth through related concepts and entities, not through keyword frequency.
- Avoid AI-tell phrases and filler ("In today's fast-paced world", "It's important to note", "When it comes to", "In conclusion"). Get specific instead.

FOCUS KEYPHRASE & ON-PAGE SEO (these make the post pass Yoast-style SEO analysis — follow ALL of them):
- Choose ONE short focus keyphrase (2-4 words, the main thing this article is about). Use this SAME keyphrase consistently everywhere below.
- H1: must contain the EXACT focus keyphrase.
- INTRODUCTION: the very first <p> must contain the EXACT focus keyphrase, ideally in the first sentence.
- SUBHEADINGS: at least one H2 or H3 must contain the EXACT focus keyphrase (others may use synonyms).
- DENSITY: the exact focus keyphrase should appear naturally a handful of times in the body (~0.5–1.5% density). Use synonyms and word forms for all other mentions.
- OUTBOUND LINKS: include 2-4 contextual outbound links to authoritative EXTERNAL sources (studies, official docs, reputable publications, the named entities/sources from the research brief). Format: <a href="https://full-real-url" target="_blank" rel="noopener noreferrer" style="color:#FF8300;text-decoration:underline;font-weight:600;">descriptive anchor text</a>. Only link to real, well-known URLs — never invent links. Anchor text must be descriptive, never "click here".
- IMAGE ALT: when you reference images later, alt text should include the focus keyphrase or a close synonym (image tags are added separately, so just keep alt-friendly section headings).

SEO META — Include these as HTML comments at the very top BEFORE the blog div (the focus keyphrase MUST appear at the START of the SEO title, inside the meta description, and inside the slug):
<!-- FOCUS_KEYPHRASE: your 2-4 word focus keyphrase -->
<!-- SEO_TITLE: Focus keyphrase first, then the rest — max 60 chars -->
<!-- META_DESC: One compelling sentence containing the focus keyphrase — max 155 chars -->
<!-- SLUG: focus-keyphrase-based-url-slug-lowercase-hyphenated -->
<!-- SEO_KEYWORDS: focus keyphrase, secondary keyword, synonym, related term -->

Preserve all apostrophes, quotes, em dashes, and punctuation properly. No Unicode junk. Make it STUNNING.`;
}

// ─── Gemini Nano Banana Image Generation ─────────────────────────
async function generateImageWithGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'placeholder') {
        console.warn('⚠ Gemini API key not set, skipping image generation');
        return null;
    }

    const models = [
        'gemini-2.5-flash-image',
        'gemini-3.1-flash-image-preview',
        'gemini-3-pro-image-preview',
    ];

    const TIMEOUT_MS = 60000; // 60-second timeout per model attempt

    for (const model of models) {
        try {
            console.log(`   Trying Gemini model: ${model}`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }],
                    }],
                    generationConfig: {
                        responseModalities: ['IMAGE', 'TEXT'],
                    },
                }),
                signal: controller.signal,
            });

            clearTimeout(timer);

            if (!response.ok) {
                const errText = await response.text();
                console.error(`   Gemini ${model} HTTP ${response.status}: ${errText.slice(0, 300)}`);
                continue;
            }

            const data = await response.json();
            const parts = data.candidates?.[0]?.content?.parts;
            if (!parts) {
                console.log(`   Gemini ${model} returned no parts`);
                continue;
            }

            for (const part of parts) {
                if (part.inlineData?.data && part.inlineData?.mimeType) {
                    console.log(`   ✅ Got image from Gemini ${model} (${part.inlineData.mimeType}, ${part.inlineData.data.length} chars base64)`);
                    return {
                        buffer: Buffer.from(part.inlineData.data, 'base64'),
                        mimeType: part.inlineData.mimeType,
                        alt: prompt,
                    };
                }
            }

            console.log(`   Gemini ${model} returned no image data in parts`);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`   ⏱ Gemini ${model} timed out after ${TIMEOUT_MS / 1000}s — skipping`);
            } else {
                console.error(`   Gemini ${model} error: ${err.message}`);
            }
        }
    }

    console.warn('⚠ All Gemini models failed — returning null (blog will generate without this image)');
    return null;
}

// ─── Generate Image via OpenRouter (FLUX) ─────────────────────────
async function generateImageWithOpenRouter(prompt) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your_openrouter_api_key' || apiKey === 'placeholder') {
        console.warn('⚠ OpenRouter API key not set, skipping image generation');
        return null;
    }

    const TIMEOUT_MS = 60000; // hard timeout so a hung request can't stall the whole generation
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        console.log('   Trying OpenRouter image generation...');
        const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'openai/dall-e-3',
                prompt,
                n: 1,
                size: '1792x1024',
                response_format: 'b64_json',
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            const errText = await response.text();
            console.error(`   OpenRouter image HTTP ${response.status}: ${errText.slice(0, 300)}`);
            return null;
        }

        const data = await response.json();
        if (data.data?.[0]?.b64_json) {
            console.log('   ✅ Got image from OpenRouter');
            return {
                buffer: Buffer.from(data.data[0].b64_json, 'base64'),
                mimeType: 'image/png',
                alt: prompt,
            };
        }
        // Fallback: URL-based response
        if (data.data?.[0]?.url) {
            console.log('   ✅ Got image URL from OpenRouter, fetching...');
            const imgRes = await fetch(data.data[0].url);
            const imgBuf = Buffer.from(await imgRes.arrayBuffer());
            return { buffer: imgBuf, mimeType: 'image/png', alt: prompt };
        }

        console.log('   OpenRouter returned no image data');
        return null;
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            console.error(`   ⏱ OpenRouter timed out after ${TIMEOUT_MS / 1000}s — skipping`);
        } else {
            console.error('   OpenRouter image error:', err.message);
        }
        return null;
    }
}

// ─── Generate Image via Fal.ai (FLUX) ────────────────────────────
async function generateImageWithFal(prompt, options = {}) {
    const falKey = process.env.FAL_KEY;
    if (!falKey) {
        console.warn('⚠ FAL_KEY not set, skipping Fal.ai image generation');
        return null;
    }

    const model = options.model || 'fal-ai/flux/schnell';
    const TIMEOUT_MS = options.timeoutMs || 45000;

    try {
        console.log(`   Trying Fal.ai model: ${model}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(`https://fal.run/${model}`, {
            method: 'POST',
            headers: {
                Authorization: `Key ${falKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                prompt,
                image_size: options.imageSize || { width: 1280, height: 720 },
                num_inference_steps: options.inferenceSteps || 4,
                enable_safety_checker: true,
            }),
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            const errText = await response.text();
            console.error(`   Fal.ai HTTP ${response.status}: ${errText.slice(0, 300)}`);
            return null;
        }

        const data = await response.json();
        const imageUrl = data.images?.[0]?.url || data.image?.url;
        if (!imageUrl) {
            console.log('   Fal.ai returned no image URL');
            return null;
        }

        console.log('   ✅ Got image from Fal.ai');
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) {
            console.error(`   Failed to download Fal.ai image: HTTP ${imgRes.status}`);
            return null;
        }

        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        return {
            buffer: imgBuf,
            mimeType: imgRes.headers.get('content-type') || 'image/png',
            alt: prompt,
            url: imageUrl,
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`   ⏱ Fal.ai timed out after ${TIMEOUT_MS / 1000}s — skipping`);
        } else {
            console.error('   Fal.ai image error:', err.message);
        }
        return null;
    }
}

// ─── Helper: resolve null if a promise takes too long ────────────
function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]).finally(() => clearTimeout(timer));
}

// ─── Generate image with fallback chain ──────────────────────────
async function generateImageWithFallback(prompt, options = {}) {
    let img = await generateImageWithFal(prompt, options);
    if (img) return img;
    img = await generateImageWithOpenRouter(prompt);
    if (img) return img;
    return generateImageWithGemini(prompt);
}

async function generateBlogImage(prompt) {
    const wrappedPrompt = `Professional photorealistic blog image: ${prompt}. High quality, cinematic lighting, editorial style. No text, no watermarks, no logos. Premium stock photo quality.`;
    return generateImageWithFallback(wrappedPrompt);
}

async function generateOnePagerImage(prompt) {
    const wrappedPrompt = `Professional marketing banner: ${prompt}. Clean modern corporate design, premium quality, no text, no watermarks, no logos.`;
    return generateImageWithFallback(wrappedPrompt, {
        imageSize: { width: 1792, height: 1024 },
    });
}

function injectImagesIntoBlogHtml(htmlContent, uploadedImages, h2Matches, sectionTitles, focusKeyphrase = '') {
    if (!uploadedImages.length) return htmlContent;

    const imgStyle = 'width:100%;height:auto;margin:32px 0 24px;display:block;border-radius:12px;';
    const kp = (focusKeyphrase || '').replace(/"/g, '').trim();
    // Yoast wants the keyphrase (or a synonym) in image alt text — build descriptive, keyphrase-aware alts.
    const buildAlt = (sectionTitle, image, index) => {
        const base = (sectionTitle || image.alt || '').replace(/<[^>]+>/g, '').replace(/"/g, '').trim();
        if (!kp) return base || `Blog image ${index + 1}`;
        if (!base) return index === 0 ? kp : `${kp} — illustration ${index + 1}`;
        return base.toLowerCase().includes(kp.toLowerCase()) ? base : `${base} — ${kp}`;
    };
    const buildImgTag = (image, sectionTitle, index) =>
        `\n<img src="${image.url}" alt="${buildAlt(sectionTitle, image, index)}" style="${imgStyle}" />\n`;

    if (h2Matches.length > 0) {
        const insertionPoints = [];
        for (let i = 0; i < Math.min(uploadedImages.length, h2Matches.length); i++) {
            const h2End = h2Matches[i].index + h2Matches[i][0].length;
            insertionPoints.push({ position: h2End, image: uploadedImages[i], sectionTitle: sectionTitles[i], index: i });
        }

        let updatedHtml = htmlContent;
        for (let i = insertionPoints.length - 1; i >= 0; i--) {
            const { position, image, sectionTitle, index } = insertionPoints[i];
            updatedHtml = updatedHtml.slice(0, position) + buildImgTag(image, sectionTitle, index) + updatedHtml.slice(position);
        }
        console.log(`🖼 Injected ${insertionPoints.length} images into blog HTML after H2 headings`);
        return updatedHtml;
    }

    const unusedImages = uploadedImages.slice();
    let updatedHtml = htmlContent;

    const h1Match = updatedHtml.match(/<h1[^>]*>[\s\S]*?<\/h1>/i);
    if (h1Match) {
        const insertPos = h1Match.index + h1Match[0].length;
        const imgTags = unusedImages.map((image, index) => buildImgTag(image, sectionTitles[index], index)).join('');
        updatedHtml = updatedHtml.slice(0, insertPos) + imgTags + updatedHtml.slice(insertPos);
        console.log(`🖼 Injected ${unusedImages.length} images into blog HTML after H1 (no H2 headings found)`);
        return updatedHtml;
    }

    const divMatch = updatedHtml.match(/<div[^>]*>/i);
    if (divMatch) {
        const insertPos = divMatch.index + divMatch[0].length;
        const imgTags = unusedImages.map((image, index) => buildImgTag(image, sectionTitles[index], index)).join('');
        updatedHtml = updatedHtml.slice(0, insertPos) + imgTags + updatedHtml.slice(insertPos);
        console.log(`🖼 Injected ${unusedImages.length} images into blog HTML at content start (no headings found)`);
        return updatedHtml;
    }

    const imgTags = unusedImages.map((image, index) => buildImgTag(image, sectionTitles[index], index)).join('');
    console.log(`🖼 Appended ${unusedImages.length} images to blog HTML`);
    return updatedHtml + imgTags;
}

// ─── Upload Image to WordPress Media Library ─────────────────────
async function uploadImageToWordPress(imageData, altText, filename) {
    const wpUrl = process.env.WORDPRESS_URL;
    const wpUser = process.env.WORDPRESS_USERNAME;
    const wpPass = process.env.WORDPRESS_APP_PASSWORD;

    if (!wpUrl || !wpUser || !wpPass) return null;

    try {
        let buffer;
        let contentType = 'image/png';

        if (imageData.buffer) {
            buffer = imageData.buffer;
            contentType = imageData.mimeType || 'image/png';
        } else if (imageData.url) {
            const imgResponse = await fetch(imageData.url);
            if (!imgResponse.ok) throw new Error('Failed to download image');
            const imgArrayBuffer = await imgResponse.arrayBuffer();
            buffer = Buffer.from(imgArrayBuffer);
            contentType = imgResponse.headers.get('content-type') || 'image/png';
        } else {
            return null;
        }

        const credentials = Buffer.from(`${wpUser}:${wpPass}`).toString('base64');
        const slug = filename || `blog-image-${Date.now()}`;
        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';

        const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${credentials}`,
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${slug}.${ext}"`,
            },
            body: buffer,
        });

        if (!wpRes.ok) {
            const errText = await wpRes.text();
            console.error(`WP media upload error: ${errText}`);
            return null;
        }

        const media = await wpRes.json();
        console.log(`📸 Image uploaded to WordPress: ${media.source_url}`);

        return {
            id: media.id,
            url: media.source_url,
            alt: altText,
        };
    } catch (err) {
        console.error('WP image upload error:', err.message);
        return null;
    }
}

// ─── Slugify a string into a URL-safe slug ───────────────────────
function slugify(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/<[^>]+>/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 75)
        .replace(/-+$/g, '');
}

// ─── Parse SEO meta from HTML content ────────────────────────────
function parseSeoMeta(content, fallbackKeyphrase = '') {
    const seoTitle = content.match(/<!--\s*SEO_TITLE:\s*(.+?)\s*-->/)?.[1] || '';
    let metaDesc = content.match(/<!--\s*META_DESC:\s*(.+?)\s*-->/)?.[1] || '';
    const seoKeywords = content.match(/<!--\s*SEO_KEYWORDS:\s*(.+?)\s*-->/)?.[1]?.split(',').map(k => k.trim()).filter(Boolean) || [];

    // Focus keyphrase: explicit comment → first SEO keyword → caller fallback
    const focusKeyphrase = (content.match(/<!--\s*FOCUS_KEYPHRASE:\s*(.+?)\s*-->/)?.[1] || seoKeywords[0] || fallbackKeyphrase || '').trim();

    // Slug: explicit comment → slugified focus keyphrase
    const rawSlug = content.match(/<!--\s*SLUG:\s*(.+?)\s*-->/)?.[1] || '';
    const slug = slugify(rawSlug || focusKeyphrase);

    // Yoast flags meta descriptions over 156 chars — keep it tight (≤155), cut on a word boundary.
    if (metaDesc.length > 155) {
        metaDesc = metaDesc.slice(0, 155);
        const lastSpace = metaDesc.lastIndexOf(' ');
        if (lastSpace > 120) metaDesc = metaDesc.slice(0, lastSpace);
        metaDesc = metaDesc.replace(/[\s,;:.\-]+$/, '');
    }

    return { seoTitle, metaDesc, seoKeywords, focusKeyphrase, slug };
}

// ─── Fetch existing published posts (the blog "network") for internal linking ──
async function fetchWordPressPosts(limit = 50) {
    const wpUrl = process.env.WORDPRESS_URL;
    if (!wpUrl) return [];
    try {
        const url = `${wpUrl}/wp-json/wp/v2/posts?status=publish&per_page=${Math.min(limit, 100)}&_fields=id,link,slug,title,excerpt`;
        const headers = {};
        // Auth is optional for public posts, but include it if available (lets us see more).
        if (process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD) {
            headers.Authorization = `Basic ${Buffer.from(`${process.env.WORDPRESS_USERNAME}:${process.env.WORDPRESS_APP_PASSWORD}`).toString('base64')}`;
        }
        const r = await withTimeout(fetch(url, { headers }), 12000);
        if (!r || !r.ok) return [];
        const posts = await r.json();
        return (Array.isArray(posts) ? posts : []).map(p => ({
            id: p.id,
            url: p.link,
            slug: p.slug,
            title: (p.title?.rendered || '').replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').trim(),
            excerpt: (p.excerpt?.rendered || '').replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        })).filter(p => p.url && p.title);
    } catch (err) {
        console.error('fetchWordPressPosts error:', err.message);
        return [];
    }
}

// ─── Insert internal links to existing network posts (SEO interlinking) ───────
async function insertNetworkLinks(htmlContent, { focusKeyphrase = '', internalTargets = [] } = {}) {
    if (!internalTargets || internalTargets.length === 0) return htmlContent;

    // Cap the catalog we send to the model so the prompt stays lean.
    const catalog = internalTargets.slice(0, 25);
    const catalogList = catalog
        .map((t, i) => `${i + 1}. "${t.title}" → ${t.url}${t.excerpt ? `\n   (about: ${t.excerpt})` : ''}`)
        .join('\n');

    try {
        const resp = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            temperature: 0.3,
            messages: [{
                role: 'user',
                content: `You are an SEO interlinking specialist building a connected network of blog posts.

Below is an HTML blog post (focus keyphrase: "${focusKeyphrase}"). Underneath it is a CATALOG of OTHER existing posts on the same site.

Your job: analyze the article and insert contextually relevant INTERNAL links to the most topically related posts in the catalog. This builds a strong internal link network for SEO.

STRICT RULES:
- Insert between 2 and 5 internal links total (only as many as are genuinely relevant — quality over quantity).
- Link from words/phrases that ALREADY EXIST in the body paragraphs, choosing anchor text that is descriptive and naturally matches the target post's topic.
- Wrap the chosen existing anchor text like: <a href="TARGET_URL" style="color:#FF8300;text-decoration:underline;font-weight:600;">existing anchor text</a>
- Use each target URL at most ONCE. Do not link the same phrase twice.
- Only link where it makes real editorial sense (the linked post genuinely expands on that phrase). If fewer than 2 are genuinely relevant, add fewer (or none).
- Do NOT add links inside headings (h1-h3), inside existing <a> tags, inside image alt text, or inside the SEO comment block.
- Do NOT change, add, or remove ANY other text, HTML tags, attributes, inline styles, images, or SEO comments. Preserve the document EXACTLY except for the inserted <a> wrappers.
- Output ONLY the full, updated HTML — no markdown, no code fences, no commentary.

CATALOG OF EXISTING POSTS:
${catalogList}

HTML ARTICLE TO ADD INTERNAL LINKS TO:
${htmlContent}`,
            }],
        }, { timeoutMs: 90000, maxRetries: 1 });

        let out = resp.content[0].text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
        // Safety: only accept the rewrite if it still looks like the same document (kept the wrapper) and actually added a link.
        if (out.includes('<div') && out.length > htmlContent.length * 0.7 && /<a\s+href=/i.test(out)) {
            const added = (out.match(/<a\s+href=/gi) || []).length - (htmlContent.match(/<a\s+href=/gi) || []).length;
            console.log(`🔗 Inserted ${Math.max(added, 0)} internal network link(s)`);
            return out;
        }
        console.warn('⚠ Internal-link pass produced unexpected output — keeping original HTML');
        return htmlContent;
    } catch (err) {
        console.error('insertNetworkLinks error:', err.message);
        return htmlContent;
    }
}

// ─── POST /api/generate (SSE progress streaming) ────────────────
app.post('/api/generate', async (req, res) => {
    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    function sendProgress(step, total, message) {
        res.write(`data: ${JSON.stringify({ type: 'progress', step, total, message })}\n\n`);
    }

    function sendResult(data) {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'result', ...data })}\n\n`);
        res.end();
    }

    let finished = false;
    function sendError(error) {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.end();
    }

    // Track client disconnects so we stop doing expensive work for a dead socket.
    let clientGone = false;
    req.on('close', () => { clientGone = true; });

    // Global time budget. Vercel kills the function at maxDuration (300s); we finish
    // well before that so the client always receives a terminal `result`/`error`
    // event instead of a silently dropped connection (which would hang the UI).
    const genStart = Date.now();
    const GEN_DEADLINE_MS = 285000;
    const timeLeft = () => GEN_DEADLINE_MS - (Date.now() - genStart);

    // Heartbeat comment keeps intermediary proxies from dropping an idle SSE stream
    // during long LLM calls.
    const heartbeat = setInterval(() => {
        if (!finished) { try { res.write(': keep-alive\n\n'); } catch { /* socket closed */ } }
    }, 15000);

    try {
        const { keywords, description, wordCount, target, product, trends, tone, language } = req.body;
        const parsedImageCount = parseInt(req.body.imageCount);
        const imageCount = Math.min(Math.max(isNaN(parsedImageCount) ? 3 : parsedImageCount, 0), 5);
        // Steps: research(1) + write(2) + [analyze + N images if N>0] + insert + SEO + [Spanish] + blogReady
        const hasImages = imageCount > 0;
        const hasSpanish = (language === 'both' || language === 'spanish');
        // insertStep: the step # for "Inserting images". With images: 4+imageCount. Without: 3.
        const insertStep = hasImages ? (4 + imageCount) : 3;
        const TOTAL_STEPS = insertStep + 1 + (hasSpanish ? 1 : 0) + 1; // +1 SEO, +1 spanish?, +1 blogReady

        if (!keywords || !description || !wordCount) {
            return sendError('Missing required fields: keywords, description, wordCount');
        }

        // Map tone dropdown value to readable label
        const toneLabels = { professional: 'Professional', conversational: 'Conversational', authoritative: 'Authoritative & Expert', friendly: 'Friendly & Approachable', bold: 'Bold & Provocative', educational: 'Educational / Tutorial', storytelling: 'Storytelling / Narrative', data_driven: 'Data-Driven & Analytical' };

        const customization = {
            target: target || '',
            product: product || '',
            trends: trends || '',
            tone: toneLabels[tone] || tone || 'Professional',
        };

        console.log(`\n🚀 Generating blog: "${keywords}" (~${wordCount} words) [${customization.target} | ${customization.tone} | lang: ${language || 'english'}]`);

        // Step 1: Perplexity research
        sendProgress(1, TOTAL_STEPS, 'Researching target audience & SEO keywords…');
        const researchInsights = await runPerplexityResearch(keywords, description, customization);
        if (researchInsights) {
            console.log(`📊 Research insights received (${researchInsights.length} chars)`);
        }

        // Step 2: Write blog first (no images)
        sendProgress(2, TOTAL_STEPS, 'Writing SEO-optimized blog with Claude…');
        const systemPrompt = buildSystemPrompt(keywords, description, wordCount, researchInsights, [], customization);

        const message = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            temperature: 0.85,
            messages: [
                {
                    role: 'user',
                    content: `Write the blog post now as valid, styled HTML. Make it approximately ${wordCount} words. Topic: ${keywords}. Context: ${description}.${language === 'spanish' ? ' IMPORTANT: Write the ENTIRE blog in Spanish. All headings, body text, callout badges, CTA — everything must be in Spanish.' : ' IMPORTANT: Write the ENTIRE blog in ENGLISH. Even if the topic, keywords, or description are provided in another language (e.g. Spanish), you MUST write the blog entirely in English. All headings, body text, callout badges, CTA — everything must be in English.'} Write naturally and conversationally: vary your sentence length, use synonyms and different word forms instead of repeating the same keyword, and make every paragraph flow into the next. Do not keyword-stuff. Remember: output ONLY the HTML, no markdown, no code fences. Do NOT include any <img> tags — images will be added separately.`,
                },
            ],
            system: systemPrompt,
        }, { timeoutMs: 120000, maxRetries: 2 });

        let htmlContent = message.content[0].text;
        htmlContent = htmlContent.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

        // Parse SEO meta up-front so the focus keyphrase can drive image alt text + internal links.
        const seo = parseSeoMeta(htmlContent, keywords);
        const focusKeyphrase = seo.focusKeyphrase || (keywords || '').split(',')[0].trim();
        console.log(`🎯 Focus keyphrase: "${focusKeyphrase}" | slug: "${seo.slug}"`);

        // Step 3: Analyze blog sections and create image prompts
        if (imageCount > 0) {
            sendProgress(3, TOTAL_STEPS, 'Analyzing blog sections for image generation…');
        }

        // Extract H2 headings from the blog
        const h2Matches = [...htmlContent.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)];
        const sectionTitles = h2Matches.map(m => m[1].replace(/<[^>]+>/g, '').trim());

        let imagePrompts = [];
        if (imageCount > 0 && sectionTitles.length >= imageCount) {
            // Use Claude to create context-specific prompts from the actual blog sections
            try {
                const promptGenResponse = await callClaude({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: `Below are the H2 section headings from a blog about "${keywords}" for ${customization.target || 'business professionals'} in the ${customization.product || 'general'} space:

${sectionTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Create exactly ${imageCount} image generation prompts — one for each of the first ${imageCount} sections. Each prompt must be a highly detailed, photorealistic image description that visually represents that specific section's content. 

Rules:
- Each prompt must be unique and specific to its section
- Describe the scene, lighting, composition, subjects, and setting
- No text, logos, or watermarks in the images
- Professional, editorial quality
- Each prompt should be 1-2 sentences max

Return ONLY a JSON array of ${imageCount} strings, nothing else. Example: ["prompt 1", "prompt 2"]`,
                    }],
                }, { timeoutMs: 30000, maxRetries: 1 });

                try {
                    const raw = promptGenResponse.content[0].text.trim();
                    imagePrompts = JSON.parse(raw);
                    // Ensure we don't exceed requested count
                    imagePrompts = imagePrompts.slice(0, imageCount);
                } catch {
                    console.log('Could not parse image prompts JSON, using fallback');
                }
            } catch (err) {
                console.error('Image prompt generation error:', err.message);
            }
        }

        // Fallback prompts if Claude analysis failed or too few sections
        if (imageCount > 0 && imagePrompts.length < imageCount) {
            const topicContext = `${keywords}${customization.product ? ' for ' + customization.product : ''}`;
            const fallbacks = [
                `Ultra-realistic hero image for a blog about "${topicContext}". Wide-angle cinematic composition. Modern, sleek environment with dramatic lighting. No text, no watermarks. Editorial quality.`,
                `Close-up photograph showing tools, technology, or concepts related to "${keywords}" that ${customization.target || 'professionals'} use. Shallow depth of field, studio-quality. No text, no logos.`,
                `Diverse ${customization.target || 'professionals'} working with ${customization.product || 'modern solutions'} related to "${keywords}". Natural lighting, authentic energy. No text or watermarks.`,
                `Aerial or overhead view of a workspace related to "${keywords}". Clean, organized layout with modern technology. Bright, natural lighting. No text.`,
                `Abstract visualization of innovation and progress in "${keywords}". Dynamic composition with depth and dimension. Professional editorial quality. No text.`,
            ];
            imagePrompts = fallbacks.slice(0, imageCount);
        }

        // Step 4-6: Generate images (Fal.ai → OpenRouter → Gemini)
        const uploadedImages = [];
        const hasWpCredentials = process.env.WORDPRESS_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD;

        // Time budgets so the blog ALWAYS finishes, even if an image provider stalls.
        // Vercel maxDuration is 300s — leave room for research/writing/translation.
        const PER_IMAGE_TIMEOUT_MS = 60000;
        const IMAGE_TOTAL_BUDGET_MS = 130000;
        // Reserve time for the remaining steps (insert + SEO + optional Spanish).
        const IMAGE_RESERVE_MS = language === 'both' ? 120000 : 40000;
        const imageLoopStart = Date.now();

        for (let i = 0; i < imagePrompts.length; i++) {
            if (clientGone) { console.warn('⏹ Client disconnected — aborting image generation'); break; }
            if (Date.now() - imageLoopStart > IMAGE_TOTAL_BUDGET_MS) {
                console.warn(`⏱ Image time budget exceeded — skipping remaining ${imagePrompts.length - i} image(s) so the blog can finish`);
                break;
            }
            if (timeLeft() < IMAGE_RESERVE_MS) {
                console.warn(`⏱ Global deadline approaching (${Math.round(timeLeft() / 1000)}s left) — skipping remaining ${imagePrompts.length - i} image(s) so the blog can finish`);
                break;
            }
            sendProgress(4 + i, TOTAL_STEPS, `Generating image ${i + 1} of ${imagePrompts.length} for section: "${sectionTitles[i] || 'blog'}"…`);
            console.log(`🎨 Image ${i + 1}/${imagePrompts.length}: "${imagePrompts[i].slice(0, 80)}…"`);
            const img = await withTimeout(generateBlogImage(imagePrompts[i]), PER_IMAGE_TIMEOUT_MS);
            if (img) {
                if (hasWpCredentials) {
                    console.log(`📤 Uploading image ${i + 1} to WordPress…`);
                    const wpImage = await uploadImageToWordPress(img, imagePrompts[i], `blog-${Date.now()}-${i}`);
                    if (wpImage) {
                        uploadedImages.push(wpImage);
                        continue;
                    }
                }
                // If no WP or upload failed, create a data URL
                if (img.buffer) {
                    const dataUrl = `data:${img.mimeType};base64,${img.buffer.toString('base64')}`;
                    uploadedImages.push({ url: dataUrl, alt: img.alt });
                } else if (img.url) {
                    uploadedImages.push({ url: img.url, alt: img.alt });
                }
            }
        }

        console.log(`✅ ${uploadedImages.length} images generated`);
        if (imageCount > 0 && uploadedImages.length === 0) {
            console.warn(`⚠ No blog images were generated (requested ${imageCount}). Check FAL_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY.`);
        } else if (imageCount > 0 && uploadedImages.length < imageCount) {
            console.warn(`⚠ Only ${uploadedImages.length}/${imageCount} blog images were generated.`);
        }

        // Step after images: Inject images into blog HTML (alt text carries the focus keyphrase for SEO)
        sendProgress(insertStep, TOTAL_STEPS, 'Inserting images into blog…');
        htmlContent = injectImagesIntoBlogHtml(htmlContent, uploadedImages, h2Matches, sectionTitles, focusKeyphrase);

        // Internal linking step: weave this post into the existing blog network for SEO.
        // This re-emits the whole document through Claude, so only run it when there's
        // comfortable time left (Spanish, if requested, needs the remaining budget).
        const linkReserveMs = language === 'both' ? 150000 : 70000;
        if (timeLeft() < linkReserveMs) {
            console.log(`🔗 Skipping internal linking — ${Math.round(timeLeft() / 1000)}s left, reserving time to finish the blog`);
        } else {
            try {
                sendProgress(insertStep, TOTAL_STEPS, 'Linking to your blog network…');
                const networkPosts = await fetchWordPressPosts(50);
                const internalTargets = networkPosts.filter(p => p.slug !== seo.slug);
                if (internalTargets.length > 0) {
                    console.log(`🔗 Found ${internalTargets.length} existing post(s) for internal linking`);
                    htmlContent = await insertNetworkLinks(htmlContent, { focusKeyphrase, internalTargets });
                } else {
                    console.log('🔗 No existing network posts found — skipping internal linking');
                }
            } catch (linkErr) {
                console.error('Internal linking step failed (non-fatal):', linkErr.message);
            }
        }

        // SEO step
        sendProgress(insertStep + 1, TOTAL_STEPS, 'Extracting SEO metadata…');
        console.log(`📝 SEO Title: ${seo.seoTitle} | Focus: "${focusKeyphrase}"`);

        const titleMatch = htmlContent.match(/<h1[^>]*>(.+?)<\/h1>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : seo.seoTitle || keywords;

        // Spanish translation step (if language is 'both')
        let spanishHtmlContent = null;
        let spanishTitle = null;

        if (language === 'both' && timeLeft() < 45000) {
            console.warn(`⏱ Not enough time left (${Math.round(timeLeft() / 1000)}s) for Spanish translation — returning the English blog so generation still completes.`);
        } else if (language === 'both') {
            sendProgress(insertStep + 2, TOTAL_STEPS, 'Translating blog to Spanish…');
            console.log('🌐 Translating blog to Spanish…');

            try {
                const translationResponse = await callClaude({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 8192,
                    messages: [{
                        role: 'user',
                        content: `Translate the following HTML blog post to Spanish.

The blog content below may be in English or possibly already partially in another language. Regardless of the input language:
- Your output MUST be 100% in Spanish
- ALL visible text content must be in Spanish (headings, paragraphs, list items, blockquotes, CTA text, button text, callout badges)

CRITICAL RULES:
- DO NOT change any HTML tags, attributes, styles, class names, or structure
- DO NOT change any image URLs or image alt attributes
- DO NOT change any inline CSS styles
- Keep all <!-- SEO comments --> but translate their content to Spanish
- The translation must be natural, fluent Spanish — not word-for-word translation
- Maintain the same tone and energy as the original
- Output ONLY the translated HTML, nothing else

Here is the HTML to translate:

${htmlContent}`,
                    }],
                }, { timeoutMs: Math.max(30000, Math.min(110000, timeLeft() - 8000)), maxRetries: 1 });

                spanishHtmlContent = translationResponse.content[0].text;
                spanishHtmlContent = spanishHtmlContent.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

                // Extract Spanish title
                const spanishTitleMatch = spanishHtmlContent.match(/<h1[^>]*>(.+?)<\/h1>/i);
                spanishTitle = spanishTitleMatch ? spanishTitleMatch[1].replace(/<[^>]+>/g, '') : `[ES] ${title}`;

                console.log(`✅ Spanish translation complete: "${spanishTitle}"`);
            } catch (transErr) {
                console.error('❌ Spanish translation error:', transErr.message);
                // Continue without Spanish — don't fail the whole request
            }
        }

        // Final step: Done
        sendProgress(TOTAL_STEPS, TOTAL_STEPS, 'Blog ready!');
        console.log(`✅ Blog generated: "${title}"`);

        sendResult({
            title,
            content: htmlContent,
            htmlContent,
            metaTitle: seo.seoTitle,
            metaDescription: seo.metaDesc,
            seoKeywords: seo.seoKeywords,
            focusKeyphrase,
            slug: seo.slug,
            images: uploadedImages,
            featuredMediaId: uploadedImages[0]?.id || null,
            spanishHtmlContent,
            spanishTitle,
        });
    } catch (err) {
        console.error('❌ Generation error:', err);
        sendError(err.message || 'Blog generation failed');
    }
});

// ─── POST /api/publish ───────────────────────────────────────────
app.post('/api/publish', async (req, res) => {
    try {
        const { title, htmlContent, featuredMediaId, focusKeyphrase, metaTitle, metaDescription, seoKeywords } = req.body;
        let { slug } = req.body;

        const wpUrl = process.env.WORDPRESS_URL;
        const wpUser = process.env.WORDPRESS_USERNAME;
        const wpPass = process.env.WORDPRESS_APP_PASSWORD;

        console.log(`📤 Publish request — WP URL: ${wpUrl ? wpUrl.slice(0, 30) + '…' : 'NOT SET'}, User: ${wpUser ? '✓ set' : 'NOT SET'}, Pass: ${wpPass ? '✓ set' : 'NOT SET'}`);

        if (!wpUrl || !wpUser || !wpPass) {
            return res.status(400).json({ error: `WordPress credentials not configured. URL: ${!!wpUrl}, User: ${!!wpUser}, Pass: ${!!wpPass}` });
        }

        const credentials = Buffer.from(`${wpUser}:${wpPass}`).toString('base64');

        // Keyphrase-rich slug (Yoast: "Keyphrase in slug")
        slug = slugify(slug || focusKeyphrase || title);

        // Trim meta description to Yoast's 156-char limit, on a word boundary.
        let metaDesc = (metaDescription || '').trim();
        if (metaDesc.length > 155) {
            metaDesc = metaDesc.slice(0, 155);
            const sp = metaDesc.lastIndexOf(' ');
            if (sp > 120) metaDesc = metaDesc.slice(0, sp);
            metaDesc = metaDesc.replace(/[\s,;:.\-]+$/, '');
        }

        const postData = {
            title,
            content: htmlContent,
            status: 'draft',
        };

        if (slug) postData.slug = slug;
        if (metaDesc) postData.excerpt = metaDesc; // native fallback + good practice

        // Push Yoast SEO fields. Requires the meta keys to be registered for REST
        // (see server/.env.example for the one-time mu-plugin snippet). Harmless if ignored.
        const yoastMeta = {};
        if (focusKeyphrase) yoastMeta._yoast_wpseo_focuskw = focusKeyphrase;
        if (metaTitle) yoastMeta._yoast_wpseo_title = metaTitle;
        if (metaDesc) yoastMeta._yoast_wpseo_metadesc = metaDesc;
        if (Array.isArray(seoKeywords) && seoKeywords.length) {
            yoastMeta._yoast_wpseo_focuskw = focusKeyphrase || seoKeywords[0];
        }
        if (Object.keys(yoastMeta).length) postData.meta = yoastMeta;

        if (featuredMediaId) {
            postData.featured_media = featuredMediaId;
        }

        const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Basic ${credentials}`,
            },
            body: JSON.stringify(postData),
        });

        if (!wpRes.ok) {
            const errorText = await wpRes.text();
            throw new Error(`WordPress API error (${wpRes.status}): ${errorText}`);
        }

        const post = await wpRes.json();

        console.log(`📤 Draft published to WordPress: ${post.link} (focus: "${focusKeyphrase || '—'}", slug: "${post.slug || slug}")`);

        res.json({
            postId: post.id,
            slug: post.slug || slug,
            editUrl: `${wpUrl}/wp-admin/post.php?post=${post.id}&action=edit`,
            viewUrl: post.link,
        });
    } catch (err) {
        console.error('❌ Publish error:', err);
        res.status(500).json({ error: err.message || 'WordPress publishing failed' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// ─── BLOG HISTORY — Storage & CRUD ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const BLOGS_FILE = isVercel ? '/tmp/blogs.json' : join(__dirname, 'blogs.json');

// Blog history is stored in Redis (persistent across deploys/cold starts),
// with the JSON file as a local-dev fallback. /tmp on Vercel is ephemeral.
async function loadBlogs() {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get('orbit_blogs');
            if (data) return JSON.parse(data);
        } catch (err) {
            console.error('Redis loadBlogs error:', err.message);
            // Fall through to file
        }
    }
    if (!existsSync(BLOGS_FILE)) return [];
    try { return JSON.parse(readFileSync(BLOGS_FILE, 'utf-8')); } catch { return []; }
}

async function saveBlogs(blogs) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set('orbit_blogs', JSON.stringify(blogs));
        } catch (err) {
            console.error('Redis saveBlogs error:', err.message);
        }
    }
    // Always write to file as well (local fallback)
    try { writeFileSync(BLOGS_FILE, JSON.stringify(blogs, null, 2), 'utf-8'); } catch { }
}

// ─── POST /api/blogs — Save a generated blog ───────────────────
app.post('/api/blogs', async (req, res) => {
    const { title, html, markdown, seoTitle, seoDescription, seoKeywords, focusKeyphrase, slug, keywords, description, wordCount, userName, spanishHtml, spanishTitle } = req.body;
    const blogs = await loadBlogs();
    const blog = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        userName: userName || 'Unknown',
        title: title || seoTitle || 'Untitled Blog',
        html: html || '',
        markdown: markdown || '',
        seoTitle: seoTitle || '',
        seoDescription: seoDescription || '',
        seoKeywords: seoKeywords || [],
        focusKeyphrase: focusKeyphrase || '',
        slug: slug || '',
        url: '',
        keywords: keywords || '',
        description: description || '',
        wordCount: wordCount || 0,
        spanishHtml: spanishHtml || null,
        spanishTitle: spanishTitle || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        published: false,
    };
    blogs.unshift(blog);
    await saveBlogs(blogs);
    console.log(`📝 Blog saved: "${blog.title}" (${blog.id})`);
    res.json(blog);
});

// ─── GET /api/blogs — List all blogs ────────────────────────────
app.get('/api/blogs', async (req, res) => {
    res.json(await loadBlogs());
});

// ─── GET /api/blogs/:id — Get a single blog ────────────────────
app.get('/api/blogs/:id', async (req, res) => {
    const blogs = await loadBlogs();
    const blog = blogs.find(b => b.id === req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    res.json(blog);
});

// ─── PUT /api/blogs/:id — Update a blog ────────────────────────
app.put('/api/blogs/:id', async (req, res) => {
    const blogs = await loadBlogs();
    const idx = blogs.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Blog not found' });
    const { html, markdown, title, seoTitle, seoDescription, focusKeyphrase, slug, url, published } = req.body;
    if (html !== undefined) blogs[idx].html = html;
    if (markdown !== undefined) blogs[idx].markdown = markdown;
    if (title !== undefined) blogs[idx].title = title;
    if (seoTitle !== undefined) blogs[idx].seoTitle = seoTitle;
    if (seoDescription !== undefined) blogs[idx].seoDescription = seoDescription;
    if (focusKeyphrase !== undefined) blogs[idx].focusKeyphrase = focusKeyphrase;
    if (slug !== undefined) blogs[idx].slug = slug;
    if (url !== undefined) blogs[idx].url = url;
    if (published !== undefined) blogs[idx].published = published;
    blogs[idx].updatedAt = new Date().toISOString();
    await saveBlogs(blogs);
    res.json(blogs[idx]);
});

// ─── DELETE /api/blogs/:id — Delete a blog ─────────────────────
app.delete('/api/blogs/:id', async (req, res) => {
    const blogs = await loadBlogs();
    const filtered = blogs.filter(b => b.id !== req.params.id);
    await saveBlogs(filtered);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// ─── POSTS GENERATOR — Ad Research & Generation ─────────────────
// ═══════════════════════════════════════════════════════════════════

const ADS_FILE = isVercel ? '/tmp/ads.json' : join(__dirname, 'ads.json');

function loadAds() {
    if (!existsSync(ADS_FILE)) return [];
    try { return JSON.parse(readFileSync(ADS_FILE, 'utf-8')); } catch { return []; }
}

function saveAds(ads) {
    writeFileSync(ADS_FILE, JSON.stringify(ads, null, 2), 'utf-8');
}

// ─── CRUD endpoints ─────────────────────────────────────────────
app.get('/api/ads', (req, res) => res.json(loadAds()));

app.get('/api/ads/:id', (req, res) => {
    const ad = loadAds().find(a => a.id === req.params.id);
    if (!ad) return res.status(404).json({ error: 'Not found' });
    res.json(ad);
});

app.delete('/api/ads/:id', (req, res) => {
    const ads = loadAds().filter(a => a.id !== req.params.id);
    saveAds(ads);
    res.json({ success: true });
});

// ─── POST /api/ads/generate-images (SSE) ────────────────────────
app.post('/api/ads/generate-images', async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    function send(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

    try {
        const { adContent, product, description } = req.body;
        if (!adContent) { send({ type: 'error', error: 'No ad content provided' }); res.end(); return; }

        // Step 1: Use Claude to create image prompts from the ad content
        send({ type: 'progress', text: 'Analyzing ad content for image ideas…', pct: 10 });

        let imagePrompts = [];
        try {
            const promptRes = await callClaude({
                model: 'claude-sonnet-4-6',
                max_tokens: 1024,
                messages: [{
                    role: 'user',
                    content: `Below is generated ad/post content for the product "${product || 'a product'}":

${adContent.slice(0, 3000)}

Create exactly 3 image generation prompts for ad visuals that would accompany these posts. Each prompt should describe a unique, eye-catching ad image.

Rules:
- Each must be a detailed photorealistic image description (scene, lighting, composition, mood)
- Images should be scroll-stopping social media ad visuals
- Include the product/brand context naturally
- No text, logos, or watermarks in the images
- Professional, premium advertising quality
- Each prompt should be 2-3 sentences

Return ONLY a JSON array of 3 strings, nothing else. Example: ["prompt 1", "prompt 2", "prompt 3"]`,
                }],
            });

            const raw = promptRes.content[0].text.trim();
            // Try to extract JSON array from the response
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                imagePrompts = JSON.parse(jsonMatch[0]);
            }
        } catch (err) {
            console.error('Claude prompt generation error:', err.message);
        }

        // Fallback if Claude didn't return valid prompts
        if (!Array.isArray(imagePrompts) || imagePrompts.length < 3) {
            imagePrompts = [
                `Stunning social media ad visual for "${product || 'a product'}". Premium product photography, vibrant colors, clean composition, professional studio lighting. No text or logos.`,
                `Lifestyle photograph showing "${product || 'a product'}" in action. Real-world setting, warm natural lighting, authentic feel, aspirational mood. No text or watermarks.`,
                `Bold, attention-grabbing ad banner concept for "${product || 'a product'}". Dynamic composition, striking colors, modern minimalist style. No text or logos.`,
            ];
        }

        console.log(`🎨 Generating ${imagePrompts.length} ad images for "${product}"`);

        // Step 2-4: Generate each image
        let generated = 0;
        for (let i = 0; i < imagePrompts.length; i++) {
            send({ type: 'progress', text: `Generating image ${i + 1} of ${imagePrompts.length}…`, pct: 20 + (i * 25) });
            console.log(`   Image ${i + 1}: "${imagePrompts[i].slice(0, 60)}…"`);

            const img = await generateBlogImage(imagePrompts[i]);
            if (img && img.buffer) {
                const dataUrl = `data:${img.mimeType};base64,${img.buffer.toString('base64')}`;
                send({ type: 'image', dataUrl, prompt: imagePrompts[i].slice(0, 80), index: i });
                generated++;
            } else {
                console.log(`   Image ${i + 1} generation failed`);
            }
        }

        send({ type: 'progress', text: 'Done!', pct: 100 });
        send({ type: 'complete', count: generated });
        console.log(`✅ Generated ${generated}/${imagePrompts.length} ad images`);
    } catch (err) {
        console.error('❌ Ad image generation error:', err);
        send({ type: 'error', error: err.message || 'Image generation failed' });
    }
    res.end();
});

// ─── POST /api/ads/generate (SSE) ───────────────────────────────
app.post('/api/ads/generate', async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const {
        product,
        description,
        platforms = {},
        videoDuration,
        postCount = 3,
        ctaGoal = 'book_meeting',
        userName = 'Unknown',
    } = req.body;

    try {
        // ── Stage 1: Perplexity Deep Research ────────────────────────
        send({ type: 'progress', stage: 'research', pct: 5, text: 'Starting deep customer research…' });

        const researchPrompt = `You are an expert ad researcher. Search Reddit, X/Twitter, forums, review sites, and communities for REAL people discussing "${product}".
${description ? `Product context: ${description}` : ''}

Find and return:
1. **Exact phrases and language** real people use to describe their pain points related to this product/industry
2. **What makes them stop scrolling** — hooks, headlines, and visuals that catch attention in this niche
3. **Common objections** to buying or switching to a product like this
4. **Competitors** they currently use and what they complain about
5. **Emotional triggers** — fears, aspirations, frustrations that resonate deeply
6. **The "aha moment"** — what convinced people to finally buy/switch

Focus on VERBATIM quotes, slang, and the RAW way customers talk. Not marketing language — REAL people language.
Return comprehensive research with specific examples and quotes.`;

        send({ type: 'progress', stage: 'research', pct: 10, text: 'Scanning Reddit, X, forums for real customer language…' });

        const researchRes = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'sonar-pro',
                messages: [{ role: 'user', content: researchPrompt }],
                search_recency_filter: 'month',
            }),
        });

        if (!researchRes.ok) {
            const err = await researchRes.text();
            throw new Error(`Perplexity research failed: ${err}`);
        }

        const researchData = await researchRes.json();
        const research = researchData.choices?.[0]?.message?.content || '';

        send({ type: 'progress', stage: 'research', pct: 40, text: 'Deep research complete. Analyzing customer language…' });
        send({ type: 'research', content: research });

        // ── Stage 2: Claude Ad Generation ────────────────────────────
        send({ type: 'progress', stage: 'generation', pct: 45, text: 'Generating ad creatives from research…' });

        // Build platform-specific instructions
        let platformInstructions = '';

        if (platforms.instagram) {
            platformInstructions += `
## 📸 INSTAGRAM POST (STATIC/CAROUSEL CARDS)
You MUST provide 3 distinct, high-converting ad variations (e.g. A/B/C testing styles: direct response, educational, emotional). 
For EACH variation, you MUST clearly define:
1. **VISUAL GRAPHIC TEXT (What goes ON the image itself)**: Write the EXACT headline, subheadline, and callout text to be overlaid on the graphic. Keep it punchy and use exact phrases from the research.
2. **VISUAL DESIGN DIRECTIVES**: Describe the scene, background color mood, focal point, and text placement.
3. **POST CAPTION**: Write the accompanying caption (with emojis, spacing) and 10 relevant hashtags.
Make these 3 variations drastically different to give the user excellent options.
`;
        }

        if (platforms.reels) {
            platformInstructions += `
## 🎬 INSTAGRAM REELS
- Vertical video script (9:16) ${videoDuration ? `for ${videoDuration}` : 'for 30 seconds'}
- Hook in first 2 seconds
- Scene-by-scene breakdown with B-roll suggestions
- Trending audio style suggestion
- Text overlay timing
- CTA at the end
`;
        }

        if (platforms.youtubeShorts) {
            platformInstructions += `
## 📺 YOUTUBE SHORTS
- Vertical script ${videoDuration ? `for ${videoDuration}` : 'for 60 seconds'}
- Retention hook in first 3 seconds
- Pattern interrupts to maintain watch time
- End screen CTA
- Title and description
`;
        }

        if (platforms.linkedin) {
            platformInstructions += `
## 💼 LINKEDIN POST
- Professional tone, longer copy
- 3 post options (story-based, data-driven, question-based)
- Carousel idea (5–8 slide outline)
- CTA for engagement
`;
        }

        if (platforms.x) {
            platformInstructions += `
## 🐦 X (TWITTER)
- 3 standalone tweets (≤280 chars each, punchy)
- 1 thread (5–7 tweets) for deeper engagement
- Engagement hooks
`;
        }

        if (platforms.videoScript) {
            platformInstructions += `
## 🎥 FULL VIDEO SCRIPT
- Duration: ${videoDuration || '60 seconds'}
- Scene-by-scene breakdown
- Voiceover/narration script
- B-roll descriptions for each scene
- Text overlays and graphics descriptions
- Background music mood suggestion
- CTA and end card
`;
        }

        const ctaLabels = {
            book_meeting: 'Book a Meeting / Schedule a Demo',
            sign_up_free: 'Sign Up for Free / Create Free Account',
            download: 'Download Now / Get the Guide',
            learn_more: 'Learn More / See How It Works',
            get_quote: 'Get a Quote / Request Pricing',
            buy_now: 'Buy Now / Shop Now',
            free_trial: 'Start Free Trial / Try It Free',
            contact_us: 'Contact Us / Get in Touch',
        };
        const ctaLabel = ctaLabels[ctaGoal] || 'Book a Meeting';

        const adPrompt = `You are writing ad creative briefs for a design agency. Keep everything SHORT and PUNCHY — no long paragraphs, no walls of text, no excessive emojis. Think like a creative director.

## PRODUCT: ${product}
${description ? `## PRODUCT INFO: ${description}` : ''}

## RESEARCH INSIGHTS:
${research}

## CTA GOAL: ${ctaLabel}

---

Generate EXACTLY ${postCount} static ad post(s). Number them Post 1, Post 2, etc.

For EACH post:

### Hook
One scroll-stopping headline. MAX 5-8 words. Bold. Provocative. Uses their real language.

### Caption
2-3 sentences max. Direct, punchy. 1-2 emojis max. End with the CTA.

### Key Benefits
Exactly 4 bullet points. One short line each (5-10 words). No fluff.

### CTA Button Text
One button label aligned to "${ctaLabel}". Max 4 words.

### Visual Brief
- **Scene**: What the image shows (1 sentence)
- **Text Overlay**: Exact words on the image (max 6 words)
- **Color/Mood**: 3-4 words (e.g. "Dark, bold, orange accents")
- **Layout**: Where text sits relative to the visual

${platformInstructions || ''}

RULES:
- No long descriptions. This goes to a design agency — they need briefs, not essays.
- Hooks must be SHORT. If it's more than 8 words, rewrite it.
- No emoji spam. Max 1-2 per caption.
- Each post must have a DIFFERENT angle/hook.
- Benefits are short bullet points, not sentences.`;

        send({ type: 'progress', stage: 'generation', pct: 50, text: 'Claude is crafting your ads…' });

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 8000,
                stream: true,
                messages: [{ role: 'user', content: adPrompt }],
            }),
        });

        if (!claudeRes.ok) {
            const err = await claudeRes.text();
            throw new Error(`Claude generation failed: ${err}`);
        }

        let fullContent = '';
        let pct = 50;
        const reader = claudeRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') continue;
                try {
                    const evt = JSON.parse(raw);
                    if (evt.type === 'content_block_delta' && evt.delta?.text) {
                        fullContent += evt.delta.text;
                        pct = Math.min(95, pct + 0.3);
                        send({ type: 'progress', stage: 'generation', pct: Math.round(pct), text: 'Generating ad content…' });
                        send({ type: 'chunk', content: evt.delta.text });
                    }
                } catch { }
            }
        }

        send({ type: 'progress', stage: 'done', pct: 100, text: 'Complete!' });

        // Save to ads.json
        const ad = {
            id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            userName,
            product,
            description: description || '',
            platforms,
            videoDuration: videoDuration || '',
            research,
            content: fullContent,
            createdAt: new Date().toISOString(),
        };
        const ads = loadAds();
        ads.unshift(ad);
        saveAds(ads);

        send({ type: 'complete', ad });
        console.log(`📣 Ad generated & saved: "${product}" (${ad.id})`);
    } catch (err) {
        console.error('Ad generation error:', err);
        send({ type: 'error', error: err.message });
    } finally {
        res.end();
    }
});

// ═══════════════════════════════════════════════════════════════════
// ─── AI SALES — Vapi Outbound Calling ────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const CALLS_FILE = isVercel ? '/tmp/calls.json' : join(__dirname, 'calls.json');
const VAPI_BASE = 'https://api.vapi.ai';

// ─── GoHighLevel (GHL) Calendar Integration ─────────────────────
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-688cd5cd-7425-4649-9987-0a15e745d8e4';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || 't64wu6C9FCzSRv4xNW9p';
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID || 'YDJNpnn1HV2mjEFoIdci';

function ghlHeaders() {
    return {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15',
    };
}

// Create or find a GHL contact by phone number
async function ghlFindOrCreateContact(phone, name, email) {
    // Search for existing contact by phone
    try {
        const searchRes = await fetch(`${GHL_BASE}/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&number=${encodeURIComponent(phone)}`, {
            headers: ghlHeaders(),
        });
        const searchData = await searchRes.json();
        if (searchData.contact?.id) {
            console.log(`📇 Found existing GHL contact: ${searchData.contact.id}`);
            return searchData.contact.id;
        }
    } catch (e) {
        console.warn('GHL contact search failed:', e.message);
    }

    // Create new contact
    const contactRes = await fetch(`${GHL_BASE}/contacts/`, {
        method: 'POST',
        headers: ghlHeaders(),
        body: JSON.stringify({
            locationId: GHL_LOCATION_ID,
            phone,
            name: name || undefined,
            firstName: name ? name.split(' ')[0] : undefined,
            lastName: name && name.split(' ').length > 1 ? name.split(' ').slice(1).join(' ') : undefined,
            email: email || undefined,
            source: 'vapi-phone-call',
            tags: ['vapi-caller', 'auto-booked'],
        }),
    });
    const contactData = await contactRes.json();
    console.log(`📇 Created GHL contact: ${contactData.contact?.id}`);
    return contactData.contact?.id;
}

// Book an appointment on GHL calendar
async function ghlBookAppointment(contactId, startTime, title) {
    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000); // 30 min slot

    const res = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
        method: 'POST',
        headers: ghlHeaders(),
        body: JSON.stringify({
            calendarId: GHL_CALENDAR_ID,
            locationId: GHL_LOCATION_ID,
            contactId,
            startTime: startDate.toISOString(),
            endTime: endDate.toISOString(),
            title: title || 'Phone Call Booking',
            appointmentStatus: 'new',
            toNotify: true,
        }),
    });
    const data = await res.json();
    if (!res.ok) {
        console.error('GHL appointment error:', JSON.stringify(data));
        throw new Error(data.message || 'Failed to book appointment');
    }
    console.log(`📅 GHL appointment booked: ${data.id || data.event?.id}`);
    return data;
}

// Get available slots from GHL calendar
async function ghlGetAvailableSlots(dateStr, daysToSearch = 1) {
    const startDate = new Date(dateStr);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + daysToSearch);

    // GHL requires Unix timestamps in milliseconds
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();

    const params = new URLSearchParams({
        startDate: String(startMs),
        endDate: String(endMs),
        timezone: 'America/New_York',
    });

    console.log(`📅 Checking slots: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    const res = await fetch(`${GHL_BASE}/calendars/${GHL_CALENDAR_ID}/free-slots?${params}`, {
        headers: ghlHeaders(),
    });
    const data = await res.json();

    if (!res.ok) {
        console.error('GHL slots error:', JSON.stringify(data));
        return {};
    }

    // Parse GHL response: { "YYYY-MM-DD": { "slots": ["2026-03-23T09:00:00-04:00", ...] }, traceId: ... }
    const allSlots = {};
    for (const [key, val] of Object.entries(data)) {
        if (key === 'traceId') continue;
        if (val && Array.isArray(val.slots)) {
            allSlots[key] = val.slots;
        }
    }
    return allSlots;
}

// Get slots across multiple days (up to 5) to find alternatives
async function ghlGetMultiDaySlots(startDateStr, maxDays = 5) {
    const allSlots = await ghlGetAvailableSlots(startDateStr, maxDays);
    // Flatten into a single array of { date, time, iso } objects
    const flat = [];
    for (const [date, times] of Object.entries(allSlots)) {
        for (const iso of times) {
            const dt = new Date(iso);
            flat.push({
                date,
                time: dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }),
                iso,
                readable: `${dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })} at ${dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })}`,
            });
        }
    }
    return flat;
}

// ─── VAPI Webhook for Tool Calls ────────────────────────────────
app.post('/api/vapi/webhook', async (req, res) => {
    const { message } = req.body;
    console.log(`📞 VAPI webhook: type=${message?.type}`);

    if (message?.type === 'tool-calls') {
        const results = [];

        for (const toolCall of message.toolCallList || []) {
            const { id: toolCallId, function: fn } = toolCall;
            const { name, arguments: args } = fn;
            console.log(`🔧 Tool call: ${name}(${JSON.stringify(args).slice(0, 200)})`);

            try {
                if (name === 'book_meeting') {
                    const { caller_name, caller_phone, preferred_date, preferred_time, email } = args;

                    // Parse just the date and hour requested (ignore timezone)
                    let requestedDateStr = preferred_date || '';
                    let requestedHour = 10; // default 10am
                    if (preferred_time) {
                        const timeParts = preferred_time.match(/(\d{1,2})/);
                        if (timeParts) requestedHour = parseInt(timeParts[1]);
                        // Handle PM
                        if (preferred_time.toLowerCase().includes('pm') && requestedHour < 12) requestedHour += 12;
                        if (preferred_time.toLowerCase().includes('am') && requestedHour === 12) requestedHour = 0;
                    }

                    // Determine which date to search from
                    let searchDate;
                    if (requestedDateStr && !isNaN(new Date(requestedDateStr).getTime())) {
                        searchDate = requestedDateStr;
                    } else {
                        // Default to tomorrow
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        searchDate = tomorrow.toISOString().split('T')[0];
                    }

                    console.log(`📅 book_meeting: searching from ${searchDate}, preferred hour: ${requestedHour}:00`);

                    // Get available slots
                    const allSlots = await ghlGetMultiDaySlots(searchDate, 5);

                    if (allSlots.length === 0) {
                        results.push({
                            toolCallId,
                            result: JSON.stringify({
                                success: false,
                                message: 'No available slots found in the next 5 business days. Please suggest the caller reaches out via email or tries again later.',
                            }),
                        });
                        continue;
                    }

                    // Find the best matching slot by comparing local time
                    // Extract hour from slot ISO string (e.g. "2026-03-20T10:00:00-04:00" → hour 10)
                    let bestSlot = null;
                    let bestDiff = Infinity;
                    for (const slot of allSlots) {
                        // Extract date and hour from the ISO string directly
                        const slotMatch = slot.iso.match(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
                        if (!slotMatch) continue;
                        const [, slotDate, slotHourStr] = slotMatch;
                        const slotHour = parseInt(slotHourStr);

                        // If we have a specific date, match the date first
                        if (requestedDateStr && !isNaN(new Date(requestedDateStr).getTime())) {
                            if (slotDate === requestedDateStr) {
                                const hourDiff = Math.abs(slotHour - requestedHour);
                                if (hourDiff < bestDiff) {
                                    bestDiff = hourDiff;
                                    bestSlot = slot;
                                }
                            }
                        } else {
                            // No specific date — find closest hour on any day
                            const hourDiff = Math.abs(slotHour - requestedHour);
                            if (hourDiff < bestDiff) {
                                bestDiff = hourDiff;
                                bestSlot = slot;
                            }
                        }
                    }

                    // If no slot within 2 hours, offer alternatives
                    if (!bestSlot || bestDiff > 2) {
                        const alternatives = allSlots.slice(0, 5).map(s => s.readable);
                        results.push({
                            toolCallId,
                            result: JSON.stringify({
                                success: false,
                                message: bestDiff > 2
                                    ? `The requested time is not available. Here are the closest available slots:`
                                    : `No slots found near the requested time. Here are available slots:`,
                                available_slots: alternatives,
                                instruction: 'Please ask the caller which of these times works for them, then call book_meeting again with the chosen date and time.',
                            }),
                        });
                        continue;
                    }

                    // Use the exact GHL slot time (already in correct timezone)
                    const bookingTime = bestSlot.iso;

                    // Create/find contact and book
                    const contactId = await ghlFindOrCreateContact(
                        caller_phone || message.call?.customer?.number,
                        caller_name,
                        email
                    );

                    if (!contactId) {
                        throw new Error('Could not create contact in CRM');
                    }

                    const appointment = await ghlBookAppointment(
                        contactId,
                        bookingTime,
                        `Demo Call — ${caller_name || 'Phone Inquiry'}`
                    );

                    results.push({
                        toolCallId,
                        result: JSON.stringify({
                            success: true,
                            message: `Meeting booked successfully for ${bestSlot.readable}. A confirmation will be sent.`,
                            appointmentId: appointment.id || appointment.event?.id,
                        }),
                    });
                } else if (name === 'check_availability') {
                    const { date } = args;

                    // Default to tomorrow if no date given
                    let checkDate = date;
                    if (!checkDate) {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        checkDate = tomorrow.toISOString().split('T')[0];
                    }

                    const allSlots = await ghlGetMultiDaySlots(checkDate, 3);

                    if (allSlots.length > 0) {
                        results.push({
                            toolCallId,
                            result: JSON.stringify({
                                success: true,
                                message: `Here are the available time slots:`,
                                available_slots: allSlots.slice(0, 8).map(s => s.readable),
                            }),
                        });
                    } else {
                        // Try looking further ahead
                        const laterDate = new Date(checkDate);
                        laterDate.setDate(laterDate.getDate() + 3);
                        const laterSlots = await ghlGetMultiDaySlots(laterDate.toISOString().split('T')[0], 5);

                        results.push({
                            toolCallId,
                            result: JSON.stringify({
                                success: true,
                                message: laterSlots.length > 0
                                    ? `No slots on the requested date, but here are upcoming available times:`
                                    : `No available slots found in the next week. Suggest the caller email us to arrange a meeting.`,
                                available_slots: laterSlots.slice(0, 6).map(s => s.readable),
                            }),
                        });
                    }
                } else {
                    results.push({
                        toolCallId,
                        result: JSON.stringify({ error: `Unknown tool: ${name}` }),
                    });
                }
            } catch (err) {
                console.error(`❌ Tool ${name} error:`, err.message);
                results.push({
                    toolCallId,
                    result: JSON.stringify({ success: false, error: err.message }),
                });
            }
        }

        return res.json({ results });
    }

    // For other VAPI webhook events (assistant-request, status-update, etc.)
    res.json({});
});

async function loadCalls() {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get('orbit_calls');
            return data ? JSON.parse(data) : [];
        } catch (err) {
            console.error('Redis loadCalls error:', err.message);
            // Fall through to file
        }
    }
    if (!existsSync(CALLS_FILE)) return [];
    try { return JSON.parse(readFileSync(CALLS_FILE, 'utf-8')); } catch { return []; }
}

async function saveCalls(calls) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set('orbit_calls', JSON.stringify(calls));
        } catch (err) {
            console.error('Redis saveCalls error:', err.message);
        }
    }
    // Always write to file as well (local fallback)
    try { writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2), 'utf-8'); } catch { }
}

function vapiHeaders() {
    return {
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json',
    };
}

// ─── POST /api/sales/call — Initiate outbound call ──────────────
app.post('/api/sales/call', async (req, res) => {
    try {
        const { phoneNumber, contactName, company, salesScript } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        if (!process.env.VAPI_API_KEY) {
            return res.status(500).json({ error: 'Vapi API key not configured' });
        }

        const defaultScript = `You are a friendly, professional sales representative for Celeritech, a company that provides ERP and business technology solutions for food & beverage manufacturers. 

Your goal is to:
1. Introduce yourself and Celeritech briefly
2. Ask what ERP or business software they currently use
3. Understand their biggest pain points with their current system
4. Gauge their interest level in exploring better solutions
5. If interested, propose scheduling a demo meeting

Be conversational, not pushy. Ask follow-up questions based on their answers. If they're not interested, be polite and ask if you can follow up in the future. Keep the call under 5 minutes.`;

        const prompt = salesScript || defaultScript;

        // Normalize to E.164 format
        let normalizedPhone = phoneNumber.replace(/[^\d+]/g, '');
        if (!normalizedPhone.startsWith('+')) {
            // If it starts with country code 1 and has 11 digits, just add +
            if (normalizedPhone.startsWith('1') && normalizedPhone.length === 11) {
                normalizedPhone = '+' + normalizedPhone;
            } else {
                normalizedPhone = '+1' + normalizedPhone;
            }
        }

        console.log(`\n📞 Initiating call to ${normalizedPhone} (${contactName || 'Unknown'})`);

        const response = await fetch(`${VAPI_BASE}/call`, {
            method: 'POST',
            headers: vapiHeaders(),
            body: JSON.stringify({
                phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
                customer: {
                    number: normalizedPhone,
                    name: contactName || undefined,
                },
                assistantId: 'ec94ead8-b047-4f64-989d-0c96731fbdc2',
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('Vapi call error:', errBody);
            // Parse Vapi error for a user-friendly message
            let userMsg = `Vapi API error: ${response.status}`;
            try {
                const parsed = JSON.parse(errBody);
                if (parsed.message) {
                    userMsg = Array.isArray(parsed.message) ? parsed.message.join('. ') : parsed.message;
                }
            } catch { }
            throw new Error(userMsg);
        }

        const callData = await response.json();

        // Vapi may return 200 but the call already failed (e.g. daily limit)
        if (callData.endedReason) {
            const reason = callData.endedReason;
            console.error(`❌ Vapi call failed immediately: ${reason}`);
            const friendlyErrors = {
                'call.start.error-vapi-number-outbound-daily-limit': 'Daily outbound call limit reached for this phone number. Try again tomorrow or upgrade your Vapi plan.',
                'call.start.error-get-transport': 'Failed to connect phone transport. The phone number may be misconfigured in Vapi.',
                'call.start.error-phone-number-not-found': 'Phone number not found in Vapi. Check VAPI_PHONE_NUMBER_ID in .env.',
            };
            const msg = friendlyErrors[reason] || `Call failed: ${reason}`;
            return res.status(429).json({ error: msg, endedReason: reason });
        }

        console.log(`✅ Call initiated: ${callData.id}`);

        // Save to local storage
        const calls = await loadCalls();
        calls.unshift({
            id: callData.id,
            phoneNumber,
            contactName: contactName || '',
            company: company || '',
            status: 'in_progress',
            startedAt: new Date().toISOString(),
            duration: null,
            recordingUrl: null,
            transcript: null,
            analysis: null,
        });
        await saveCalls(calls);

        res.json({ callId: callData.id, status: 'in_progress' });
    } catch (err) {
        console.error('❌ Call initiation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/sales/calls — List all calls ──────────────────────
app.get('/api/sales/calls', async (req, res) => {
    res.json(await loadCalls());
});

// ─── DELETE /api/sales/call/:id — Delete a call ─────────────────
app.delete('/api/sales/call/:id', async (req, res) => {
    const calls = await loadCalls();
    const filtered = calls.filter(c => c.id !== req.params.id);
    await saveCalls(filtered);
    res.json({ success: true });
});

// ─── GET /api/sales/call/:id — Poll call status + auto-analyze ──
app.get('/api/sales/call/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch from Vapi
        const response = await fetch(`${VAPI_BASE}/call/${id}`, {
            headers: vapiHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Vapi error: ${response.status}`);
        }

        const vapiCall = await response.json();

        // Debug: log key fields from VAPI response
        console.log(`📡 VAPI call ${id}: status=${vapiCall.status}, endedReason=${vapiCall.endedReason || 'N/A'}, hasArtifact=${!!vapiCall.artifact}, hasRecording=${!!(vapiCall.recordingUrl || vapiCall.artifact?.recordingUrl)}, hasTranscript=${!!(vapiCall.transcript || vapiCall.artifact?.transcript || vapiCall.artifact?.messages)}`);

        // Update local storage
        const calls = await loadCalls();
        const localCall = calls.find(c => c.id === id);

        if (localCall) {
            const vapiStatus = vapiCall.status;
            const endedReason = vapiCall.endedReason || '';

            if (vapiStatus === 'ended') {
                // Check if the call failed before connecting (error reasons)
                if (endedReason.startsWith('call.start.error')) {
                    localCall.status = 'no_answer';
                    localCall.endedAt = vapiCall.endedAt || new Date().toISOString();
                    localCall.errorReason = endedReason;
                } else {
                    // Extract duration from various VAPI response locations
                    localCall.duration = vapiCall.costBreakdown?.duration
                        || vapiCall.duration
                        || vapiCall.artifact?.duration
                        || null;

                    // Extract recording URL
                    localCall.recordingUrl = vapiCall.recordingUrl
                        || vapiCall.artifact?.recordingUrl
                        || null;

                    // Extract transcript — VAPI v2 uses artifact.messages array
                    if (!localCall.transcript) {
                        if (typeof vapiCall.transcript === 'string' && vapiCall.transcript.length > 0) {
                            localCall.transcript = vapiCall.transcript;
                        } else if (typeof vapiCall.artifact?.transcript === 'string' && vapiCall.artifact.transcript.length > 0) {
                            localCall.transcript = vapiCall.artifact.transcript;
                        } else if (Array.isArray(vapiCall.artifact?.messages) && vapiCall.artifact.messages.length > 0) {
                            // Build transcript from messages array
                            localCall.transcript = vapiCall.artifact.messages
                                .filter(m => m.role && m.message)
                                .map(m => `${m.role === 'assistant' ? 'AI' : 'User'}: ${m.message}`)
                                .join('\n');
                        } else if (Array.isArray(vapiCall.messages) && vapiCall.messages.length > 0) {
                            localCall.transcript = vapiCall.messages
                                .filter(m => m.role && m.message)
                                .map(m => `${m.role === 'assistant' ? 'AI' : 'User'}: ${m.message}`)
                                .join('\n');
                        }
                    }

                    localCall.endedAt = vapiCall.endedAt || new Date().toISOString();

                    // Categorize based on call characteristics
                    if (!localCall.transcript && localCall.duration && localCall.duration < 15) {
                        localCall.status = 'no_answer';
                    } else if (endedReason === 'customer-ended-call' && localCall.duration && localCall.duration < 15) {
                        localCall.status = 'not_interested';
                    } else if (endedReason.includes('error')) {
                        localCall.status = 'no_answer';
                        localCall.errorReason = endedReason;
                    } else if (localCall.transcript && !localCall.analysis) {
                        // Auto-analyze if we have a transcript and haven't yet analyzed
                        console.log(`🧠 Auto-analyzing call ${id}…`);
                        localCall.analysis = await analyzeTranscript(localCall.transcript, localCall.contactName, localCall.company);
                        localCall.status = localCall.analysis.status || 'completed';
                    } else if (!localCall.analysis) {
                        localCall.status = 'completed';
                    }

                    // Flag if recording not ready yet (VAPI processes async)
                    localCall._recordingPending = !localCall.recordingUrl && !localCall.transcript;
                }
            } else if (vapiStatus === 'ringing' || vapiStatus === 'queued') {
                localCall.status = 'ringing';
            } else if (vapiStatus === 'in-progress') {
                localCall.status = 'in_progress';
            }
            await saveCalls(calls);
        }

        res.json(localCall || { id, status: vapiCall.status });
    } catch (err) {
        console.error('Call status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Claude Transcript Analysis ─────────────────────────────────
async function analyzeTranscript(transcript, contactName, company) {
    try {
        const message = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            messages: [
                {
                    role: 'user',
                    content: `Analyze this sales call transcript and return a JSON object with the following fields. Return ONLY the JSON, no markdown fences.

Transcript:
${transcript}

Contact: ${contactName || 'Unknown'} at ${company || 'Unknown Company'}

Return this exact JSON structure:
{
  "status": "meeting_booked" | "callback" | "not_interested" | "no_answer" | "voicemail",
  "summary": "2-3 sentence summary of the call outcome",
  "painPoints": ["list of pain points mentioned"],
  "currentSoftware": ["software/tools they currently use"],
  "objections": ["reasons they gave for hesitation or rejection"],
  "interestLevel": "high" | "medium" | "low" | "none",
  "followUpRecommendation": "what to do next",
  "keyQuotes": ["1-2 important direct quotes from the prospect"]
}`,
                },
            ],
        });

        let text = message.content[0].text.trim();
        text = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
        return JSON.parse(text);
    } catch (err) {
        console.error('Analysis error:', err.message);
        return {
            status: 'completed',
            summary: 'Unable to analyze transcript automatically.',
            painPoints: [],
            currentSoftware: [],
            objections: [],
            interestLevel: 'unknown',
            followUpRecommendation: 'Review call recording manually.',
            keyQuotes: [],
        };
    }
}

// ─── POST /api/media/upload-token (Vercel Blob) ─────────────
app.post('/api/media/upload-token', async (req, res) => {
    try {
        const { filename, contentType } = req.body;
        if (!filename) return res.status(400).json({ error: 'Filename is required' });

        if (!process.env.BLOB_READ_WRITE_TOKEN) {
            return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN is missing' });
        }

        const pathname = `orbit-media/${Date.now()}-${filename}`;
        // Lazy-load @vercel/blob/client only when needed
        if (!generateClientTokenFromReadWriteToken) {
            const blobModule = await import('@vercel/blob/client');
            generateClientTokenFromReadWriteToken = blobModule.generateClientTokenFromReadWriteToken;
        }
        const token = await generateClientTokenFromReadWriteToken({
            token: process.env.BLOB_READ_WRITE_TOKEN,
            pathname,
            maximumSizeInBytes: 50 * 1024 * 1024, // 50MB
        });

        res.json({ clientToken: token, pathname });
    } catch (e) {
        console.error('Blob Token Error:', e);
        res.status(500).json({ error: 'Failed to generate upload token', details: e.message });
    }
});

// ─── GET /api/media/test — Diagnostic: test full Fal.ai queue flow ──
app.get('/api/media/test', async (req, res) => {
    const steps = [];
    const falKey = process.env.FAL_KEY;
    if (!falKey) return res.json({ error: 'FAL_KEY not configured', steps });

    const model = 'fal-ai/kling-video/v3/pro/text-to-video';
    const input = { prompt: 'A gentle ocean wave rolling onto a sandy beach at sunset', duration: '5' };

    try {
        // Step 1: Submit to queue
        steps.push({ step: 'submit', url: `https://queue.fal.run/${model}`, input });
        const queueRes = await fetch(`https://queue.fal.run/${model}`, {
            method: 'POST',
            headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        const queueText = await queueRes.text();
        steps.push({ step: 'submit_response', status: queueRes.status, body: queueText.slice(0, 500) });

        if (!queueRes.ok) return res.json({ error: 'Queue submit failed', steps });

        const queueData = JSON.parse(queueText);
        const requestId = queueData.request_id;
        steps.push({ step: 'queued', requestId });

        // Step 2: Poll status (up to 10 attempts for test)
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const statusUrl = `https://queue.fal.run/${model}/requests/${requestId}/status`;
            const statusRes = await fetch(statusUrl, {
                headers: { 'Authorization': `Key ${falKey}` },
            });
            const statusText = await statusRes.text();
            steps.push({ step: `poll_${i}`, status: statusRes.status, body: statusText.slice(0, 300) });

            const statusData = JSON.parse(statusText);
            if (statusData.status === 'COMPLETED') {
                // Step 3: Fetch result
                const resultUrl = `https://queue.fal.run/${model}/requests/${requestId}`;
                const resultRes = await fetch(resultUrl, {
                    headers: { 'Authorization': `Key ${falKey}` },
                });
                const resultText = await resultRes.text();
                steps.push({ step: 'result', status: resultRes.status, body: resultText.slice(0, 800) });
                return res.json({ success: true, steps });
            }
            if (statusData.status === 'FAILED') {
                steps.push({ step: 'failed', data: statusData });
                return res.json({ error: 'Generation failed', steps });
            }
        }
        return res.json({ error: 'Still processing after 30s (test limit)', steps });
    } catch (err) {
        steps.push({ step: 'error', message: err.message });
        return res.json({ error: err.message, steps });
    }
});

// ─── POST /api/media/generate (Fal.ai queue submit) ─────────────
app.post('/api/media/generate', async (req, res) => {
    try {
        const falKey = process.env.FAL_KEY;
        if (!falKey) return res.status(500).json({ error: 'FAL_KEY not configured' });

        const { mode, model, prompt, aspectRatio, duration, resolution, referenceImage, referenceImageUrl, generate_audio, audio, negative_prompt, num_images } = req.body;
        if (!prompt || !model) return res.status(400).json({ error: 'Prompt and model are required' });

        const actualRefImage = referenceImage || referenceImageUrl;
        const actualGenerateAudio = generate_audio !== undefined ? generate_audio : audio;

        console.log(`🎬 Media generation: ${mode} with ${model}`);

        // Build the input payload
        const input = { prompt };

        if (negative_prompt) {
            input.negative_prompt = negative_prompt;
        }

        // Aspect ratio
        if (aspectRatio) {
            input.aspect_ratio = aspectRatio;
        }

        // Number of images (for image generation models)
        if (num_images && num_images > 1 && !mode?.includes('video')) {
            input.num_images = Math.min(num_images, 4);
        }

        // Image size (only for image modes, not video, and not models that handle aspect_ratio natively)
        if (!mode?.includes('video') && aspectRatio) {
            // Nano Banana uses aspect_ratio + resolution natively — don't send image_size
            if (model.includes('nano-banana')) {
                // Already set aspect_ratio above; add default resolution if not specified
                if (!input.resolution) {
                    input.resolution = '1K';
                }
                // Do NOT set image_size for Nano Banana
            } else {
                const [w, h] = aspectRatio.split(':').map(Number);
                const baseSize = 1080;
                if (w > h) {
                    input.image_size = { width: baseSize, height: Math.round(baseSize * h / w) };
                } else if (h > w) {
                    input.image_size = { width: Math.round(baseSize * w / h), height: baseSize };
                } else {
                    input.image_size = { width: baseSize, height: baseSize };
                }
            }
        }

        // Video Settings
        if (mode?.includes('video')) {
            if (model.includes('sora')) {
                // Sora: takes prompt and aspect_ratio only
            } else if (model.includes('veo2')) {
                // Veo 2.0: duration must be string with 's' suffix: "5s", "6s", "7s", "8s"
                if (duration) {
                    const parsedDuration = parseInt(String(duration).replace(/[^0-9]/g, ''));
                    const validDuration = [5, 6, 7, 8].includes(parsedDuration) ? parsedDuration : 5;
                    input.duration = `${validDuration}s`;
                } else {
                    input.duration = '5s';
                }
                // Veo uses image_url for reference images
                if (actualRefImage) {
                    input.image_url = actualRefImage;
                }
            } else {
                // Kling v3/v2/v1: duration as string "5", "10", etc.
                if (duration) input.duration = String(duration).replace(/[^0-9]/g, '');
                if (actualGenerateAudio === true) input.generate_audio = true;

                // Kling v3 uses 'start_image_url' for reference images
                if (actualRefImage) {
                    input.start_image_url = actualRefImage;
                    console.log(`📸 Set start_image_url for Kling: ${actualRefImage.slice(0, 80)}...`);
                }
            }

            // Generic fallback for other models
            if (actualRefImage && !input.image_url && !input.start_image_url) {
                input.image_url = actualRefImage;
            }
        } else {
            // Image generation reference
            if (actualRefImage) {
                // Nano Banana models use image_urls (array), not image_url
                if (model.includes('nano-banana')) {
                    input.image_urls = [actualRefImage];
                    console.log(`📸 Set image_urls (array) for Nano Banana: ${actualRefImage.slice(0, 80)}...`);
                } else {
                    input.image_url = actualRefImage;
                }
            }
        }

        // Final payload sanitization based on model strictness
        if (model.includes('sora')) {
            delete input.duration;
            delete input.generate_audio;
        } else if (model.includes('veo2')) {
            delete input.generate_audio; // Veo does not support generate_audio
        } else if (!mode?.includes('video')) {
            delete input.duration;
            delete input.generate_audio;
        }

        console.log(`🎬 Fal.ai payload for ${model}:`, JSON.stringify(input).slice(0, 500));

        // Submit to fal.ai queue
        const queueRes = await fetch(`https://queue.fal.run/${model}`, {
            method: 'POST',
            headers: {
                'Authorization': `Key ${falKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(input),
        });

        if (!queueRes.ok) {
            const errText = await queueRes.text();
            console.error(`Fal.ai queue error: ${queueRes.status} ${errText.slice(0, 500)}`);
            return res.status(queueRes.status).json({ error: `Fal.ai: ${errText.slice(0, 200)}` });
        }

        const resText = await queueRes.text();
        let queueData;
        try {
            queueData = JSON.parse(resText);
        } catch (parseErr) {
            console.error(`Fal.ai non-JSON response: ${resText.slice(0, 200)}`);
            return res.status(500).json({ error: `Fal.ai invalid response: ${resText.slice(0, 100)}` });
        }

        console.log(`   Queued: ${queueData.request_id || 'unknown'}`);
        console.log(`   status_url: ${queueData.status_url}`);
        console.log(`   response_url: ${queueData.response_url}`);
        res.json({
            success: true,
            requestId: queueData.request_id,
            statusUrl: queueData.status_url,
            responseUrl: queueData.response_url,
            modelUsed: model,
        });
    } catch (err) {
        console.error('Media generate error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/media/check-status — uses Fal.ai's own status_url ──
app.post('/api/media/check-status', async (req, res) => {
    try {
        const falKey = process.env.FAL_KEY;
        if (!falKey) return res.status(500).json({ error: 'FAL_KEY not configured' });

        const { statusUrl } = req.body;
        if (!statusUrl) return res.status(400).json({ error: 'statusUrl required' });

        const statusRes = await fetch(statusUrl, {
            headers: { 'Authorization': `Key ${falKey}` },
        });

        if (!statusRes.ok) {
            const errText = await statusRes.text();
            console.error(`❌ Fal status [${statusRes.status}]: ${errText.slice(0, 200)}`);
            return res.status(statusRes.status).json({ error: `Status ${statusRes.status}: ${errText.slice(0, 100)}` });
        }

        const statusData = await statusRes.json();
        console.log(`📊 Status: ${statusData.status}${statusData.error ? ' — ' + statusData.error : ''}`);
        res.json({
            status: statusData.status || 'IN_QUEUE',
            error: statusData.error || null,
            logs: statusData.logs || null,
            queue_position: statusData.queue_position || null,
        });
    } catch (err) {
        console.error('❌ Media status error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/media/fetch-result — uses Fal.ai's own response_url ──
app.post('/api/media/fetch-result', async (req, res) => {
    try {
        const falKey = process.env.FAL_KEY;
        if (!falKey) return res.status(500).json({ error: 'FAL_KEY not configured' });

        const { responseUrl } = req.body;
        if (!responseUrl) return res.status(400).json({ error: 'responseUrl required' });

        console.log(`📥 Fetching result from: ${responseUrl}`);
        const resultRes = await fetch(responseUrl, {
            headers: { 'Authorization': `Key ${falKey}` },
        });

        if (!resultRes.ok) {
            const errText = await resultRes.text();
            console.error(`❌ Result fetch [${resultRes.status}]: ${errText.slice(0, 200)}`);
            return res.status(resultRes.status).json({ error: `Result fetch failed: ${errText.slice(0, 100)}` });
        }

        const result = await resultRes.json();
        console.log(`✅ Result keys: [${Object.keys(result).join(', ')}]`);
        console.log(`✅ Full result: ${JSON.stringify(result).slice(0, 500)}`);
        res.json({ status: 'COMPLETED', result });
    } catch (err) {
        console.error('❌ Media result error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════
// ─── REDDIT OAUTH & AGENTS ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

import axios from 'axios';

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDIRECT_URI = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/reddit/callback`
    : 'http://localhost:3000/api/reddit/callback';

// ─── GET /api/reddit/auth ─────────────────────────────────────────
// Redirects the user to Reddit to authorize the app
app.get('/api/reddit/auth', (req, res) => {
    if (!REDDIT_CLIENT_ID) {
        return res.status(500).send('REDDIT_CLIENT_ID is not configured in environment variables.');
    }

    const { agentId } = req.query;
    if (!agentId) {
        return res.status(400).send('agentId query parameter is required');
    }

    // State encodes the agentId so we know which agent to link the token to on callback
    const state = Buffer.from(JSON.stringify({ agentId })).toString('base64');
    const scope = 'read submit identity'; // read posts, submit comments, identity
    const duration = 'permanent'; // required to get a refresh_token

    const authUrl = `https://www.reddit.com/api/v1/authorize?` +
        `client_id=${REDDIT_CLIENT_ID}` +
        `&response_type=code` +
        `&state=${state}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&duration=${duration}` +
        `&scope=${encodeURIComponent(scope)}`;

    res.redirect(authUrl);
});

// ─── GET /api/reddit/callback ─────────────────────────────────────
// Handles the redirect from Reddit and exchanges code for tokens
app.get('/api/reddit/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.send(`<h2>Reddit Auth Failed</h2><p>${error}</p><script>setTimeout(() => window.close(), 3000);</script>`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state');
    }

    let agentId;
    try {
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('ascii'));
        agentId = decodedState.agentId;
    } catch (e) {
        return res.status(400).send('Invalid state parameter');
    }

    try {
        // Exchange code for tokens
        const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
        const tokenResponse = await axios.post('https://www.reddit.com/api/v1/access_token',
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            }).toString(),
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'CeleritechOrbit/1.0.0'
                }
            }
        );

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        if (!refresh_token) {
            console.warn('No refresh token received. Ensure duration=permanent is set.');
            return res.send(`<h2>Authorization Error</h2><p>No refresh token granted by Reddit.</p><script>setTimeout(() => window.close(), 3000);</script>`);
        }

        // Fetch the Reddit username to display in the UI
        const meResponse = await axios.get('https://oauth.reddit.com/api/v1/me', {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'User-Agent': 'CeleritechOrbit/1.0.0'
            }
        });

        const redditUsername = meResponse.data.name;

        if (!useKV) {
            return res.status(500).send('<h2>OAuth Error</h2><p>No Redis credentials configured.</p>');
        }

        // Save to Redis database
        await redisSet(`reddit_agent_token:${agentId}`, {
            refresh_token,
            username: redditUsername,
            updatedAt: Date.now()
        });

        // Return a script that posts a message back to the main window and closes the popup
        res.send(`
            <html>
            <body style="font-family: system-ui; text-align: center; padding: 40px;">
                <h2 style="color: #10b981;">Successfully Connected!</h2>
                <p>Linked agent to Reddit account: <strong>u/${redditUsername}</strong></p>
                <p>You can close this window.</p>
                <script>
                    if (window.opener) {
                        window.opener.postMessage({ type: 'REDDIT_AUTH_SUCCESS', agentId: '${agentId}', username: '${redditUsername}' }, '*');
                    }
                    setTimeout(() => window.close(), 2000);
                </script>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('Reddit OAuth Callback Error:', err.response?.data || err.message);
        res.status(500).send(`<h2>OAuth Error</h2><p>Failed to exchange code for tokens. Ensure Vercel KV is configured.</p><pre>${err.message}</pre>`);
    }
});

// ─── TEMPORARY: Debug Environment Variables ─────────────────────
app.get('/api/debug-env', (req, res) => {
    res.json({
        redisConfigured: useKV,
        REDIS_URL_exists: !!process.env.REDIS_URL,
        KV_URL_exists: !!process.env.KV_URL,
        VERCEL: !!process.env.VERCEL,
        NODE_ENV: process.env.NODE_ENV,
    });
});

// ─── GET /api/health ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
// ─── SOCIAL OAUTH CONNECTIONS ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// In-memory token store (for dev); in production use Redis
const socialTokens = {};

async function getSocialTokens() {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => {});
            const data = await r.get('orbit_social_tokens');
            return data ? JSON.parse(data) : {};
        } catch { return {}; }
    }
    return socialTokens;
}

async function saveSocialToken(platform, tokenData) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => {});
            const tokens = JSON.parse(await r.get('orbit_social_tokens') || '{}');
            tokens[platform] = tokenData;
            await r.set('orbit_social_tokens', JSON.stringify(tokens));
        } catch (err) { console.error('Redis token save error:', err.message); }
    }
    socialTokens[platform] = tokenData;
}

async function removeSocialToken(platform) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => {});
            const tokens = JSON.parse(await r.get('orbit_social_tokens') || '{}');
            delete tokens[platform];
            await r.set('orbit_social_tokens', JSON.stringify(tokens));
        } catch (err) { console.error('Redis token remove error:', err.message); }
    }
    delete socialTokens[platform];
}

// Platform OAuth configs
function getOAuthConfig(platform, req) {
    // Use the request's actual host so redirect URI matches the domain the user is on
    let baseUrl;
    if (req && req.headers && req.headers.host) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        baseUrl = `${proto}://${req.headers.host}`;
    } else {
        baseUrl = process.env.APP_URL
            || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
            || `http://localhost:${PORT}`;
    }
    const redirectUri = `${baseUrl}/api/oauth/callback`;

    const configs = {
        facebook: {
            clientId: process.env.FACEBOOK_APP_ID,
            clientSecret: process.env.FACEBOOK_APP_SECRET,
            authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
            tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
            scopes: 'pages_show_list,pages_read_engagement,pages_manage_posts',
            profileUrl: 'https://graph.facebook.com/me?fields=name,email',
        },
        instagram: {
            clientId: process.env.INSTAGRAM_APP_ID,
            clientSecret: process.env.INSTAGRAM_APP_SECRET,
            authorizeUrl: 'https://www.instagram.com/oauth/authorize',
            tokenUrl: 'https://api.instagram.com/oauth/access_token',
            scopes: 'instagram_business_basic,instagram_manage_comments,instagram_business_manage_messages',
            profileUrl: 'https://graph.instagram.com/me?fields=user_id,username',
            extraParams: { enable_signup: 'true' },
        },
        youtube: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
            profileUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
            extraParams: { access_type: 'offline', prompt: 'consent' },
        },
        x: {
            clientId: process.env.X_CLIENT_ID,
            clientSecret: process.env.X_CLIENT_SECRET,
            authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
            tokenUrl: 'https://api.x.com/2/oauth2/token',
            scopes: 'tweet.read tweet.write users.read offline.access',
            profileUrl: 'https://api.x.com/2/users/me',
            usePKCE: true,
        },
        linkedin: {
            clientId: process.env.LINKEDIN_CLIENT_ID,
            clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
            authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
            tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
            scopes: 'openid profile w_member_social',
            profileUrl: 'https://api.linkedin.com/v2/userinfo',
        },
    };
    const cfg = configs[platform];
    if (cfg) cfg.redirectUri = redirectUri;
    return cfg;
}

// PKCE helper for X (Twitter)
function generateCodeVerifier() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    for (let i = 0; i < 64; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// Temporary PKCE store
const pkceStore = {};

// ─── GET /api/oauth/:platform/connect ───────────────────────────
app.get('/api/oauth/:platform/connect', (req, res) => {
    const { platform } = req.params;
    const cfg = getOAuthConfig(platform, req);
    if (!cfg) return res.status(400).json({ error: `Unknown platform: ${platform}` });
    if (!cfg.clientId) {
        return res.status(400).json({
            error: `${platform} OAuth not configured. Set the required env vars.`,
            required: platform === 'facebook'
                ? ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET']
                : platform === 'instagram'
                    ? ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET']
                : platform === 'youtube'
                    ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
                    : platform === 'x'
                        ? ['X_CLIENT_ID', 'X_CLIENT_SECRET']
                        : ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
        });
    }

    const state = `${platform}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: cfg.scopes,
        state,
    });

    // Extra params (e.g. YouTube needs access_type=offline)
    if (cfg.extraParams) {
        for (const [k, v] of Object.entries(cfg.extraParams)) params.set(k, v);
    }

    // PKCE for X
    if (cfg.usePKCE) {
        const codeVerifier = generateCodeVerifier();
        pkceStore[state] = codeVerifier;
        params.set('code_challenge', codeVerifier); // plain method
        params.set('code_challenge_method', 'plain');
    }

    const authUrl = `${cfg.authorizeUrl}?${params.toString()}`;
    console.log(`🔗 OAuth redirect for ${platform}: ${authUrl.slice(0, 120)}...`);
    res.redirect(authUrl);
});

// ─── GET /api/oauth/callback ────────────────────────────────────
app.get('/api/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.error(`OAuth error: ${error}`);
        return res.send(oauthResultPage('error', null, `Authorization denied: ${error}`));
    }

    if (!code || !state) {
        return res.status(400).send(oauthResultPage('error', null, 'Missing code or state'));
    }

    // Extract platform from state
    const platform = state.split('_')[0];
    const cfg = getOAuthConfig(platform, req);
    if (!cfg) return res.status(400).send(oauthResultPage('error', platform, 'Unknown platform'));

    try {
        // Exchange code for access token
        const tokenParams = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: cfg.redirectUri,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
        });

        // PKCE verifier for X
        if (cfg.usePKCE && pkceStore[state]) {
            tokenParams.set('code_verifier', pkceStore[state]);
            delete pkceStore[state];
        }

        const tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

        // X (Twitter) requires Basic auth for token exchange
        if (platform === 'x') {
            const basicAuth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
            tokenHeaders['Authorization'] = `Basic ${basicAuth}`;
        }

        const tokenRes = await fetch(cfg.tokenUrl, {
            method: 'POST',
            headers: tokenHeaders,
            body: tokenParams.toString(),
        });

        let tokenData;
        const contentType = tokenRes.headers.get('content-type') || '';
        if (contentType.includes('json')) {
            tokenData = await tokenRes.json();
        } else {
            // Facebook sometimes returns URL-encoded
            const text = await tokenRes.text();
            try { tokenData = JSON.parse(text); } catch {
                tokenData = Object.fromEntries(new URLSearchParams(text));
            }
        }

        if (!tokenRes.ok || tokenData.error) {
            console.error(`Token exchange error for ${platform}:`, tokenData);
            return res.send(oauthResultPage('error', platform,
                tokenData.error_description || tokenData.error || 'Token exchange failed'));
        }

        const accessToken = tokenData.access_token;
        if (!accessToken) {
            return res.send(oauthResultPage('error', platform, 'No access token received'));
        }

        // Fetch profile info
        let profileName = 'Connected Account';
        try {
            const profileHeaders = { Authorization: `Bearer ${accessToken}` };
            const profileRes = await fetch(cfg.profileUrl, { headers: profileHeaders });
            if (profileRes.ok) {
                const profile = await profileRes.json();
                if (platform === 'youtube') {
                    profileName = profile.items?.[0]?.snippet?.title || profileName;
                } else if (platform === 'x') {
                    profileName = profile.data?.name || profile.data?.username || profileName;
                } else if (platform === 'linkedin') {
                    profileName = profile.name || profile.given_name || profileName;
                } else if (platform === 'instagram') {
                    profileName = profile.username || profile.name || profileName;
                } else {
                    profileName = profile.name || profileName;
                }
            }
        } catch (profileErr) {
            console.error(`Profile fetch error for ${platform}:`, profileErr.message);
        }

        // Save token
        await saveSocialToken(platform, {
            accessToken,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: tokenData.expires_in
                ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
                : null,
            profileName,
            connectedAt: new Date().toISOString(),
        });

        console.log(`✅ ${platform} connected as "${profileName}"`);
        res.send(oauthResultPage('success', platform, profileName));

    } catch (err) {
        console.error(`OAuth callback error for ${platform}:`, err);
        res.send(oauthResultPage('error', platform, err.message));
    }
});

// ─── GET /api/oauth/status ──────────────────────────────────────
app.get('/api/oauth/status', async (req, res) => {
    const tokens = await getSocialTokens();
    const status = {};
    for (const platform of ['facebook', 'instagram', 'youtube', 'x', 'linkedin']) {
        const token = tokens[platform];
        if (token?.accessToken) {
            status[platform] = {
                connected: true,
                name: token.profileName || 'Connected',
                connectedAt: token.connectedAt,
                expiresAt: token.expiresAt,
            };
        } else {
            status[platform] = { connected: false };
        }
    }
    res.json(status);
});

// ─── POST /api/oauth/:platform/disconnect ───────────────────────
app.post('/api/oauth/:platform/disconnect', async (req, res) => {
    const { platform } = req.params;
    await removeSocialToken(platform);
    console.log(`🔌 ${platform} disconnected`);
    res.json({ success: true, platform });
});

// ─── POST /api/data-deletion (Meta callback + user form) ────────
app.post('/api/data-deletion', async (req, res) => {
    const { email, name, reason, signed_request } = req.body;

    // Meta sends a signed_request for deauthorisation callbacks
    if (signed_request) {
        console.log('🗑️ Meta data deletion callback received');
        // Parse the signed_request to get user_id (Meta format)
        try {
            const payload = signed_request.split('.')[1];
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
            console.log(`🗑️ Meta user ${decoded.user_id} requested data deletion`);
            // Remove all social tokens (we don't have per-user yet, but clear what we can)
            await removeSocialToken('facebook');
            await removeSocialToken('instagram');
        } catch (e) {
            console.error('Meta signed_request parse error:', e.message);
        }
        // Meta expects a JSON response with a confirmation URL and code
        const confirmCode = `DEL_${Date.now()}`;
        return res.json({
            url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:' + PORT}/data-deletion.html`,
            confirmation_code: confirmCode,
        });
    }

    // User-submitted form
    if (email) {
        console.log(`🗑️ Data deletion request from ${email} (${name || 'anonymous'}). Reason: ${reason || 'none'}`);
        
        // Remove user from database
        try {
            let users = await getUsers();
            const userIndex = users.findIndex(u => u.email === email.toLowerCase());
            if (userIndex >= 0) {
                users.splice(userIndex, 1);
                await saveUsers(users);
                console.log(`✅ User ${email} deleted from database`);
            }
            // Clear all social tokens
            for (const p of ['facebook', 'instagram', 'youtube', 'x', 'linkedin']) {
                await removeSocialToken(p);
            }
        } catch (err) {
            console.error('Data deletion error:', err.message);
        }
    }

    res.json({ success: true, message: 'Deletion request received. Your data will be removed within 30 days.' });
});

// ─── OAuth result page (closes popup + notifies parent) ─────────
function oauthResultPage(status, platform, detail) {
    const isSuccess = status === 'success';
    return `<!DOCTYPE html>
<html><head><title>OAuth ${isSuccess ? 'Success' : 'Error'}</title>
<style>
  body { font-family: 'Inter', -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #f1f5f9; }
  .card { text-align: center; padding: 48px; border-radius: 20px; background: #1e293b; border: 1px solid #334155; max-width: 400px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { margin: 0 0 8px; font-size: 1.3rem; }
  p { margin: 0; color: #94a3b8; font-size: 0.9rem; }
  .closing { margin-top: 20px; font-size: 0.8rem; color: #64748b; }
</style></head><body>
<div class="card">
  <div class="icon">${isSuccess ? '✅' : '❌'}</div>
  <h2>${isSuccess ? `${platform} Connected!` : 'Connection Failed'}</h2>
  <p>${isSuccess ? `Signed in as ${detail}` : detail || 'Unknown error'}</p>
  <p class="closing">This window will close automatically...</p>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth_result', status: '${status}', platform: '${platform || ''}', detail: '${(detail || '').replace(/'/g, "\\'")}' }, '*');
  }
  setTimeout(() => window.close(), 2500);
</script>
</body></html>`;
}

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            anthropic: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key',
            gemini: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'placeholder',
            openrouter: !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key',
            perplexity: !!process.env.PERPLEXITY_API_KEY && process.env.PERPLEXITY_API_KEY !== 'your_perplexity_api_key',
            vapi: !!process.env.VAPI_API_KEY,
            fal: !!process.env.FAL_KEY,
            wordpress: !!process.env.WORDPRESS_URL && process.env.WORDPRESS_URL !== 'https://yoursite.com',
            facebook: !!process.env.FACEBOOK_APP_ID,
            google: !!process.env.GOOGLE_CLIENT_ID,
            x: !!process.env.X_CLIENT_ID,
            linkedin: !!process.env.LINKEDIN_CLIENT_ID,
        },
    });
});

// ─── POST /api/onepager/generate (SSE) ──────────────────────────
app.post('/api/onepager/generate', async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    function send(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

    try {
        const { description, withImage, columns } = req.body;
        if (!description) {
            send({ type: 'error', error: 'Description is required' });
            res.end();
            return;
        }

        const totalSteps = withImage ? 3 : 2;

        // Step 1: Use Claude to generate the premium one-pager content
        send({ type: 'progress', step: 1, total: totalSteps, message: 'Crafting premium one-pager with AI…' });

        const contentResponse = await callClaude({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: `You are an elite B2B marketing copywriter and document designer. Your job is to take the user's EXACT input text and transform it into a premium editorial one-pager.

IMPORTANT: You must extract and USE the specific information from the user's text below. Do NOT invent features, metrics, or details that aren't mentioned or strongly implied. Your job is to ORGANIZE and PRESENT their content beautifully, not to make things up.

USER'S INPUT TEXT:
"""
${description}
"""

INSTRUCTIONS:
1. Read the input carefully. Extract: product/service name, target audience, key features, metrics/numbers, pain points, and any specific claims.
2. Use THEIR words, THEIR product name, THEIR features. Rephrase for clarity and punch, but stay faithful to what they actually wrote.
3. If they mention specific numbers (e.g. "10 days", "50%", "24/7"), use those exact numbers in the stats section.
4. If they don't mention specific numbers, derive reasonable ones from context (e.g. if they say "fast implementation" → "< 2 weeks").
5. The headline should capture the CORE message of their text, not a generic marketing tagline.

Return ONLY a JSON object with this exact structure:
{
  "companyProduct": "CELERITECH · [EXACT PRODUCT NAME FROM THE TEXT, IN CAPS]",
  "briefFor": "A BRIEF FOR [TARGET AUDIENCE MENTIONED IN THE TEXT, IN CAPS]",
  "tags": "[PRODUCT CATEGORY] · ONE PAGE · THREE MINUTES",
  "headline": "A bold headline derived from the user's core message (6-10 words). Use their language, make it editorial.",
  "accentWord": "One powerful word from the headline to emphasize (must appear exactly in headline)",
  "subtitle": "A 1-2 sentence paragraph (max 40 words) summarizing the core value proposition with specific details.",
  "stats": [
    { "value": "[Number from their text or derived]", "label": "[WHAT IT MEANS, CAPS]" },
    { "value": "[Second metric]", "label": "[LABEL]" },
    { "value": "[Third metric]", "label": "[LABEL]" }
  ],
  "sections": [
    {
      "number": "01",
      "title": "A section title using concepts from the user's text",
      "type": "checklist",
      "items": ["Feature 1 from their text", "Feature 2", "Feature 3", "Feature 4", "Feature 5"],
      "callout": "A provocative one-liner (max 15 words). **Bold the key phrase.**"
    },
    {
      "number": "02",
      "title": "What changes when [transformation they describe] happens",
      "type": "comparison",
      "items": [
        { "before": "Pain point (short)", "after": "Solution (short)" },
        { "before": "Second pain", "after": "Their solution" },
        { "before": "Third pain", "after": "Their solution" }
      ]
    }
  ],
  "darkBanner": {
    "headline": "A manifesto line using their core value proposition (max 12 words)",
    "tags": ["Feature 1", "Feature 2", "Feature 3", "Feature 4"]
  },
  "cta": {
    "headline": "Start with [their problem space] — 15 minutes, no pitch.",
    "description": "One sentence next step referencing their offering."
  },
  "contact": {
    "email": "info@celeritech.com",
    "phone": "+1 (786) 331-1281",
    "website": "celeritech.biz"
  }
}

CRITICAL RULES:
- EVERYTHING MUST FIT ON A SINGLE PRINTED PAGE — keep all text extremely concise
- USE THE USER'S EXACT PRODUCT NAME — do not rename or rebrand it
- USE THE USER'S EXACT TARGET AUDIENCE — do not change who they're targeting
- EXTRACT features and capabilities from their text — do not invent ones they didn't mention
- If the user mentions specific numbers/metrics, use them EXACTLY in the stats
- Generate EXACTLY 3 stats (extract from text or derive logically)
- accentWord must be a SINGLE word that appears EXACTLY in the headline
- Checklist: 4-5 items, keep each under 10 words
- Comparison: 3 rows, keep each before/after under 10 words
- Dark banner tags: EXACTLY 4 tags
- NO testimonials — skip them entirely to save space
- CTA: NO options array — just headline and description
- Every text field should be as concise as possible
- Return ONLY valid JSON, no markdown fences, no comments`,
            }],
        });

        let content;
        try {
            const raw = contentResponse.content[0].text.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            content = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
        } catch (parseErr) {
            console.error('Failed to parse one-pager content:', parseErr.message);
            send({ type: 'error', error: 'Failed to parse AI-generated content' });
            res.end();
            return;
        }

        console.log(`📄 One-pager content generated: "${content.headline}" (${content.sections?.length || 0} sections)`);

        // Step 2: Generate header image if requested
        let headerImageDataUrl = null;
        if (withImage) {
            send({ type: 'progress', step: 2, total: totalSteps, message: 'Generating header image…' });

            const imgPrompt = `Professional marketing banner for "${content.headline}". Clean, modern, corporate design with subtle gradients. Premium stock photo quality. Wide aspect ratio. No text, no logos, no watermarks.`;
            const img = await generateOnePagerImage(imgPrompt);
            if (img && img.buffer) {
                headerImageDataUrl = `data:${img.mimeType};base64,${img.buffer.toString('base64')}`;
                console.log('🖼️ Header image generated');
            } else {
                console.log('⚠ Header image generation failed, continuing without');
            }
        }

        // Final step: Send result
        send({ type: 'progress', step: totalSteps, total: totalSteps, message: 'Finalizing one-pager…' });

        send({
            type: 'result',
            ...content,
            headerImage: headerImageDataUrl,
        });

        console.log('✅ One-pager generation complete');

    } catch (err) {
        console.error('❌ One-pager generation error:', err);
        send({ type: 'error', error: err.message || 'Generation failed' });
    }
    res.end();
});

// ============================================
// LEAD GENERATION - Campaigns & Leads API
// ============================================

const CAMPAIGNS_FILE = isVercel ? '/tmp/campaigns.json' : join(__dirname, 'campaigns.json');
const LEADS_FILE = isVercel ? '/tmp/leads.json' : join(__dirname, 'leads.json');

// ─── Campaign Storage (Redis + JSON fallback) ──────────────────
async function loadCampaigns() {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get('orbit_campaigns');
            return data ? JSON.parse(data) : [];
        } catch (err) {
            console.error('Redis loadCampaigns error:', err.message);
            // Fall through to file
        }
    }
    if (!existsSync(CAMPAIGNS_FILE)) return [];
    try { return JSON.parse(readFileSync(CAMPAIGNS_FILE, 'utf-8')); } catch { return []; }
}

async function saveCampaigns(campaigns) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set('orbit_campaigns', JSON.stringify(campaigns));
        } catch (err) {
            console.error('Redis saveCampaigns error:', err.message);
        }
    }
    // Always write to file as well (local fallback)
    try { writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2), 'utf-8'); } catch { }
}

// ─── Lead Storage (Redis + JSON fallback) ───────────────────────
async function loadLeads() {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get('orbit_leads');
            return data ? JSON.parse(data) : [];
        } catch (err) {
            console.error('Redis loadLeads error:', err.message);
        }
    }
    if (!existsSync(LEADS_FILE)) return [];
    try { return JSON.parse(readFileSync(LEADS_FILE, 'utf-8')); } catch { return []; }
}

async function saveLeads(leads) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set('orbit_leads', JSON.stringify(leads));
        } catch (err) {
            console.error('Redis saveLeads error:', err.message);
        }
    }
    try { writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8'); } catch { }
}

async function loadCampaignLeads(campaignId) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get(`orbit_campaign:${campaignId}:leads`);
            return data ? JSON.parse(data) : [];
        } catch (err) {
            console.error('Redis loadCampaignLeads error:', err.message);
        }
    }
    // Fallback: filter all leads by campaignId
    const allLeads = await loadLeads();
    return allLeads.filter(l => l.campaignId === campaignId);
}

async function saveCampaignLeads(campaignId, leads) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set(`orbit_campaign:${campaignId}:leads`, JSON.stringify(leads));
        } catch (err) {
            console.error('Redis saveCampaignLeads error:', err.message);
        }
    }
    // Also sync to global leads file
    const allLeads = await loadLeads();
    const otherLeads = allLeads.filter(l => l.campaignId !== campaignId);
    await saveLeads([...otherLeads, ...leads]);
}

async function loadLead(leadId) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            const data = await r.get(`orbit_lead:${leadId}`);
            if (data) return JSON.parse(data);
        } catch (err) {
            console.error('Redis loadLead error:', err.message);
        }
    }
    const allLeads = await loadLeads();
    return allLeads.find(l => l.id === leadId) || null;
}

async function saveLead(lead) {
    if (useKV) {
        try {
            const r = getRedis();
            await r.connect().catch(() => { });
            await r.set(`orbit_lead:${lead.id}`, JSON.stringify(lead));
        } catch (err) {
            console.error('Redis saveLead error:', err.message);
        }
    }
    // Sync to global leads and campaign leads
    const allLeads = await loadLeads();
    const idx = allLeads.findIndex(l => l.id === lead.id);
    if (idx >= 0) {
        allLeads[idx] = lead;
    } else {
        allLeads.push(lead);
    }
    await saveLeads(allLeads);

    // Also update campaign leads array
    if (lead.campaignId) {
        const campLeads = await loadCampaignLeads(lead.campaignId);
        const cIdx = campLeads.findIndex(l => l.id === lead.id);
        if (cIdx >= 0) {
            campLeads[cIdx] = lead;
        } else {
            campLeads.push(lead);
        }
        await saveCampaignLeads(lead.campaignId, campLeads);
    }
}

// ─── POST /api/campaigns — Create campaign ─────────────────────
app.post('/api/campaigns', async (req, res) => {
    try {
        const { name, config } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Campaign name is required' });
        }

        const campaign = {
            id: 'camp_' + Date.now().toString(36),
            name,
            config: {
                industry: config?.industry || '',
                subCategories: config?.subCategories || [],
                customKeywords: config?.customKeywords || [],
                employeeRange: config?.employeeRange || { min: 10, max: 500 },
                revenueRange: config?.revenueRange || { min: 0, max: 0 },
                regions: config?.regions || [],
                cities: config?.cities || [],
                scheduleHours: config?.scheduleHours || 24,
                autoEmail: config?.autoEmail ?? false,
                minScoreForEmail: config?.minScoreForEmail || 70,
                minScoreForGHL: config?.minScoreForGHL || 80,
                autoCall: config?.autoCall ?? false,
                maxEmailsPerLead: config?.maxEmailsPerLead || 3,
                followUpDays: config?.followUpDays || [3, 7, 14],
                emailTemplate: config?.emailTemplate || '',
            },
            status: 'draft',
            stats: {
                totalFound: 0,
                qualified: 0,
                emailed: 0,
                replied: 0,
                meetingsBooked: 0,
                disqualified: 0,
                lastRunAt: null,
                nextRunAt: null,
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const campaigns = await loadCampaigns();
        campaigns.unshift(campaign);
        await saveCampaigns(campaigns);

        console.log(`🎯 Campaign created: "${campaign.name}" (${campaign.id})`);
        res.json(campaign);
    } catch (err) {
        console.error('❌ Create campaign error:', err);
        res.status(500).json({ error: err.message || 'Failed to create campaign' });
    }
});

// ─── GET /api/campaigns — List all campaigns ───────────────────
app.get('/api/campaigns', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        res.json(campaigns);
    } catch (err) {
        console.error('❌ List campaigns error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/campaigns/:id — Get single campaign with stats ───
app.get('/api/campaigns/:id', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const campaign = campaigns.find(c => c.id === req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        res.json(campaign);
    } catch (err) {
        console.error('❌ Get campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/campaigns/:id — Update campaign config ───────────
app.put('/api/campaigns/:id', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const idx = campaigns.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

        const { name, config, status } = req.body;
        if (name !== undefined) campaigns[idx].name = name;
        if (status !== undefined) campaigns[idx].status = status;
        if (config !== undefined) {
            campaigns[idx].config = { ...campaigns[idx].config, ...config };
        }
        campaigns[idx].updatedAt = new Date().toISOString();
        await saveCampaigns(campaigns);

        res.json(campaigns[idx]);
    } catch (err) {
        console.error('❌ Update campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/campaigns/:id — Delete campaign + its leads ───
app.delete('/api/campaigns/:id', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaigns = await loadCampaigns();
        const filtered = campaigns.filter(c => c.id !== campaignId);
        await saveCampaigns(filtered);

        // Delete associated leads from Redis
        if (useKV) {
            try {
                const r = getRedis();
                await r.connect().catch(() => { });
                await r.del(`orbit_campaign:${campaignId}:leads`);
            } catch (err) {
                console.error('Redis delete campaign leads error:', err.message);
            }
        }

        // Remove associated leads from JSON fallback
        const allLeads = await loadLeads();
        const remainingLeads = allLeads.filter(l => l.campaignId !== campaignId);
        await saveLeads(remainingLeads);

        console.log(`🗑️ Campaign deleted: ${campaignId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/campaigns/:id/deploy — Deploy agent ─────────────
app.post('/api/campaigns/:id/deploy', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const idx = campaigns.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

        const campaign = campaigns[idx];

        // Call Python service
        try {
            const pyRes = await fetch('http://localhost:3002/agents/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    campaignId: campaign.id,
                    name: campaign.name,
                    config: campaign.config,
                }),
            });

            if (!pyRes.ok) {
                const errText = await pyRes.text();
                throw new Error(`Python service error (${pyRes.status}): ${errText}`);
            }

            const pyData = await pyRes.json();
            campaigns[idx].status = 'running';
            campaigns[idx].stats.lastRunAt = new Date().toISOString();
            campaigns[idx].updatedAt = new Date().toISOString();
            await saveCampaigns(campaigns);

            console.log(`🚀 Campaign deployed: "${campaign.name}" (${campaign.id})`);
            res.json({ success: true, campaign: campaigns[idx], agentResponse: pyData });
        } catch (fetchErr) {
            if (fetchErr.cause?.code === 'ECONNREFUSED' || fetchErr.message?.includes('ECONNREFUSED') || fetchErr.message?.includes('fetch failed')) {
                console.error('❌ Python scraping service not reachable at http://localhost:3002');
                return res.status(503).json({
                    error: 'Lead generation service is not running. Start the Python service on port 3002.',
                    hint: 'Run: cd scraper && python main.py',
                });
            }
            throw fetchErr;
        }
    } catch (err) {
        console.error('❌ Deploy campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/campaigns/:id/pause — Pause agent ───────────────
app.post('/api/campaigns/:id/pause', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const idx = campaigns.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

        try {
            const pyRes = await fetch(`http://localhost:3002/agents/${req.params.id}/pause`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!pyRes.ok) {
                const errText = await pyRes.text();
                throw new Error(`Python service error (${pyRes.status}): ${errText}`);
            }
        } catch (fetchErr) {
            if (fetchErr.cause?.code === 'ECONNREFUSED' || fetchErr.message?.includes('ECONNREFUSED') || fetchErr.message?.includes('fetch failed')) {
                return res.status(503).json({ error: 'Lead generation service is not running.' });
            }
            throw fetchErr;
        }

        campaigns[idx].status = 'paused';
        campaigns[idx].updatedAt = new Date().toISOString();
        await saveCampaigns(campaigns);

        console.log(`⏸️ Campaign paused: ${req.params.id}`);
        res.json({ success: true, campaign: campaigns[idx] });
    } catch (err) {
        console.error('❌ Pause campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/campaigns/:id/resume — Resume agent ─────────────
app.post('/api/campaigns/:id/resume', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const idx = campaigns.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

        try {
            const pyRes = await fetch(`http://localhost:3002/agents/${req.params.id}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!pyRes.ok) {
                const errText = await pyRes.text();
                throw new Error(`Python service error (${pyRes.status}): ${errText}`);
            }
        } catch (fetchErr) {
            if (fetchErr.cause?.code === 'ECONNREFUSED' || fetchErr.message?.includes('ECONNREFUSED') || fetchErr.message?.includes('fetch failed')) {
                return res.status(503).json({ error: 'Lead generation service is not running.' });
            }
            throw fetchErr;
        }

        campaigns[idx].status = 'running';
        campaigns[idx].updatedAt = new Date().toISOString();
        await saveCampaigns(campaigns);

        console.log(`▶️ Campaign resumed: ${req.params.id}`);
        res.json({ success: true, campaign: campaigns[idx] });
    } catch (err) {
        console.error('❌ Resume campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/campaigns/:id/run-now — Trigger immediate run ───
app.post('/api/campaigns/:id/run-now', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const campaign = campaigns.find(c => c.id === req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        try {
            const pyRes = await fetch(`http://localhost:3002/agents/${req.params.id}/run-now`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!pyRes.ok) {
                const errText = await pyRes.text();
                throw new Error(`Python service error (${pyRes.status}): ${errText}`);
            }

            const pyData = await pyRes.json();
            console.log(`⚡ Campaign run-now triggered: ${req.params.id}`);
            res.json({ success: true, agentResponse: pyData });
        } catch (fetchErr) {
            if (fetchErr.cause?.code === 'ECONNREFUSED' || fetchErr.message?.includes('ECONNREFUSED') || fetchErr.message?.includes('fetch failed')) {
                return res.status(503).json({ error: 'Lead generation service is not running.' });
            }
            throw fetchErr;
        }
    } catch (err) {
        console.error('❌ Run-now campaign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/campaigns/:id/stats — Get campaign statistics ────
app.get('/api/campaigns/:id/stats', async (req, res) => {
    try {
        const campaigns = await loadCampaigns();
        const campaign = campaigns.find(c => c.id === req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        // Compute live stats from leads
        const leads = await loadCampaignLeads(req.params.id);
        const stats = {
            ...campaign.stats,
            totalFound: leads.length,
            qualified: leads.filter(l => l.status === 'qualified' || l.status === 'emailed' || l.status === 'replied').length,
            emailed: leads.filter(l => l.outreach?.emailSequence?.length > 0).length,
            replied: leads.filter(l => l.status === 'replied').length,
            meetingsBooked: leads.filter(l => l.status === 'meeting_booked').length,
            disqualified: leads.filter(l => l.status === 'disqualified').length,
        };

        res.json({ campaignId: campaign.id, name: campaign.name, status: campaign.status, stats });
    } catch (err) {
        console.error('❌ Campaign stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/campaigns/:id/leads — List leads for campaign ────
app.get('/api/campaigns/:id/leads', async (req, res) => {
    try {
        let leads = await loadCampaignLeads(req.params.id);

        // Apply filters from query params
        const { status, minScore, search } = req.query;

        if (status) {
            leads = leads.filter(l => l.status === status);
        }
        if (minScore) {
            const min = parseInt(minScore);
            if (!isNaN(min)) {
                leads = leads.filter(l => (l.score || 0) >= min);
            }
        }
        if (search) {
            const q = search.toLowerCase();
            leads = leads.filter(l =>
                (l.company?.name || '').toLowerCase().includes(q) ||
                (l.contact?.name || '').toLowerCase().includes(q) ||
                (l.contact?.email || '').toLowerCase().includes(q) ||
                (l.company?.industry || '').toLowerCase().includes(q)
            );
        }

        // Sort by score descending
        leads.sort((a, b) => (b.score || 0) - (a.score || 0));

        res.json(leads);
    } catch (err) {
        console.error('❌ List leads error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/campaigns/:id/leads/export — Export leads as JSON ─
app.post('/api/campaigns/:id/leads/export', async (req, res) => {
    try {
        const leads = await loadCampaignLeads(req.params.id);
        res.json({ campaignId: req.params.id, count: leads.length, leads });
    } catch (err) {
        console.error('❌ Export leads error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/leads/:id — Get full lead details ────────────────
app.get('/api/leads/:id', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        res.json(lead);
    } catch (err) {
        console.error('❌ Get lead error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/leads/:id — Update lead ──────────────────────────
app.put('/api/leads/:id', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const { status, notes, score, contact, company, outreach, tags } = req.body;
        if (status !== undefined) lead.status = status;
        if (notes !== undefined) lead.notes = notes;
        if (score !== undefined) lead.score = score;
        if (tags !== undefined) lead.tags = tags;
        if (contact !== undefined) lead.contact = { ...lead.contact, ...contact };
        if (company !== undefined) lead.company = { ...lead.company, ...company };
        if (outreach !== undefined) lead.outreach = { ...lead.outreach, ...outreach };
        lead.updatedAt = new Date().toISOString();

        await saveLead(lead);
        res.json(lead);
    } catch (err) {
        console.error('❌ Update lead error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/leads/:id — Delete a lead ─────────────────────
app.delete('/api/leads/:id', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        // Remove from campaign leads
        if (lead.campaignId) {
            const campLeads = await loadCampaignLeads(lead.campaignId);
            const filtered = campLeads.filter(l => l.id !== lead.id);
            await saveCampaignLeads(lead.campaignId, filtered);
        }

        // Remove from global leads
        const allLeads = await loadLeads();
        const remaining = allLeads.filter(l => l.id !== lead.id);
        await saveLeads(remaining);

        // Remove individual lead from Redis
        if (useKV) {
            try {
                const r = getRedis();
                await r.connect().catch(() => { });
                await r.del(`orbit_lead:${lead.id}`);
            } catch (err) {
                console.error('Redis delete lead error:', err.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete lead error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/email — Send email to lead ────────────
app.post('/api/leads/:id/email', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        let { to, subject, body } = req.body;

        // Default recipient from lead data
        to = to || lead.contact?.email;
        if (!to) {
            return res.status(400).json({ error: 'No email address available for this lead' });
        }

        // If no body provided, try to use qualification emailDraft or generate with Claude
        if (!body) {
            if (lead.qualification?.emailDraft) {
                body = lead.qualification.emailDraft;
                subject = subject || `Following up: ${lead.company?.name || 'Your Business'}`;
            } else {
                // Generate personalized email with Claude
                try {
                    const emailResponse = await callClaude({
                        model: 'claude-sonnet-4-6',
                        max_tokens: 1024,
                        messages: [{
                            role: 'user',
                            content: `Write a short, professional cold outreach email to ${lead.contact?.name || 'the decision maker'} at ${lead.company?.name || 'their company'}${lead.company?.industry ? ` in the ${lead.company.industry} industry` : ''}.

The email should:
- Be personalized and reference their company
- Be under 150 words
- Have a conversational, non-salesy tone
- End with a soft CTA (e.g., "Would you be open to a quick call?")
- Not include a subject line (just the body)

Return ONLY the email body text, no subject line, no greeting header.`,
                        }],
                    });
                    body = emailResponse.content[0].text.trim();
                } catch (aiErr) {
                    console.error('Claude email generation error:', aiErr.message);
                    return res.status(500).json({ error: 'Could not generate email and no body provided' });
                }

                subject = subject || `Quick question for ${lead.company?.name || 'your team'}`;
            }
        }

        // Guard: no email credentials configured
        if (!emailTransporter) {
            return res.status(503).json({
                error: 'Email not configured. Add EMAIL_USER and EMAIL_PASSWORD to server/.env',
            });
        }

        // Send email via existing transporter
        const info = await emailTransporter.sendMail({
            from: `"Celeritech Orbit" <${EMAIL_USER}>`,
            to,
            subject: subject || `Introduction from Celeritech`,
            text: body,
            html: `<pre style="font-family:sans-serif;white-space:pre-wrap;">${body}</pre>`,
        });

        console.log(`📧 Lead email sent to ${to} (messageId: ${info.messageId})`);

        // Update lead outreach history
        if (!lead.outreach) lead.outreach = {};
        if (!lead.outreach.emailSequence) lead.outreach.emailSequence = [];
        lead.outreach.emailSequence.push({
            sentAt: new Date().toISOString(),
            to,
            subject,
            messageId: info.messageId,
            type: lead.outreach.emailSequence.length === 0 ? 'initial' : 'follow_up',
        });
        lead.outreach.lastEmailAt = new Date().toISOString();
        if (lead.status === 'new' || lead.status === 'qualified') {
            lead.status = 'emailed';
        }
        lead.updatedAt = new Date().toISOString();
        await saveLead(lead);

        res.json({ success: true, to, messageId: info.messageId });
    } catch (err) {
        console.error('❌ Lead email error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/call — AI call to lead ────────────────
app.post('/api/leads/:id/call', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const phoneNumber = lead.contact?.phone;
        const contactName = lead.contact?.name || '';

        if (!phoneNumber) {
            return res.status(400).json({ error: 'No phone number available for this lead' });
        }

        if (!process.env.VAPI_API_KEY) {
            return res.status(500).json({ error: 'Vapi API key not configured' });
        }

        // Normalize to E.164 format (same as existing /api/sales/call)
        let normalizedPhone = phoneNumber.replace(/[^\d+]/g, '');
        if (!normalizedPhone.startsWith('+')) {
            if (normalizedPhone.startsWith('1') && normalizedPhone.length === 11) {
                normalizedPhone = '+' + normalizedPhone;
            } else {
                normalizedPhone = '+1' + normalizedPhone;
            }
        }

        console.log(`\n📞 Lead call to ${normalizedPhone} (${contactName} at ${lead.company?.name || 'Unknown'})`);

        const response = await fetch(`${VAPI_BASE}/call`, {
            method: 'POST',
            headers: vapiHeaders(),
            body: JSON.stringify({
                phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
                customer: {
                    number: normalizedPhone,
                    name: contactName || undefined,
                },
                assistantId: 'ec94ead8-b047-4f64-989d-0c96731fbdc2',
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('Vapi call error:', errBody);
            let userMsg = `Vapi API error: ${response.status}`;
            try {
                const parsed = JSON.parse(errBody);
                if (parsed.message) {
                    userMsg = Array.isArray(parsed.message) ? parsed.message.join('. ') : parsed.message;
                }
            } catch { }
            throw new Error(userMsg);
        }

        const callData = await response.json();

        if (callData.endedReason) {
            const reason = callData.endedReason;
            console.error(`❌ Vapi call failed immediately: ${reason}`);
            return res.status(429).json({ error: `Call failed: ${reason}`, endedReason: reason });
        }

        console.log(`✅ Lead call initiated: ${callData.id}`);

        // Save to calls history (reuse existing pattern)
        const calls = await loadCalls();
        calls.unshift({
            id: callData.id,
            phoneNumber,
            contactName,
            company: lead.company?.name || '',
            status: 'in_progress',
            startedAt: new Date().toISOString(),
            duration: null,
            recordingUrl: null,
            transcript: null,
            analysis: null,
            leadId: lead.id,
        });
        await saveCalls(calls);

        // Update lead outreach history
        if (!lead.outreach) lead.outreach = {};
        if (!lead.outreach.calls) lead.outreach.calls = [];
        lead.outreach.calls.push({
            callId: callData.id,
            initiatedAt: new Date().toISOString(),
            status: 'in_progress',
        });
        lead.outreach.lastCallAt = new Date().toISOString();
        lead.updatedAt = new Date().toISOString();
        await saveLead(lead);

        res.json({ callId: callData.id, status: 'in_progress' });
    } catch (err) {
        console.error('❌ Lead call error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/push-ghl — Push to GoHighLevel CRM ───
app.post('/api/leads/:id/push-ghl', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const name = lead.contact?.name || '';
        const email = lead.contact?.email || '';
        const phone = lead.contact?.phone || '';

        if (!phone && !email) {
            return res.status(400).json({ error: 'Lead must have at least a phone number or email for GHL' });
        }

        // Get campaign name for tagging
        let campaignName = '';
        if (lead.campaignId) {
            const campaigns = await loadCampaigns();
            const camp = campaigns.find(c => c.id === lead.campaignId);
            campaignName = camp?.name || '';
        }

        console.log(`📇 Pushing lead to GHL: ${name} (${phone || email})`);

        const contactId = await ghlFindOrCreateContact(
            phone,
            name,
            email
        );

        if (!contactId) {
            throw new Error('Could not create or find contact in GoHighLevel');
        }

        // Save GHL contact ID back to lead
        if (!lead.integrations) lead.integrations = {};
        lead.integrations.ghlContactId = contactId;
        lead.integrations.ghlPushedAt = new Date().toISOString();
        lead.updatedAt = new Date().toISOString();
        await saveLead(lead);

        console.log(`✅ Lead pushed to GHL: ${contactId}`);
        res.json({ success: true, ghlContactId: contactId });
    } catch (err) {
        console.error('❌ Push to GHL error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/reply — Mark reply received ───────────
app.post('/api/leads/:id/reply', async (req, res) => {
    try {
        const lead = await loadLead(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        const { replySnippet } = req.body;

        lead.status = 'replied';
        if (!lead.outreach) lead.outreach = {};
        lead.outreach.repliedAt = new Date().toISOString();
        lead.outreach.replySnippet = replySnippet || '';

        // Cancel pending follow-up emails by marking them
        if (lead.outreach.pendingFollowUps) {
            lead.outreach.pendingFollowUps = lead.outreach.pendingFollowUps.map(f => ({
                ...f,
                cancelled: true,
                cancelledAt: new Date().toISOString(),
                cancelReason: 'lead_replied',
            }));
        }

        // Update email sequence with reply event
        if (!lead.outreach.emailSequence) lead.outreach.emailSequence = [];
        lead.outreach.emailSequence.push({
            type: 'reply_received',
            receivedAt: new Date().toISOString(),
            snippet: replySnippet || '',
        });

        lead.updatedAt = new Date().toISOString();
        await saveLead(lead);

        console.log(`💬 Reply received for lead: ${lead.id} (${lead.contact?.name || 'Unknown'})`);
        res.json({ success: true, lead });
    } catch (err) {
        console.error('❌ Mark reply error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Trend Engine routes (mounted under /api/trends) ────────────
import trendRoutes from './trends/routes.js';
app.use('/api/trends', trendRoutes);

// ─── Start Server ────────────────────────────────────────────────
if (!isVercel) {
    app.listen(PORT, () => {
        console.log(`\n✨ Celeritech Orbit Server running on http://localhost:${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/api/health\n`);
    });
}

export default app;

