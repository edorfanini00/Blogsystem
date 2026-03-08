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
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Multer for file uploads ────────────────────────────────────
const uploadsDir = join(__dirname, 'uploads');
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
const dataDir = join(__dirname, 'data');
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// Ensure users.json exists
const usersFile = join(dataDir, 'users.json');
if (!existsSync(usersFile)) {
    writeFileSync(usersFile, JSON.stringify([]));
    console.log('Created users.json file.');
}

// ─── Authentication Endpoints ────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        const usersBuf = readFileSync(usersFile, 'utf8');
        const users = JSON.parse(usersBuf || '[]');

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
        writeFileSync(usersFile, JSON.stringify(users, null, 2));

        // Delete password from response
        const { password: _, ...userWithoutPassword } = newUser;
        res.json({ success: true, user: userWithoutPassword });

    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const usersBuf = readFileSync(usersFile, 'utf8');
        const users = JSON.parse(usersBuf || '[]');

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
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ─── Clients ─────────────────────────────────────────────────────
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// OpenRouter client (for image generation)
const openrouter = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
});

// Perplexity client
const perplexity = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: 'https://api.perplexity.ai',
});

// ─── Perplexity Research ─────────────────────────────────────────
async function runPerplexityResearch(keywords, description) {
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

## 2. SEO KEYWORD RESEARCH
- Primary keyword (high volume, moderate competition)
- 5-10 secondary/long-tail keywords
- LSI (Latent Semantic Indexing) keywords — related terms search engines associate with this topic
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

Scan Reddit posts, X/Twitter discussions, Quora, industry forums, and top-ranking Google results.
Identify the exact search terms people use, the questions they ask, the pain points they express.
Analyze what the top 5 competing articles do well and what content gaps exist.
Provide specific LSI keywords, long-tail variations, and question-based keywords.
Include GEO optimization recommendations — what makes content get cited by AI engines.
Be extremely specific and actionable.`
                }
            ],
            max_tokens: 4000,
        });

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
function buildSystemPrompt(keywords, description, wordCount, researchInsights, imageUrls) {
    const researchBlock = researchInsights
        ? `\n\nAUDIENCE & SEO RESEARCH INSIGHTS (use these to shape EVERY aspect of the blog):\n${researchInsights}\n\nCRITICAL — USE THE RESEARCH ABOVE TO:\n- Use the EXACT primary keyword in H1, first paragraph, and throughout\n- Work ALL secondary/long-tail keywords naturally into H2s, H3s, and body text\n- Use LSI keywords throughout to build topical authority\n- Turn question-based keywords into H2/H3 headings\n- Mirror the exact language and phrases the target audience uses\n- Address their specific objections and pain points head-on\n- Fill the content gaps identified in competitor analysis\n- Include specific statistics, data points, and authoritative sources for GEO optimization\n- Make definitive, citation-worthy statements that AI engines can extract\n- Reference named entities, brands, and tools the audience already knows\n`
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

    return `You are a professional blog designer and world-class SEO copywriter. Your goal is to create a stunning, fully styled HTML blog post optimized for Elementor on WordPress.

TOPIC: ${keywords}
CONTEXT: ${description}
TARGET WORD COUNT: ${wordCount} words
${researchBlock}${imageBlock}
STRICT OUTPUT RULES — YOU MUST FOLLOW THESE EXACTLY:

1. Output ONLY valid, clean HTML — no markdown, no escape characters, no control characters, no code fences.
2. Wrap the entire blog in: <div style="max-width:780px;margin:0 auto;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#333;line-height:1.8;font-size:17px;">

3. HEADING STYLES:
   - H1 (title): <h1 style="color:#ea580c;font-size:2.4em;font-weight:800;line-height:1.2;margin-bottom:24px;">
   - H2 (sections): <h2 style="color:#ea580c;font-size:1.8em;font-weight:700;margin-top:56px;margin-bottom:20px;">
   - H3 (sub-sections): <h3 style="font-size:1.3em;font-weight:700;color:#1a1a1a;margin-top:40px;margin-bottom:16px;padding-left:16px;border-left:4px solid #ea580c;">

4. BODY TEXT: <p style="margin-bottom:20px;">

5. SPECIAL CALLOUT BADGES (use these throughout):
   - <span style="display:inline-block;background:#ea580c;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Result:</span>
   - <span style="display:inline-block;background:#ea580c;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Pro tip:</span>
   - <span style="display:inline-block;background:#ea580c;color:#fff;font-size:0.8em;font-weight:700;padding:2px 10px;border-radius:20px;margin-right:8px;vertical-align:middle;text-transform:uppercase;letter-spacing:0.03em;">Case in point:</span>

6. BENEFIT LABELS: <strong style="color:#ea580c;">Label text:</strong> followed by text

7. LISTS:
   - <ul style="margin-bottom:24px;padding-left:28px;"> with <li style="margin-bottom:8px;">
   - <ol> for numbered sequences

8. IMAGES: Insert the provided images using full <img> tags with the URLs provided above. Place one image after each major H2 heading.

9. BLOCKQUOTES: <blockquote style="border-left:4px solid #ea580c;background:#fff7ed;padding:16px 24px;margin:24px 0;font-style:italic;color:#92400e;">

10. CTA SECTION at the end: <div style="margin-top:56px;padding-top:32px;border-top:2px solid #ea580c;"> with an orange H2 heading inside.

11. HORIZONTAL RULES between major sections: <hr style="border:none;height:1px;background:#e5e5e5;margin:48px 0;">

CONTENT OBJECTIVES:
- Start with a strong, curiosity-driven H1 headline
- Write an introduction that hooks the reader by addressing their pain points
- Structure the post as a journey using storytelling patterns
- Include real examples, data, and demonstrations
- Write for the skeptical reader — justify every claim
- End with a clear CTA section that feels earned
- Make the tone conversational, confident, and human

SEO META — Include these as HTML comments at the very top BEFORE the blog div:
<!-- SEO_TITLE: Your 60-char title here -->
<!-- META_DESC: Your 155-char meta description here -->
<!-- SEO_KEYWORDS: keyword1, keyword2, keyword3 -->

Preserve all apostrophes, quotes, em dashes, and punctuation properly. No Unicode junk. Make it STUNNING.`;
}

// ─── OpenRouter Image Generation ─────────────────────────────────
async function generateImageWithOpenRouter(prompt) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your_openrouter_api_key') {
        console.warn('⚠ OpenRouter API key not set, skipping image generation');
        return null;
    }

    const models = [
        'google/gemini-2.5-flash-image',
        'google/gemini-3.1-flash-image-preview',
        'openai/gpt-5-image-mini',
    ];

    for (const model of models) {
        try {
            console.log(`   Trying model: ${model}`);
            const response = await openrouter.chat.completions.create({
                model,
                messages: [
                    {
                        role: 'user',
                        content: `Generate a professional, photorealistic blog image: ${prompt}. High quality, cinematic lighting, editorial style. No text, no watermarks, no logos. Premium stock photo quality for a business blog.`,
                    },
                ],
            });

            const choice = response.choices?.[0]?.message;
            if (!choice) continue;

            // PRIMARY FORMAT: OpenRouter returns images in choice.images[] array
            if (Array.isArray(choice.images) && choice.images.length > 0) {
                for (const img of choice.images) {
                    const url = img.image_url?.url || img.url;
                    if (url && url.startsWith('data:image/')) {
                        const match = url.match(/^data:image\/(\w+);base64,(.+)$/s);
                        if (match) {
                            console.log(`   ✅ Got image from ${model} (${match[1]}, ${match[2].length} chars base64)`);
                            return {
                                buffer: Buffer.from(match[2], 'base64'),
                                mimeType: `image/${match[1]}`,
                                alt: prompt,
                            };
                        }
                    }
                    if (url && url.startsWith('http')) {
                        console.log(`   ✅ Got image URL from ${model}`);
                        return { url, alt: prompt };
                    }
                }
            }

            // FALLBACK: Check content if it's an array of parts
            const parts = choice.content;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.type === 'image_url' && part.image_url?.url) {
                        const url = part.image_url.url;
                        if (url.startsWith('data:image/')) {
                            const match = url.match(/^data:image\/(\w+);base64,(.+)$/s);
                            if (match) {
                                console.log(`   ✅ Got image from content array (${match[1]})`);
                                return {
                                    buffer: Buffer.from(match[2], 'base64'),
                                    mimeType: `image/${match[1]}`,
                                    alt: prompt,
                                };
                            }
                        }
                        return { url, alt: prompt };
                    }
                }
            }

            console.log(`   Model ${model} returned no usable image data`);
        } catch (err) {
            console.error(`   Model ${model} error: ${err.message}`);
        }
    }

    return null;
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

// ─── Parse SEO meta from HTML content ────────────────────────────
function parseSeoMeta(content) {
    const seoTitle = content.match(/<!--\s*SEO_TITLE:\s*(.+?)\s*-->/)?.[1] || '';
    const metaDesc = content.match(/<!--\s*META_DESC:\s*(.+?)\s*-->/)?.[1] || '';
    const seoKeywords = content.match(/<!--\s*SEO_KEYWORDS:\s*(.+?)\s*-->/)?.[1]?.split(',').map(k => k.trim()) || [];
    return { seoTitle, metaDesc, seoKeywords };
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
        res.write(`data: ${JSON.stringify({ type: 'result', ...data })}\n\n`);
        res.end();
    }

    function sendError(error) {
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.end();
    }

    const TOTAL_STEPS = 8;

    try {
        const { keywords, description, wordCount } = req.body;

        if (!keywords || !description || !wordCount) {
            return sendError('Missing required fields: keywords, description, wordCount');
        }

        console.log(`\n🚀 Generating blog: "${keywords}" (~${wordCount} words)`);

        // Step 1: Perplexity research
        sendProgress(1, TOTAL_STEPS, 'Researching target audience & SEO keywords…');
        const researchInsights = await runPerplexityResearch(keywords, description);
        if (researchInsights) {
            console.log(`📊 Research insights received (${researchInsights.length} chars)`);
        }

        // Step 2-4: Generate images
        sendProgress(2, TOTAL_STEPS, 'Generating blog image 1 of 3…');
        const imagePrompts = [
            `${keywords} - hero banner: professional setting related to the topic, wide angle, premium quality`,
            `${keywords} - detail shot: close-up showing the solution or technology in action`,
            `${keywords} - team or person: professional working on or benefiting from the solution`,
        ];

        const uploadedImages = [];
        const hasWpCredentials = process.env.WORDPRESS_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD;

        for (let i = 0; i < imagePrompts.length; i++) {
            sendProgress(2 + i, TOTAL_STEPS, `Generating blog image ${i + 1} of ${imagePrompts.length}…`);
            console.log(`🎨 Generating image ${i + 1}/${imagePrompts.length}…`);
            const img = await generateImageWithOpenRouter(imagePrompts[i]);
            if (img) {
                if (hasWpCredentials) {
                    console.log(`📤 Uploading image ${i + 1} to WordPress…`);
                    const wpImage = await uploadImageToWordPress(img, imagePrompts[i], `blog-${Date.now()}-${i}`);
                    if (wpImage) {
                        uploadedImages.push(wpImage);
                        continue;
                    }
                }
                uploadedImages.push({ url: img.url || '', alt: img.alt });
            }
        }

        console.log(`✅ ${uploadedImages.length} images ready`);

        // Step 5: Writing blog
        sendProgress(5, TOTAL_STEPS, 'Writing SEO-optimized blog with Claude…');
        const systemPrompt = buildSystemPrompt(keywords, description, wordCount, researchInsights, uploadedImages);

        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8192,
            messages: [
                {
                    role: 'user',
                    content: `Write the blog post now as valid, styled HTML. Make it approximately ${wordCount} words. Topic: ${keywords}. Context: ${description}. Remember: output ONLY the HTML, no markdown, no code fences.`,
                },
            ],
            system: systemPrompt,
        });

        let htmlContent = message.content[0].text;

        // Step 6: Cleaning up
        sendProgress(6, TOTAL_STEPS, 'Formatting and cleaning HTML…');
        htmlContent = htmlContent.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();

        // Step 7: Parse SEO
        sendProgress(7, TOTAL_STEPS, 'Extracting SEO metadata…');
        const seo = parseSeoMeta(htmlContent);
        console.log(`📝 SEO Title: ${seo.seoTitle}`);

        const titleMatch = htmlContent.match(/<h1[^>]*>(.+?)<\/h1>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : seo.seoTitle || keywords;

        // Step 8: Done
        sendProgress(8, TOTAL_STEPS, 'Blog ready!');
        console.log(`✅ Blog generated: "${title}"`);

        sendResult({
            title,
            content: htmlContent,
            htmlContent,
            metaTitle: seo.seoTitle,
            metaDescription: seo.metaDesc,
            seoKeywords: seo.seoKeywords,
            images: uploadedImages,
            featuredMediaId: uploadedImages[0]?.id || null,
        });
    } catch (err) {
        console.error('❌ Generation error:', err);
        sendError(err.message || 'Blog generation failed');
    }
});

// ─── POST /api/publish ───────────────────────────────────────────
app.post('/api/publish', async (req, res) => {
    try {
        const { title, htmlContent, featuredMediaId } = req.body;

        const wpUrl = process.env.WORDPRESS_URL;
        const wpUser = process.env.WORDPRESS_USERNAME;
        const wpPass = process.env.WORDPRESS_APP_PASSWORD;

        if (!wpUrl || !wpUser || !wpPass) {
            return res.status(400).json({ error: 'WordPress credentials not configured in .env' });
        }

        const credentials = Buffer.from(`${wpUser}:${wpPass}`).toString('base64');

        const postData = {
            title,
            content: htmlContent,
            status: 'draft',
        };

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

        console.log(`📤 Draft published to WordPress: ${post.link}`);

        res.json({
            postId: post.id,
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

const BLOGS_FILE = join(__dirname, 'blogs.json');

function loadBlogs() {
    if (!existsSync(BLOGS_FILE)) return [];
    try { return JSON.parse(readFileSync(BLOGS_FILE, 'utf-8')); } catch { return []; }
}

function saveBlogs(blogs) {
    writeFileSync(BLOGS_FILE, JSON.stringify(blogs, null, 2), 'utf-8');
}

// ─── POST /api/blogs — Save a generated blog ───────────────────
app.post('/api/blogs', (req, res) => {
    const { title, html, markdown, seoTitle, seoDescription, seoKeywords, keywords, description, wordCount, userName } = req.body;
    const blogs = loadBlogs();
    const blog = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        userName: userName || 'Unknown',
        title: title || seoTitle || 'Untitled Blog',
        html: html || '',
        markdown: markdown || '',
        seoTitle: seoTitle || '',
        seoDescription: seoDescription || '',
        seoKeywords: seoKeywords || [],
        keywords: keywords || '',
        description: description || '',
        wordCount: wordCount || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        published: false,
    };
    blogs.unshift(blog);
    saveBlogs(blogs);
    console.log(`📝 Blog saved: "${blog.title}" (${blog.id})`);
    res.json(blog);
});

// ─── GET /api/blogs — List all blogs ────────────────────────────
app.get('/api/blogs', (req, res) => {
    res.json(loadBlogs());
});

// ─── GET /api/blogs/:id — Get a single blog ────────────────────
app.get('/api/blogs/:id', (req, res) => {
    const blogs = loadBlogs();
    const blog = blogs.find(b => b.id === req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    res.json(blog);
});

// ─── PUT /api/blogs/:id — Update a blog ────────────────────────
app.put('/api/blogs/:id', (req, res) => {
    const blogs = loadBlogs();
    const idx = blogs.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Blog not found' });
    const { html, markdown, title, seoTitle, seoDescription, published } = req.body;
    if (html !== undefined) blogs[idx].html = html;
    if (markdown !== undefined) blogs[idx].markdown = markdown;
    if (title !== undefined) blogs[idx].title = title;
    if (seoTitle !== undefined) blogs[idx].seoTitle = seoTitle;
    if (seoDescription !== undefined) blogs[idx].seoDescription = seoDescription;
    if (published !== undefined) blogs[idx].published = published;
    blogs[idx].updatedAt = new Date().toISOString();
    saveBlogs(blogs);
    res.json(blogs[idx]);
});

// ─── DELETE /api/blogs/:id — Delete a blog ─────────────────────
app.delete('/api/blogs/:id', (req, res) => {
    const blogs = loadBlogs();
    const filtered = blogs.filter(b => b.id !== req.params.id);
    saveBlogs(filtered);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// ─── POSTS GENERATOR — Ad Research & Generation ─────────────────
// ═══════════════════════════════════════════════════════════════════

const ADS_FILE = join(__dirname, 'ads.json');

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
                model: 'claude-sonnet-4-20250514',
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

const CALLS_FILE = join(__dirname, 'calls.json');
const VAPI_BASE = 'https://api.vapi.ai';

function loadCalls() {
    if (!existsSync(CALLS_FILE)) return [];
    try { return JSON.parse(readFileSync(CALLS_FILE, 'utf-8')); } catch { return []; }
}

function saveCalls(calls) {
    writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2), 'utf-8');
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
                assistant: {
                    model: {
                        provider: 'openai',
                        model: 'gpt-4o',
                        messages: [{ role: 'system', content: prompt }],
                    },
                    voice: {
                        provider: 'vapi',
                        voiceId: 'Cole',
                    },
                    firstMessage: `Hi${contactName ? `, is this ${contactName}` : ''}? This is Alex from Celeritech. Do you have a quick moment to chat?`,
                    transcriber: {
                        provider: 'deepgram',
                        model: 'nova-3',
                        language: 'en',
                    },
                    endCallMessage: 'Thanks for your time today! Have a great day.',
                    maxDurationSeconds: 300,
                },
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
        const calls = loadCalls();
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
        saveCalls(calls);

        res.json({ callId: callData.id, status: 'in_progress' });
    } catch (err) {
        console.error('❌ Call initiation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/sales/calls — List all calls ──────────────────────
app.get('/api/sales/calls', (req, res) => {
    res.json(loadCalls());
});

// ─── DELETE /api/sales/call/:id — Delete a call ─────────────────
app.delete('/api/sales/call/:id', (req, res) => {
    const calls = loadCalls();
    const filtered = calls.filter(c => c.id !== req.params.id);
    saveCalls(filtered);
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

        // Update local storage
        const calls = loadCalls();
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
                    localCall.status = localCall.analysis ? localCall.status : 'completed';
                    localCall.duration = vapiCall.costBreakdown?.duration || vapiCall.duration || null;
                    localCall.recordingUrl = vapiCall.recordingUrl || vapiCall.artifact?.recordingUrl || null;
                    localCall.transcript = vapiCall.transcript || vapiCall.artifact?.transcript || null;
                    localCall.endedAt = vapiCall.endedAt || new Date().toISOString();

                    // Auto-analyze if we have a transcript and haven't yet analyzed
                    if (localCall.transcript && !localCall.analysis) {
                        console.log(`🧠 Auto-analyzing call ${id}…`);
                        localCall.analysis = await analyzeTranscript(localCall.transcript, localCall.contactName, localCall.company);
                        localCall.status = localCall.analysis.status || 'completed';
                    }
                }
            } else if (vapiStatus === 'ringing' || vapiStatus === 'queued') {
                localCall.status = 'ringing';
            } else if (vapiStatus === 'in-progress') {
                localCall.status = 'in_progress';
            }
            saveCalls(calls);
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
        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
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

// ─── GET /api/health ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            anthropic: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key',
            openrouter: !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key',
            perplexity: !!process.env.PERPLEXITY_API_KEY && process.env.PERPLEXITY_API_KEY !== 'your_perplexity_api_key',
            vapi: !!process.env.VAPI_API_KEY,
            wordpress: !!process.env.WORDPRESS_URL && process.env.WORDPRESS_URL !== 'https://yoursite.com',
        },
    });
});

// ─── Start Server ────────────────────────────────────────────────
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`\n✨ Celeritech Orbit Server running on http://localhost:${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/api/health\n`);
    });
}

export default app;
