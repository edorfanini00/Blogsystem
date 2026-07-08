import { marked } from 'marked';
import { put } from '@vercel/blob/client';
import { concatVideos } from './videoConcat.js';

// Flag that main.js started loading (if this line runs, imports succeeded)
window._mainJsLoaded = 'imports-ok';
console.log('✅ main.js: imports loaded successfully');

// ─── DOM Elements ────────────────────────────────────────────────
const blogForm = document.getElementById('blogForm');
const keywordsInput = document.getElementById('keywords');
const descriptionInput = document.getElementById('description');
const wordCountInput = document.getElementById('wordCount');
const wordCountValue = document.getElementById('wordCountValue');
const imageCountInput = document.getElementById('imageCount');
const imageCountValue = document.getElementById('imageCountValue');
const keywordTags = document.getElementById('keywordTags');
const generateBtn = document.getElementById('generateBtn');
const previewEmpty = document.getElementById('previewEmpty');
const previewLoading = document.getElementById('previewLoading');
const previewContent = document.getElementById('previewContent');
const previewActions = document.getElementById('previewActions');
const seoBar = document.getElementById('seoBar');
const seoTitle = document.getElementById('seoTitle');
const seoMetaDesc = document.getElementById('seoMetaDesc');
const seoKeywords = document.getElementById('seoKeywords');
const blogBody = document.getElementById('blogBody');
const publishPanel = document.getElementById('publishPanel');
const publishBtn = document.getElementById('publishBtn');
const publishResult = document.getElementById('publishResult');
const copyBtn = document.getElementById('copyBtn');
const loadingText = document.getElementById('loadingText');
const connectionStatus = document.getElementById('connectionStatus');
const toastContainer = document.getElementById('toastContainer');

// ─── State ───────────────────────────────────────────────────────
let generatedBlog = null;
let currentBlogId = null;
let spanishBlogHtml = null;
let englishBlogHtml = null;
let currentPreviewLang = 'en';
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

// Escape a string for safe interpolation into innerHTML. Use for any value
// that originates from an API/user before placing it in a template literal.
function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escHtml = escHtml;

// ─── Configure marked ────────────────────────────────────────────
marked.setOptions({
    breaks: true,
    gfm: true,
});

// ─── Theme Toggle ────────────────────────────────────────────────
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIconSun = document.getElementById('themeIconSun');
const themeIconMoon = document.getElementById('themeIconMoon');

function applyTheme(isLight) {
    if (isLight) {
        document.body.classList.add('light-theme');
        if (themeIconSun) themeIconSun.style.display = 'block';
        if (themeIconMoon) themeIconMoon.style.display = 'none';
        localStorage.setItem('theme', 'light');
    } else {
        document.body.classList.remove('light-theme');
        if (themeIconSun) themeIconSun.style.display = 'none';
        if (themeIconMoon) themeIconMoon.style.display = 'block';
        localStorage.setItem('theme', 'dark');
    }
}

// Check saved theme on load (default to dark if not set)
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light') {
    applyTheme(true);
} else {
    applyTheme(false);
}

if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const isCurrentlyLight = document.body.classList.contains('light-theme');
        applyTheme(!isCurrentlyLight);
    });
}

// ─── Health Check ────────────────────────────────────────────────
async function checkHealth() {
    const dot = connectionStatus.querySelector('.status-dot');
    const text = connectionStatus.querySelector('.status-text');
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        const data = await res.json();
        dot.className = 'status-dot online';
        const services = [];
        if (data.services?.anthropic) services.push('AI');
        if (data.services?.openrouter) services.push('Images');
        if (data.services?.perplexity) services.push('Research');
        if (data.services?.wordpress) services.push('WordPress');
        text.textContent = services.length ? `Connected — ${services.join(', ')}` : 'Server online';
    } catch {
        dot.className = 'status-dot error';
        text.textContent = 'Server offline';
    }
}

checkHealth();
setInterval(checkHealth, 30000);

// ─── Word Count Slider ──────────────────────────────────────────
wordCountInput.addEventListener('input', () => {
    wordCountValue.textContent = parseInt(wordCountInput.value).toLocaleString();
});

// ─── Image Count Slider ─────────────────────────────────────────
if (imageCountInput) {
    imageCountInput.addEventListener('input', () => {
        imageCountValue.textContent = imageCountInput.value;
    });
}

// ─── Keyword Tags ────────────────────────────────────────────
let keywordsList = [];

function renderKeywordTags() {
    keywordTags.innerHTML = keywordsList
        .map((k, i) => `<span class="keyword-tag">${k}<span class="keyword-tag-remove" data-index="${i}">×</span></span>`)
        .join('');
    keywordTags.querySelectorAll('.keyword-tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            keywordsList.splice(parseInt(btn.dataset.index), 1);
            renderKeywordTags();
        });
    });
}

keywordsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const val = keywordsInput.value.trim();
        if (val && !keywordsList.includes(val)) {
            keywordsList.push(val);
            renderKeywordTags();
        }
        keywordsInput.value = '';
    }
});

// ─── Loading Messages ────────────────────────────────────────────
const loadingMessages = [
    'Scanning Reddit & X for audience insights…',
    'Analyzing target segment pain points…',
    'Running Perplexity deep research…',
    'Building audience language profile…',
    'Crafting a compelling headline…',
    'Writing with SEO best practices…',
    'Adding depth and real examples…',
    'Generating AI images with DALL-E…',
    'Uploading images to WordPress…',
    'Polishing the final draft…',
    'Almost there — final touches…',
];

function cycleLoadingMessages() {
    let i = 0;
    return setInterval(() => {
        i = (i + 1) % loadingMessages.length;
        loadingText.textContent = loadingMessages[i];
    }, 4000);
}

// ─── Toast Notifications ─────────────────────────────────────────
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✓' : '✕';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = String(message == null ? '' : message);
    toast.append(iconSpan, msgSpan);
    if (toastContainer) toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ─── Show/Hide States ────────────────────────────────────────────
function showState(state) {
    previewEmpty.style.display = state === 'empty' ? 'flex' : 'none';
    previewLoading.style.display = state === 'loading' ? 'flex' : 'none';
    previewContent.style.display = state === 'content' ? 'block' : 'none';
    previewActions.style.display = state === 'content' ? 'flex' : 'none';
}

// ─── Form Submit → Generate Blog (SSE streaming) ────────────────
blogForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const keywords = keywordsList.join(', ');
    const description = descriptionInput.value.trim();
    const wordCount = parseInt(wordCountInput.value);
    const imageCount = parseInt(imageCountInput?.value || '3');
    const target = document.getElementById('blogTarget').value.trim();
    const product = document.getElementById('blogProduct').value.trim();
    const trends = document.getElementById('blogTrends').value.trim();
    const tone = document.getElementById('blogToneValue').value;
    const language = document.getElementById('blogLangValue').value;

    if (!keywordsList.length || !description) {
        showToast('Please add at least one keyword and fill in the topic', 'error');
        return;
    }

    // Show loading state
    showState('loading');
    generateBtn.disabled = true;
    generateBtn.querySelector('.btn-text').style.display = 'none';
    generateBtn.querySelector('.btn-loader').style.display = 'inline-flex';
    publishPanel.style.display = 'none';

    // Reset progress bar
    const progressFill = document.getElementById('progressBarFill');
    const progressPercent = document.getElementById('progressPercent');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    loadingText.textContent = 'Starting generation…';

    // Progress animation that actually tracks the server's steps.
    // - `targetPct` = the % of the last confirmed step (bar jumps up to here).
    // - `ceilingPct` = just below the NEXT step's mark; between SSE events the bar
    //   inches toward this ceiling so it feels alive, but never races ahead to the
    //   next milestone until the server confirms it (no more "stuck at 95%").
    let currentPct = 0;
    let targetPct = 0;
    let ceilingPct = 0;
    const smoothInterval = setInterval(() => {
        if (currentPct < targetPct) {
            // Catch up to the confirmed step reasonably quickly.
            const diff = targetPct - currentPct;
            currentPct = Math.min(currentPct + Math.max(0.5, diff * 0.15), targetPct);
        } else if (currentPct < ceilingPct) {
            // Inch forward within the current step toward (but not reaching) the
            // next milestone — slow enough that long steps keep visibly moving.
            const diff = ceilingPct - currentPct;
            currentPct = Math.min(currentPct + Math.max(0.04, diff * 0.02), ceilingPct);
        }
        const rounded = Math.min(Math.round(currentPct), 99);
        progressFill.style.width = `${rounded}%`;
        progressPercent.textContent = `${rounded}%`;
    }, 200);

    try {
        const res = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keywords, description, wordCount, imageCount, target, product, trends, tone, language }),
        });

        if (!res.ok || !res.body) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Generation failed (HTTP ${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // Track whether we received a terminal event. If the connection drops
        // mid-stream (e.g. the serverless function hit its time limit) we must NOT
        // sit on the loading spinner forever — surface an error so the user can retry.
        let gotTerminal = false;

        while (true) {
            const { done, value } = await reader.read();

            if (!done) {
                buffer += decoder.decode(value, { stream: true });
            } else {
                // Flush decoder and add any remaining buffer data
                buffer += decoder.decode();
            }

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            // When stream is done, any remaining buffer content is the last line
            // (it won't have a trailing \n so pop() pulled it out of lines)
            if (done && buffer.trim()) {
                lines.push(buffer);
                buffer = '';
            }

            // Process all complete lines (the for loop below handles them)
            // After processing, break if the stream is done

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));

                    if (data.type === 'progress') {
                        // Jump the bar to this step's mark, then let it creep toward
                        // (but not into) the next step so it follows the real process.
                        targetPct = (data.step / data.total) * 100;
                        ceilingPct = Math.min(((data.step + 0.9) / data.total) * 100, 99);
                        loadingText.textContent = data.message;
                    }

                    if (data.type === 'result') {
                        gotTerminal = true;
                        // Snap to 100%
                        targetPct = 100;
                        currentPct = 100;
                        progressFill.style.width = '100%';
                        progressPercent.textContent = '100%';
                        loadingText.textContent = 'Complete!';

                        generatedBlog = data;

                        // Short delay so user sees 100%
                        await new Promise(r => setTimeout(r, 400));

                        // Render SEO bar
                        if (data.metaTitle || data.metaDescription) {
                            seoTitle.textContent = data.metaTitle || '';
                            seoMetaDesc.textContent = data.metaDescription || '';
                            seoKeywords.innerHTML = (data.seoKeywords || [])
                                .map(k => `<span class="seo-keyword">${k}</span>`)
                                .join('');
                            seoBar.style.display = 'flex';
                        } else {
                            seoBar.style.display = 'none';
                        }

                        // Render blog body — HTML from Claude
                        let cleanContent = data.content
                            .replace(/<!--\s*FOCUS_KEYPHRASE:.*?-->\n?/g, '')
                            .replace(/<!--\s*SEO_TITLE:.*?-->\n?/g, '')
                            .replace(/<!--\s*META_DESC:.*?-->\n?/g, '')
                            .replace(/<!--\s*SLUG:.*?-->\n?/g, '')
                            .replace(/<!--\s*SEO_KEYWORDS:.*?-->\n?/g, '');
                        blogBody.innerHTML = cleanContent;
                        englishBlogHtml = cleanContent;
                        blogBody.contentEditable = 'true';

                        showState('content');
                        publishPanel.style.display = 'block';
                        showToast(`Blog generated: "${data.title}"`);
                        if (data.imageNotice) {
                            setTimeout(() => showToast(data.imageNotice, 'error'), 1200);
                        }
                        if (data.spanishNotice) {
                            setTimeout(() => showToast(data.spanishNotice, 'error'), 1800);
                        }

                        // Handle language tabs
                        const langTabs = document.getElementById('langTabs');
                        if (data.spanishHtmlContent) {
                            spanishBlogHtml = data.spanishHtmlContent;
                            langTabs.style.display = 'flex';
                            // Reset to English tab
                            currentPreviewLang = 'en';
                            langTabs.querySelectorAll('.lang-tab').forEach(t => {
                                t.classList.toggle('active', t.dataset.lang === 'en');
                            });
                        } else {
                            spanishBlogHtml = null;
                            langTabs.style.display = 'none';
                        }

                        // Auto-save to blog history
                        try {
                            const blogData = {
                                title: data.title,
                                html: data.htmlContent || cleanContent,
                                markdown: data.content,
                                seoTitle: data.metaTitle,
                                seoDescription: data.metaDescription,
                                seoKeywords: data.seoKeywords,
                                focusKeyphrase: data.focusKeyphrase || '',
                                slug: data.slug || '',
                                keywords, description, wordCount,
                                userName: window.currentUser?.name || 'Unknown',
                                spanishHtml: data.spanishHtmlContent || null,
                                spanishTitle: data.spanishTitle || null,
                            };
                            const saveRes = await fetch(`${API_BASE}/api/blogs`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(blogData),
                            });
                            const saved = await saveRes.json();
                            currentBlogId = saved.id;
                            saveBlogToLocal(saved);
                            loadBlogHistory();
                        } catch (saveErr) {
                            console.error('Blog save error:', saveErr);
                        }
                    }

                    if (data.type === 'error') {
                        gotTerminal = true;
                        throw new Error(data.error);
                    }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) {
                        throw parseErr;
                    }
                }
            }

            if (done) break;
        }

        // Stream ended without ever delivering a result or error. This happens when
        // the serverless function is killed mid-generation (Vercel time limit) and
        // the socket just closes. Don't leave the UI stuck on the loading spinner.
        if (!gotTerminal) {
            throw new Error('The generation timed out before it finished. Please try again — reducing the word count or number of images helps it complete faster.');
        }
    } catch (err) {
        console.error('Generation error:', err);
        showToast(err.message || 'Blog generation failed', 'error');
        showState('empty');
    } finally {
        clearInterval(smoothInterval);
        generateBtn.disabled = false;
        generateBtn.querySelector('.btn-text').style.display = 'inline';
        generateBtn.querySelector('.btn-loader').style.display = 'none';
    }
});

// ─── Copy Markdown ───────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
    if (!generatedBlog?.content) return;
    try {
        await navigator.clipboard.writeText(generatedBlog.content);
        showToast('Markdown copied to clipboard');
    } catch {
        showToast('Failed to copy', 'error');
    }
});

// ─── Publish to WordPress ────────────────────────────────────────
publishBtn.addEventListener('click', async () => {
    if (!generatedBlog) return;

    // Save any current edits to the correct language variable before publishing
    if (currentPreviewLang === 'es') {
        spanishBlogHtml = blogBody.innerHTML;
    } else {
        englishBlogHtml = blogBody.innerHTML;
    }

    publishBtn.disabled = true;
    publishBtn.querySelector('.btn-text').style.display = 'none';
    publishBtn.querySelector('.btn-loader').style.display = 'inline-flex';
    publishResult.style.display = 'none';

    try {
        // Publish English version (always use stored English content)
        const res = await fetch(`${API_BASE}/api/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: generatedBlog.title,
                htmlContent: englishBlogHtml || blogBody.innerHTML,
                featuredMediaId: generatedBlog.featuredMediaId || null,
                focusKeyphrase: generatedBlog.focusKeyphrase || '',
                metaTitle: generatedBlog.metaTitle || '',
                metaDescription: generatedBlog.metaDescription || '',
                seoKeywords: generatedBlog.seoKeywords || [],
                slug: generatedBlog.slug || '',
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Publishing failed');
        }

        const result = await res.json();
        let successMsg = '✓ English draft created successfully!';

        // If we have Spanish content, publish it too
        if (spanishBlogHtml) {
            try {
                const spanishTitle = generatedBlog.spanishTitle || `[ES] ${generatedBlog.title}`;
                const spanishRes = await fetch(`${API_BASE}/api/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: spanishTitle,
                        htmlContent: spanishBlogHtml,
                        featuredMediaId: generatedBlog.featuredMediaId || null,
                        focusKeyphrase: generatedBlog.focusKeyphrase || '',
                        slug: generatedBlog.slug ? `${generatedBlog.slug}-es` : '',
                    }),
                });
                if (spanishRes.ok) {
                    successMsg = '✓ Both English and Spanish drafts created!';
                } else {
                    successMsg += '<br/>⚠ Spanish draft failed to publish.';
                }
            } catch (esErr) {
                console.error('Spanish publish error:', esErr);
                successMsg += '<br/>⚠ Spanish draft failed to publish.';
            }
        }

        publishResult.className = 'publish-result success';
        publishResult.innerHTML = `
      ${successMsg}<br/>
      <a href="https://celeritech.biz/wp-admin/" target="_blank">Edit in WordPress →</a>
    `;
        publishResult.style.display = 'block';

        // Mark blog as published in history (store the live URL/slug so future posts can link to it)
        if (currentBlogId) {
            await fetch(`${API_BASE}/api/blogs/${currentBlogId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    published: true,
                    html: englishBlogHtml,
                    url: result.viewUrl || '',
                    slug: result.slug || generatedBlog.slug || '',
                }),
            });
            loadBlogHistory();
        }

        showToast('Draft sent to WordPress!');
    } catch (err) {
        console.error('Publish error:', err);
        publishResult.className = 'publish-result error';
        publishResult.innerHTML = `✕ ${err.message}`;
        publishResult.style.display = 'block';
        showToast(err.message || 'Publishing failed', 'error');
    } finally {
        publishBtn.disabled = false;
        publishBtn.querySelector('.btn-text').style.display = 'inline-flex';
        publishBtn.querySelector('.btn-loader').style.display = 'none';
    }
});

// ═══════════════════════════════════════════════════════════════════
// ─── SIDEBAR NAVIGATION ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const navItems = document.querySelectorAll('.nav-item');
const pageBlog = document.getElementById('pageBlog');
const pageSales = document.getElementById('pageSales');
const pagePosts = document.getElementById('pagePosts');
const pageMedia = document.getElementById('pageMedia');
const pageReddit = document.getElementById('pageReddit');
const pageCampaign = document.getElementById('pageCampaign');
const pageScheduler = document.getElementById('pageScheduler');
const pageOnePager = document.getElementById('pageOnePager');
const pageLeadgen = document.getElementById('pageLeadgen');
const pageTrends = document.getElementById('pageTrends');

navItems.forEach(item => {
    item.addEventListener('click', e => {
        if (item.id === 'logoutBtn') return; // let logout happen normally

        e.preventDefault();
        const page = item.dataset.page;

        // Save active page
        localStorage.setItem('orbit_active_page', page);

        // Update active nav
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Hide all pages
        pageBlog.style.display = 'none';
        pageSales.style.display = 'none';
        pagePosts.style.display = 'none';
        pageMedia.style.display = 'none';
        if (pageReddit) pageReddit.style.display = 'none';
        if (pageCampaign) pageCampaign.style.display = 'none';
        if (pageScheduler) pageScheduler.style.display = 'none';
        if (pageOnePager) pageOnePager.style.display = 'none';
        if (pageLeadgen) pageLeadgen.style.display = 'none';
        if (pageTrends) pageTrends.style.display = 'none';

        // Show selected page
        if (page === 'blogs') {
            pageBlog.style.display = '';
            loadBlogHistory();
        } else if (page === 'ai-sales') {
            pageSales.style.display = '';
            loadCallLog();
        } else if (page === 'posts') {
            pagePosts.style.display = '';
            loadAdHistory();
        } else if (page === 'media') {
            pageMedia.style.display = '';
            renderMediaHistory();
        } else if (page === 'reddit') {
            if (pageReddit) pageReddit.style.display = '';
            if (typeof renderRedditAgents === 'function') renderRedditAgents();
            if (typeof renderRedditActivity === 'function') renderRedditActivity();
        } else if (page === 'campaign') {
            if (pageCampaign) pageCampaign.style.display = '';
        } else if (page === 'scheduler') {
            if (pageScheduler) pageScheduler.style.display = '';
            if (typeof initScheduler === 'function') initScheduler();
        } else if (page === 'onepager') {
            if (pageOnePager) pageOnePager.style.display = '';
        } else if (page === 'leadgen') {
            if (pageLeadgen) pageLeadgen.style.display = '';
            if (typeof initLeadgenPage === 'function') initLeadgenPage();
        } else if (page === 'trends') {
            if (pageTrends) pageTrends.style.display = '';
            if (typeof initTrendsPage === 'function') initTrendsPage();
        }
    });
});

// Restore last active page on load. Deferred to a macrotask so it runs AFTER
// the whole module finishes evaluating — otherwise pages whose initializer is
// defined in a later IIFE (trends, leadgen, scheduler) would be shown before
// their init function exists, leaving the page rendered but unwired.
const savedPage = localStorage.getItem('orbit_active_page');
if (savedPage) {
    setTimeout(() => {
        const savedNavItem = document.querySelector(`.nav-item[data-page="${savedPage}"]`);
        if (savedNavItem) savedNavItem.click();
    }, 0);
}

// ═══════════════════════════════════════════════════════════════════
// ─── GLOBAL OAUTH CONNECT HANDLER (event delegation) ────────────
// ═══════════════════════════════════════════════════════════════════
// Self-contained — no dependency on PLATFORM_META or initScheduler.

const _PLAT_NAMES = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn' };
// Early declaration to avoid TDZ when the delegated handler fires
var _oauthConnectedStatus = {};

window.addEventListener('message', (event) => {
    try {
        if (event.data?.type === 'oauth_result') {
            const { status, platform, detail } = event.data;
            if (status === 'success') {
                showToast(`${_PLAT_NAMES[platform] || platform} connected as ${detail}!`);
            } else {
                showToast(`${_PLAT_NAMES[platform] || platform} connection failed: ${detail}`, 'error');
            }
            if (typeof renderAccountsStatus === 'function') renderAccountsStatus();
        }
    } catch (err) { console.error('OAuth message handler error:', err); }
});

document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.sched-connect-btn');
    if (!btn) return;

    const platform = btn.dataset.platform;
    if (!platform) return;

    try {
        const isConnected = _oauthConnectedStatus[platform]?.connected === true;

        if (isConnected) {
            const res = await fetch(`${API_BASE}/api/oauth/${platform}/disconnect`, { method: 'POST' });
            if (res.ok) {
                showToast(`${_PLAT_NAMES[platform] || platform} disconnected`);
                if (typeof renderAccountsStatus === 'function') renderAccountsStatus();
            }
        } else {
            // Open popup FIRST — before anything that could fail
            const oauthUrl = `${API_BASE}/api/oauth/${platform}/connect`;
            console.log(`🔌 Opening OAuth popup: ${oauthUrl}`);
            window.open(oauthUrl, `oauth_${platform}`, 'width=600,height=700,left=300,top=100');
            showToast(`Opening ${_PLAT_NAMES[platform] || platform} authorization…`);
        }
    } catch (err) {
        console.error(`🔌 Connect error for ${platform}:`, err);
        showToast(`Connection error: ${err.message}`, 'error');
    }
});

// ═══════════════════════════════════════════════════════════════════
// ─── BLOG HISTORY ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const blogHistoryEmpty = document.getElementById('blogHistoryEmpty');
const blogHistoryList = document.getElementById('blogHistoryList');
const newBlogBtn = document.getElementById('newBlogBtn');

// Load on init
loadBlogHistory();

// ─── New Blog ───────────────────────────────────────────────────
newBlogBtn.addEventListener('click', () => {
    currentBlogId = null;
    generatedBlog = null;
    blogForm.reset();
    wordCountValue.textContent = wordCountInput.value;
    keywordsList = [];
    keywordTags.innerHTML = '';
    previewEmpty.style.display = 'flex';
    previewLoading.style.display = 'none';
    previewContent.style.display = 'none';
    previewActions.style.display = 'none';
    seoBar.style.display = 'none';
    publishPanel.style.display = 'none';
    publishResult.style.display = 'none';
    blogBody.contentEditable = 'false';
    blogBody.innerHTML = '';

    // Deselect all blog history items
    document.querySelectorAll('.blog-history-item').forEach(i => i.classList.remove('active'));
});

// ─── localStorage Blog Helpers ─────────────────────────────────
function getLocalBlogs() {
    try { return JSON.parse(localStorage.getItem('orbit_blogs') || '[]'); } catch { return []; }
}

function saveLocalBlogs(blogs) {
    localStorage.setItem('orbit_blogs', JSON.stringify(blogs));
}

function saveBlogToLocal(blog) {
    const blogs = getLocalBlogs();
    const idx = blogs.findIndex(b => b.id === blog.id);
    if (idx >= 0) blogs[idx] = blog; else blogs.unshift(blog);
    saveLocalBlogs(blogs);
}

function removeBlogFromLocal(blogId) {
    saveLocalBlogs(getLocalBlogs().filter(b => b.id !== blogId));
}

// ─── Load Blog History (localStorage + server merge) ───────────
async function loadBlogHistory() {
    try {
        // Start with localStorage (instant)
        let blogs = getLocalBlogs();

        // Try to merge with server
        try {
            const res = await fetch(`${API_BASE}/api/blogs`);
            if (res.ok) {
                const serverBlogs = await res.json();
                // Merge: add server blogs not in local
                const localIds = new Set(blogs.map(b => b.id));
                for (const sb of serverBlogs) {
                    if (!localIds.has(sb.id)) blogs.push(sb);
                }
                // Sort newest first
                blogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                // Update localStorage with merged result
                saveLocalBlogs(blogs);
            }
        } catch { /* server unavailable, use local only */ }

        const filterVal = document.getElementById('blogHistoryFilter')?.value || 'all';
        const currentUser = window.currentUser?.name || 'Unknown';

        if (filterVal === 'me') {
            blogs = blogs.filter(b => b.userName === currentUser);
        }

        if (blogs.length === 0) {
            blogHistoryEmpty.style.display = '';
            blogHistoryList.style.display = 'none';
            return;
        }

        blogHistoryEmpty.style.display = 'none';
        blogHistoryList.style.display = '';

        blogHistoryList.innerHTML = blogs.map(blog => {
            const date = new Date(blog.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const badge = blog.published
                ? '<span class="blog-item-badge published">Published</span>'
                : '<span class="blog-item-badge draft">Draft</span>';
            const isActive = blog.id === currentBlogId ? ' active' : '';
            return `
              <div class="blog-history-item${isActive}" data-blog-id="${blog.id}">
                <div class="blog-item-info">
                  <div class="blog-item-title">${blog.title}</div>
                  <div class="blog-item-meta">
                    <span class="blog-item-date">${date}</span>
                    <span class="blog-item-date" style="color: var(--accent-primary)">By ${blog.userName || 'Unknown'}</span>
                    ${badge}
                  </div>
                </div>
                <div class="blog-item-actions">
                  <button class="delete-call-btn delete-blog-btn" data-blog-id="${blog.id}" title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                  </button>
                </div>
              </div>`;
        }).join('');

        // Bind click on items (view blog)
        blogHistoryList.querySelectorAll('.blog-history-item').forEach(item => {
            item.addEventListener('click', e => {
                if (e.target.closest('.delete-blog-btn')) return;
                viewBlog(item.dataset.blogId);
            });
        });

        // Bind delete buttons
        blogHistoryList.querySelectorAll('.delete-blog-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                deleteBlog(btn.dataset.blogId);
            });
        });
    } catch (err) {
        console.error('Failed to load blog history:', err);
    }
}

// ─── View a Saved Blog ─────────────────────────────────────────
async function viewBlog(blogId) {
    try {
        // Try server first, fall back to localStorage
        let blog;
        try {
            const res = await fetch(`${API_BASE}/api/blogs/${blogId}`);
            if (res.ok) blog = await res.json();
        } catch { }
        if (!blog) blog = getLocalBlogs().find(b => b.id === blogId);
        if (!blog) { showToast('Blog not found', 'error'); return; }

        currentBlogId = blog.id;
        generatedBlog = {
            title: blog.title,
            content: blog.markdown,
            htmlContent: blog.html,
            metaTitle: blog.seoTitle,
            metaDescription: blog.seoDescription,
            seoKeywords: blog.seoKeywords,
            spanishTitle: blog.spanishTitle || null,
        };

        // Restore Spanish content
        const langTabs = document.getElementById('langTabs');
        if (blog.spanishHtml) {
            spanishBlogHtml = blog.spanishHtml;
            langTabs.style.display = 'flex';
            currentPreviewLang = 'en';
            langTabs.querySelectorAll('.lang-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.lang === 'en');
            });
        } else {
            spanishBlogHtml = null;
            langTabs.style.display = 'none';
        }

        // Show SEO bar
        if (blog.seoTitle || blog.seoDescription) {
            seoTitle.textContent = blog.seoTitle || '';
            seoMetaDesc.textContent = blog.seoDescription || '';
            seoKeywords.innerHTML = (blog.seoKeywords || [])
                .map(k => `<span class="seo-keyword">${k}</span>`)
                .join('');
            seoBar.style.display = 'flex';
        }

        // Show blog content (editable)
        blogBody.innerHTML = blog.html || blog.markdown;
        blogBody.contentEditable = 'true';

        showState('content');
        publishPanel.style.display = 'block';
        publishResult.style.display = 'none';

        // Show save edits button
        let saveEditsBtn = document.getElementById('saveEditsBtn');
        if (!saveEditsBtn) {
            saveEditsBtn = document.createElement('button');
            saveEditsBtn.id = 'saveEditsBtn';
            saveEditsBtn.className = 'btn-outline';
            saveEditsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Edits';
            previewActions.appendChild(saveEditsBtn);
        }
        saveEditsBtn.style.display = 'inline-flex';
        saveEditsBtn.onclick = () => saveBlogEdits();

        // Highlight active history item
        document.querySelectorAll('.blog-history-item').forEach(i => {
            i.classList.toggle('active', i.dataset.blogId === blogId);
        });

        showToast(`Loaded: "${blog.title}"`);
    } catch (err) {
        showToast('Failed to load blog', 'error');
    }
}

// ─── Save Blog Edits ────────────────────────────────────────
async function saveBlogEdits() {
    if (!currentBlogId) return;
    const updatedHtml = blogBody.innerHTML;

    // Extract title from H1
    const titleMatch = updatedHtml.match(/<h1[^>]*>(.+?)<\/h1>/i);
    const updatedTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : generatedBlog?.title || 'Untitled';

    // Update server
    try {
        await fetch(`${API_BASE}/api/blogs/${currentBlogId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html: updatedHtml, title: updatedTitle }),
        });
    } catch { }

    // Update localStorage
    const blogs = getLocalBlogs();
    const idx = blogs.findIndex(b => b.id === currentBlogId);
    if (idx >= 0) {
        blogs[idx].html = updatedHtml;
        blogs[idx].title = updatedTitle;
        blogs[idx].updatedAt = new Date().toISOString();
        saveLocalBlogs(blogs);
    }

    // Update in-memory state
    if (generatedBlog) {
        generatedBlog.htmlContent = updatedHtml;
        generatedBlog.title = updatedTitle;
    }

    loadBlogHistory();
    showToast('Edits saved!');
}

// ─── Delete a Blog ──────────────────────────────────────────────
async function deleteBlog(blogId) {
    const confirmed = await showDeleteModal('Are you sure you want to delete this blog? This action cannot be undone.');
    if (!confirmed) return;
    try { await fetch(`${API_BASE}/api/blogs/${blogId}`, { method: 'DELETE' }); } catch { }
    removeBlogFromLocal(blogId);
    if (currentBlogId === blogId) {
        newBlogBtn.click();
    }
    loadBlogHistory();
    showToast('Blog deleted');
}

// ─── AI SALES ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const salesCallForm = document.getElementById('salesCallForm');
const callBtn = document.getElementById('callBtn');
const callLogEmpty = document.getElementById('callLogEmpty');
const callLog = document.getElementById('callLog');
const callLogBody = document.getElementById('callLogBody');
const clearAllCallsBtn = document.getElementById('clearAllCallsBtn');

let allCalls = [];
let activeFilter = 'all';

// ─── localStorage Call Helpers ──────────────────────────────────
function getLocalCalls() {
    try { return JSON.parse(localStorage.getItem('orbit_calls') || '[]'); } catch { return []; }
}

function saveLocalCalls(calls) {
    localStorage.setItem('orbit_calls', JSON.stringify(calls));
}

function saveCallToLocal(call) {
    const calls = getLocalCalls();
    const idx = calls.findIndex(c => c.id === call.id);
    if (idx >= 0) calls[idx] = call; else calls.unshift(call);
    saveLocalCalls(calls);
}

function removeCallFromLocal(callId) {
    saveLocalCalls(getLocalCalls().filter(c => c.id !== callId));
}

// ─── Filter Tabs ────────────────────────────────────────────────
document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeFilter = tab.dataset.filter;
        renderFilteredCalls();
    });
});

// ─── Delete Confirmation Modal ──────────────────────────────────
const deleteModal = document.getElementById('deleteModal');
const deleteModalDesc = document.getElementById('deleteModalDesc');
const deleteConfirmInput = document.getElementById('deleteConfirmInput');
const deleteModalConfirm = document.getElementById('deleteModalConfirm');
const deleteModalCancel = document.getElementById('deleteModalCancel');

function showDeleteModal(description) {
    return new Promise(resolve => {
        deleteModalDesc.textContent = description;
        deleteConfirmInput.value = '';
        deleteModalConfirm.disabled = true;
        deleteModal.style.display = '';

        deleteConfirmInput.focus();

        function onInput() {
            deleteModalConfirm.disabled = deleteConfirmInput.value.toLowerCase() !== 'delete';
        }

        function cleanup() {
            deleteConfirmInput.removeEventListener('input', onInput);
            deleteModalConfirm.removeEventListener('click', onConfirm);
            deleteModalCancel.removeEventListener('click', onCancel);
            deleteModal.removeEventListener('click', onOverlay);
            deleteModal.style.display = 'none';
        }

        function onConfirm() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onOverlay(e) { if (e.target === deleteModal) { cleanup(); resolve(false); } }

        deleteConfirmInput.addEventListener('input', onInput);
        deleteModalConfirm.addEventListener('click', onConfirm);
        deleteModalCancel.addEventListener('click', onCancel);
        deleteModal.addEventListener('click', onOverlay);
    });
}

// ─── Clear All ──────────────────────────────────────────────────
clearAllCallsBtn.addEventListener('click', async () => {
    const confirmed = await showDeleteModal('Are you sure you want to delete all call logs? This action cannot be undone.');
    if (!confirmed) return;
    for (const call of allCalls) {
        await fetch(`${API_BASE}/api/sales/call/${call.id}`, { method: 'DELETE' });
    }
    allCalls = [];
    saveLocalCalls([]);
    renderFilteredCalls();
    showToast('All call logs cleared');
});

// ─── Delete a Call ──────────────────────────────────────────────
async function deleteCall(callId) {
    const confirmed = await showDeleteModal('Are you sure you want to delete this call? This action cannot be undone.');
    if (!confirmed) return;
    await fetch(`${API_BASE}/api/sales/call/${callId}`, { method: 'DELETE' });
    allCalls = allCalls.filter(c => c.id !== callId);
    removeCallFromLocal(callId);
    renderFilteredCalls();
    showToast('Call deleted');
}

// ─── Initiate a Call ─────────────────────────────────────────────
salesCallForm.addEventListener('submit', async e => {
    e.preventDefault();

    const phoneNumber = document.getElementById('salesPhone').value.trim();
    const contactName = document.getElementById('salesName').value.trim();
    const company = document.getElementById('salesCompany').value.trim();
    const salesScript = document.getElementById('salesScript').value.trim();

    if (!phoneNumber) return;

    callBtn.disabled = true;
    callBtn.querySelector('.btn-text').style.display = 'none';
    callBtn.querySelector('.btn-loader').style.display = 'inline-flex';

    try {
        const res = await fetch(`${API_BASE}/api/sales/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber, contactName, company, salesScript: salesScript || undefined }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Call failed');
        }

        const data = await res.json();
        // Save to localStorage immediately so it survives refresh
        saveCallToLocal({
            id: data.callId,
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
        showToast(`📞 Calling ${contactName || phoneNumber}…`);
        pollCallStatus(data.callId);
        await loadCallLog();
        salesCallForm.reset();
    } catch (err) {
        showToast(err.message || 'Call initiation failed', 'error');
    } finally {
        callBtn.disabled = false;
        callBtn.querySelector('.btn-text').style.display = 'inline-flex';
        callBtn.querySelector('.btn-loader').style.display = 'none';
    }
});

// ─── Poll Call Status ───────────────────────────────────────────
function pollCallStatus(callId) {
    let attempts = 0;
    let postEndPolls = 0;
    const maxPostEndPolls = 6; // Keep polling 30s after call ends for recording/analysis
    let callEnded = false;

    const interval = setInterval(async () => {
        if (++attempts > 60) { clearInterval(interval); return; }
        try {
            const res = await fetch(`${API_BASE}/api/sales/call/${callId}`);
            if (!res.ok) return;
            const call = await res.json();
            saveCallToLocal(call);

            if (!callEnded && !['in_progress', 'ringing', 'queued'].includes(call.status)) {
                callEnded = true;
                showToast(`Call to ${call.contactName || call.phoneNumber} completed`);
            }

            if (callEnded) {
                postEndPolls++;
                // Refresh the full list to show recording/analysis updates
                await loadCallLog();

                // Stop if we have both recording and analysis, or exhausted post-end polls
                if ((call.recordingUrl && call.analysis) || postEndPolls >= maxPostEndPolls) {
                    clearInterval(interval);
                    if (call.analysis) {
                        showToast(`AI analysis ready for ${call.contactName || call.phoneNumber}`);
                    }
                }
            } else {
                updateCallRow(call);
            }
        } catch { /* retry */ }
    }, 5000);
}

// ─── Load Call Log (localStorage + server merge) ────────────────
async function loadCallLog() {
    try {
        // Start with localStorage (instant)
        let calls = getLocalCalls();

        // Try to merge with server
        try {
            const res = await fetch(`${API_BASE}/api/sales/calls`);
            if (res.ok) {
                const serverCalls = await res.json();
                // Merge: server calls take priority (they have latest status/analysis)
                const mergedMap = new Map();
                for (const c of calls) mergedMap.set(c.id, c);
                for (const c of serverCalls) mergedMap.set(c.id, c); // server overwrites local
                calls = Array.from(mergedMap.values());
                // Sort newest first
                calls.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
                // Update localStorage with merged result
                saveLocalCalls(calls);
            }
        } catch { /* server unavailable, use local only */ }

        allCalls = calls;
        renderFilteredCalls();
    } catch (err) {
        console.error('Failed to load calls:', err);
    }
}

// ─── Render Filtered Calls ──────────────────────────────────────
function renderFilteredCalls() {
    const filtered = activeFilter === 'all'
        ? allCalls
        : allCalls.filter(c => c.status === activeFilter);

    if (allCalls.length === 0) {
        callLogEmpty.style.display = '';
        callLog.style.display = 'none';
        clearAllCallsBtn.style.display = 'none';
        return;
    }

    callLogEmpty.style.display = filtered.length === 0 ? '' : 'none';
    callLog.style.display = filtered.length === 0 ? 'none' : '';
    clearAllCallsBtn.style.display = '';

    if (filtered.length === 0) {
        callLogEmpty.querySelector('h4').textContent = 'No calls in this category';
        callLogEmpty.querySelector('p').textContent = 'Try a different filter';
        return;
    }

    callLogBody.innerHTML = filtered.map(call => renderCallRow(call)).join('');

    // Bind expand + delete buttons
    callLogBody.querySelectorAll('.expand-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const expandRow = document.getElementById(`expand-${btn.dataset.callId}`);
            if (expandRow) {
                expandRow.style.display = expandRow.style.display === 'none' ? '' : 'none';
                btn.classList.toggle('open');
            }
        });
    });
    callLogBody.querySelectorAll('.delete-call-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            deleteCall(btn.dataset.callId);
        });
    });
}

// ─── Render Call Row ────────────────────────────────────────────
function renderCallRow(call) {
    const statusLabel = formatStatus(call.status);
    const duration = call.duration ? formatDuration(call.duration) : '—';
    const date = call.startedAt ? new Date(call.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const hasAnalysis = call.analysis && call.analysis.summary;
    const hasRecording = !!call.recordingUrl;
    const hasTranscript = !!call.transcript;
    const hasExpandable = hasAnalysis || hasRecording || hasTranscript;

    let expandContent = '';
    if (hasExpandable) {
        let analysisHtml = '';
        if (hasAnalysis) {
            const a = call.analysis;
            const interestClass = a.interestLevel === 'high' ? 'interest-high' : a.interestLevel === 'medium' ? 'interest-medium' : 'interest-low';
            analysisHtml = `
            ${a.interestLevel ? `<span class="interest-badge ${interestClass}">${a.interestLevel} interest</span>` : ''}
            <div class="expand-summary-box">
              <div class="summary-label">AI Summary</div>
              <p>${a.summary}</p>
              ${a.followUpRecommendation ? `<div class="summary-followup"><strong>📋 Follow-up:</strong> ${a.followUpRecommendation}</div>` : ''}
            </div>
            <div class="call-analysis-grid">
              ${a.painPoints?.length ? `<div class="analysis-card"><h5>🔴 Pain Points</h5><ul>${a.painPoints.map(p => `<li>${p}</li>`).join('')}</ul></div>` : ''}
              ${a.currentSoftware?.length ? `<div class="analysis-card"><h5>💻 Current Software</h5><ul>${a.currentSoftware.map(s => `<li>${s}</li>`).join('')}</ul></div>` : ''}
              ${a.objections?.length ? `<div class="analysis-card"><h5>⚠️ Objections</h5><ul>${a.objections.map(o => `<li>${o}</li>`).join('')}</ul></div>` : ''}
              ${a.keyQuotes?.length ? `<div class="analysis-card quotes-card"><h5>💬 Key Quotes</h5><ul>${a.keyQuotes.map(q => `<li>"${q}"</li>`).join('')}</ul></div>` : ''}
            </div>`;
        }

        expandContent = `
      <tr class="call-expand-row" id="expand-${call.id}" style="display:none;">
        <td colspan="6">
          <div class="call-expand-content">
            <div class="expand-header">
              <div class="expand-header-left">
                <h4>${call.contactName || 'Unknown'}${call.company ? ` · ${call.company}` : ''}</h4>
                ${analysisHtml ? '' : `<span class="status-badge ${call.status}" style="margin-left:8px">${statusLabel}</span>`}
              </div>
            </div>

            ${hasRecording ? `<div class="call-recording"><h4>🎙️ Recording</h4><audio controls src="${call.recordingUrl}"></audio></div>` : ''}

            ${analysisHtml}

            ${hasTranscript ? `<div class="transcript-section"><h4>📝 Full Transcript</h4><div class="transcript-body">${call.transcript}</div></div>` : ''}
          </div>
        </td>
      </tr>`;
    }

    return `
    <tr id="row-${call.id}">
      <td>
        <div class="call-contact-name">${call.contactName || 'Unknown'}</div>
        ${call.company ? `<div class="call-contact-company">${call.company}</div>` : ''}
      </td>
      <td>${call.phoneNumber}</td>
      <td><span class="status-badge ${call.status}">${statusLabel}</span></td>
      <td class="call-duration">${duration}</td>
      <td class="call-date">${date}</td>
      <td>
        ${hasExpandable ? `<button class="expand-btn" data-call-id="${call.id}">▼</button>` : ''}
        <button class="delete-call-btn" data-call-id="${call.id}" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg></button>
      </td>
    </tr>
    ${expandContent}`;
}

function updateCallRow(call) {
    const row = document.getElementById(`row-${call.id}`);
    if (!row) return;
    const badge = row.querySelector('.status-badge');
    if (badge) {
        badge.className = `status-badge ${call.status}`;
        badge.textContent = formatStatus(call.status);
    }
}

function formatStatus(status) {
    const map = {
        meeting_booked: 'Meeting Booked',
        callback: 'Call Back',
        not_interested: 'Not Interested',
        no_answer: 'No Answer',
        voicemail: 'Voicemail',
        in_progress: 'In Progress',
        ringing: 'Ringing',
        completed: 'Completed',
    };
    return map[status] || status;
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════
// ─── POSTS GENERATOR ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const adForm = document.getElementById('adForm');
const adGenerateBtn = document.getElementById('adGenerateBtn');
const adProgress = document.getElementById('adProgress');
const adProgressFill = document.getElementById('adProgressFill');
const adProgressText = document.getElementById('adProgressText');
const adProgressPct = document.getElementById('adProgressPct');
const adEmpty = document.getElementById('adEmpty');
const adOutputBody = document.getElementById('adOutputBody');
const adOutputActions = document.getElementById('adOutputActions');
const adCopyBtn = document.getElementById('adCopyBtn');
const adHistoryEmpty = document.getElementById('adHistoryEmpty');
const adHistoryList = document.getElementById('adHistoryList');
const durationRow = document.getElementById('durationRow');

// ─── Example Image Upload ───────────────────────────────────────
const imageUploadArea = document.getElementById('imageUploadArea');
const adImageInput = document.getElementById('adImageInput');
const imagePreviewGrid = document.getElementById('imagePreviewGrid');
const adGenerateImagesBtn = document.getElementById('adGenerateImagesBtn');
const adImagesGallery = document.getElementById('adImagesGallery');
const adImageProgress = document.getElementById('adImageProgress');
const adImageProgressText = document.getElementById('adImageProgressText');
const adImageProgressFill = document.getElementById('adImageProgressFill');

let exampleImages = []; // { name, dataUrl }

imageUploadArea.addEventListener('click', (e) => {
    if (e.target.closest('.remove-img-btn')) return;
    adImageInput.click();
});
imageUploadArea.addEventListener('dragover', e => { e.preventDefault(); imageUploadArea.classList.add('drag-over'); });
imageUploadArea.addEventListener('dragleave', () => imageUploadArea.classList.remove('drag-over'));
imageUploadArea.addEventListener('drop', e => {
    e.preventDefault();
    imageUploadArea.classList.remove('drag-over');
    handleImageFiles(e.dataTransfer.files);
});
adImageInput.addEventListener('change', () => { handleImageFiles(adImageInput.files); adImageInput.value = ''; });

function handleImageFiles(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = () => {
            exampleImages.push({ name: file.name, dataUrl: reader.result });
            renderImagePreviews();
        };
        reader.readAsDataURL(file);
    }
}

function renderImagePreviews() {
    imagePreviewGrid.innerHTML = exampleImages.map((img, i) => `
        <div class="image-preview-thumb">
            <img src="${img.dataUrl}" alt="${img.name}" />
            <button type="button" class="remove-img-btn" data-idx="${i}">×</button>
        </div>
    `).join('');
    imagePreviewGrid.querySelectorAll('.remove-img-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            exampleImages.splice(parseInt(btn.dataset.idx), 1);
            renderImagePreviews();
        });
    });
}

// ─── Generate Ad Images ─────────────────────────────────────────
adGenerateImagesBtn.addEventListener('click', async () => {
    if (!adFullContent) { showToast('Generate ad text first', 'error'); return; }

    adGenerateImagesBtn.disabled = true;
    adGenerateImagesBtn.textContent = 'Generating…';
    adImageProgress.style.display = '';
    adImageProgressFill.style.width = '0%';
    adImageProgressText.textContent = 'Analyzing ad content…';
    adImagesGallery.style.display = 'none';
    adImagesGallery.innerHTML = '';

    try {
        const product = document.getElementById('adProduct').value.trim();
        const description = document.getElementById('adDescription').value.trim();

        const res = await fetch(`${API_BASE}/api/ads/generate-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                adContent: adFullContent,
                product,
                description,
                exampleImages: exampleImages.map(img => img.dataUrl),
            }),
        });

        if (!res.ok) throw new Error('Image generation failed');

        const reader = res.body.getReader();
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
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'progress') {
                        adImageProgressText.textContent = data.text;
                        adImageProgressFill.style.width = `${data.pct}%`;
                    }
                    if (data.type === 'image') {
                        adImagesGallery.style.display = 'grid';
                        adImagesGallery.innerHTML += `
                            <div class="ad-image-card">
                                <img src="${data.dataUrl}" alt="${data.prompt || 'Ad image'}" />
                                <div class="ad-image-actions">
                                    <button onclick="downloadAdImage('${data.dataUrl}', 'ad-image-${data.index}.png')">⬇ Download</button>
                                </div>
                            </div>`;
                    }
                    if (data.type === 'complete') {
                        adImageProgress.style.display = 'none';
                        showToast(`${data.count} ad images generated!`);
                    }
                    if (data.type === 'error') throw new Error(data.error);
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
            }
        }
    } catch (err) {
        console.error('Ad image generation error:', err);
        showToast(err.message || 'Image generation failed', 'error');
        adImageProgress.style.display = 'none';
    } finally {
        adGenerateImagesBtn.disabled = false;
        adGenerateImagesBtn.textContent = '🎨 Generate Ad Images';
    }
});

// Download helper
window.downloadAdImage = function (dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
};

// Toggles
const videoToggles = ['togReels', 'togYoutubeShorts', 'togVideoScript'];

// Show/hide duration input when any video toggle is active
document.querySelectorAll('.toggle-row input').forEach(input => {
    input.addEventListener('change', () => {
        const anyVideo = videoToggles.some(id => document.getElementById(id).checked);
        durationRow.style.display = anyVideo ? '' : 'none';
    });
});

let adFullContent = '';

// ─── Stepper +/- ────────────────────────────────────────────────
const stepperValue = document.getElementById('adPostCount');
document.getElementById('stepperMinus').addEventListener('click', () => {
    const v = Math.max(1, parseInt(stepperValue.textContent) - 1);
    stepperValue.textContent = v;
});
document.getElementById('stepperPlus').addEventListener('click', () => {
    const v = Math.min(999, parseInt(stepperValue.textContent) + 1);
    stepperValue.textContent = v;
});

// ─── Custom CTA Dropdown Logic ──────────────────────────────────
const ctaGoalWrapper = document.getElementById('ctaGoalWrapper');
const ctaGoalTrigger = document.getElementById('ctaGoalTrigger');
const ctaGoalText = document.getElementById('ctaGoalText');
const ctaGoalOptions = document.getElementById('ctaGoalOptions');
const ctaGoalInput = document.getElementById('adCtaGoal');

if (ctaGoalTrigger && ctaGoalOptions) {
    ctaGoalTrigger.addEventListener('click', () => {
        ctaGoalWrapper.classList.toggle('open');
    });

    ctaGoalOptions.querySelectorAll('.custom-option').forEach(option => {
        option.addEventListener('click', function () {
            // Update value and text
            ctaGoalInput.value = this.getAttribute('data-value');
            ctaGoalText.textContent = this.textContent;

            // Update selected class
            ctaGoalOptions.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');

            // Close dropdown
            ctaGoalWrapper.classList.remove('open');
        });
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!ctaGoalWrapper.contains(e.target)) {
            ctaGoalWrapper.classList.remove('open');
        }
    });
}

// ─── Blog Tone Dropdown ────────────────────────────────────────
{
    const wrapper = document.getElementById('blogToneWrapper');
    const trigger = document.getElementById('blogToneTrigger');
    const textEl = document.getElementById('blogToneText');
    const optionsEl = document.getElementById('blogToneOptions');
    const hiddenInput = document.getElementById('blogToneValue');

    if (trigger && optionsEl) {
        trigger.addEventListener('click', () => wrapper.classList.toggle('open'));

        optionsEl.querySelectorAll('.custom-option').forEach(option => {
            option.addEventListener('click', function () {
                hiddenInput.value = this.getAttribute('data-value');
                textEl.textContent = this.textContent;
                optionsEl.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
                this.classList.add('selected');
                wrapper.classList.remove('open');
            });
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
        });
    }
}

// ─── Blog Language Dropdown ────────────────────────────────────
{
    const wrapper = document.getElementById('blogLangWrapper');
    const trigger = document.getElementById('blogLangTrigger');
    const textEl = document.getElementById('blogLangText');
    const optionsEl = document.getElementById('blogLangOptions');
    const hiddenInput = document.getElementById('blogLangValue');

    if (trigger && optionsEl) {
        trigger.addEventListener('click', () => wrapper.classList.toggle('open'));

        optionsEl.querySelectorAll('.custom-option').forEach(option => {
            option.addEventListener('click', function () {
                hiddenInput.value = this.getAttribute('data-value');
                textEl.textContent = this.textContent;
                optionsEl.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
                this.classList.add('selected');
                wrapper.classList.remove('open');
            });
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) wrapper.classList.remove('open');
        });
    }
}

// ─── Language Preview Tabs ─────────────────────────────────────
{
    const langTabs = document.getElementById('langTabs');
    if (langTabs) {
        langTabs.querySelectorAll('.lang-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const lang = tab.dataset.lang;
                const blogBody = document.getElementById('blogBody');

                // Save edits from current tab before switching
                if (currentPreviewLang === 'es') {
                    spanishBlogHtml = blogBody.innerHTML;
                } else {
                    englishBlogHtml = blogBody.innerHTML;
                }

                currentPreviewLang = lang;
                langTabs.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Load content for selected tab
                if (lang === 'es' && spanishBlogHtml) {
                    blogBody.innerHTML = spanishBlogHtml;
                } else if (englishBlogHtml) {
                    blogBody.innerHTML = englishBlogHtml;
                } else if (generatedBlog) {
                    let cleanContent = generatedBlog.content
                        .replace(/<!--\s*SEO_TITLE:.*?-->\n?/g, '')
                        .replace(/<!--\s*META_DESC:.*?-->\n?/g, '')
                        .replace(/<!--\s*SEO_KEYWORDS:.*?-->\n?/g, '');
                    blogBody.innerHTML = cleanContent;
                }
                blogBody.contentEditable = 'true';
            });
        });
    }
}
let uploadedFiles = [];

// ─── File Upload (drag & drop + click) ──────────────────────────
const fileUploadArea = document.getElementById('fileUploadArea');
const fileInputEl = document.getElementById('adFileInput');
const fileListEl = document.getElementById('fileList');
const filePromptEl = document.getElementById('fileUploadPrompt');

fileUploadArea.addEventListener('click', () => fileInputEl.click());

fileUploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    fileUploadArea.classList.add('drag-over');
});

fileUploadArea.addEventListener('dragleave', () => {
    fileUploadArea.classList.remove('drag-over');
});

fileUploadArea.addEventListener('drop', e => {
    e.preventDefault();
    fileUploadArea.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
});

fileInputEl.addEventListener('change', () => {
    handleFiles(fileInputEl.files);
    fileInputEl.value = '';
});

async function handleFiles(files) {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);

    try {
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        uploadedFiles.push(...data.files);
        renderFileList();
        showToast(`${data.files.length} file(s) uploaded`);
    } catch (err) {
        showToast('File upload failed', 'error');
    }
}

function renderFileList() {
    if (uploadedFiles.length === 0) {
        fileListEl.innerHTML = '';
        filePromptEl.style.display = '';
        return;
    }
    filePromptEl.style.display = 'none';
    fileListEl.innerHTML = uploadedFiles.map((f, i) => `
        <div class="file-item">
            <span class="file-item-name">📄 ${f.name} <small>(${(f.size / 1024).toFixed(1)} KB)</small></span>
            <button class="file-item-remove" data-idx="${i}" title="Remove">✕</button>
        </div>
    `).join('');

    fileListEl.querySelectorAll('.file-item-remove').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            uploadedFiles.splice(Number(btn.dataset.idx), 1);
            renderFileList();
        });
    });
}

// ─── Email Send ─────────────────────────────────────────────────
const adEmailBtn = document.getElementById('adEmailBtn');
adEmailBtn.addEventListener('click', async () => {
    if (!adFullContent) return;

    const authEmail = prompt('Authentication Required: Please enter your email address to connect your account and send this campaign to the agency:');
    if (!authEmail || !authEmail.includes('@')) {
        showToast('Invalid or no email provided. Email authorization cancelled.', 'error');
        return;
    }

    adEmailBtn.disabled = true;
    adEmailBtn.textContent = '📧 Sending…';

    try {
        const product = document.getElementById('adProduct').value.trim();
        const res = await fetch(`${API_BASE}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject: `Ad Creative: ${product} (Authorized by ${authEmail})`,
                textContent: `Authorized Sender: ${authEmail}\n\n${adFullContent}`,
            }),
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Email sent to ${data.to}`);
        } else {
            throw new Error(data.error);
        }
    } catch (err) {
        showToast(err.message || 'Email failed', 'error');
    } finally {
        adEmailBtn.disabled = false;
        adEmailBtn.textContent = '📧 Send to Agency';
    }
});

// ─── Generate ───────────────────────────────────────────────────
adForm.addEventListener('submit', async e => {
    e.preventDefault();

    const product = document.getElementById('adProduct').value.trim();
    let description = document.getElementById('adDescription').value.trim();

    // Append uploaded file contents as context
    if (uploadedFiles.length > 0) {
        const fileContext = uploadedFiles.map(f => `--- File: ${f.name} ---\n${f.text}`).join('\n\n');
        description = (description ? description + '\n\n' : '') + 'ATTACHED PRODUCT FILES:\n' + fileContext;
    }

    if (!product) return;

    const platforms = {
        instagram: document.getElementById('togInstagram').checked,
        reels: document.getElementById('togReels').checked,
        youtubeShorts: document.getElementById('togYoutubeShorts').checked,
        linkedin: document.getElementById('togLinkedin').checked,
        x: document.getElementById('togX').checked,
        videoScript: document.getElementById('togVideoScript').checked,
    };
    const videoDuration = document.getElementById('adDuration').value.trim();
    const postCount = parseInt(document.getElementById('adPostCount').textContent) || 3;
    const ctaGoal = document.getElementById('adCtaGoal').value;

    // UI: loading state
    adGenerateBtn.disabled = true;
    adGenerateBtn.querySelector('.btn-text').style.display = 'none';
    adGenerateBtn.querySelector('.btn-loader').style.display = 'inline-flex';
    adEmpty.style.display = 'none';
    adOutputBody.style.display = 'block';
    adOutputBody.innerHTML = '';
    adOutputActions.style.display = 'none';
    adProgress.style.display = '';
    adProgressFill.style.width = '0%';
    adProgressPct.textContent = '0%';
    adProgressText.textContent = 'Starting…';
    adFullContent = '';

    let currentPct = 0;
    let targetPct = 0;
    const smoothInterval = setInterval(() => {
        if (currentPct < targetPct) {
            const diff = targetPct - currentPct;
            const step = Math.max(0.3, diff * 0.08);
            currentPct = Math.min(currentPct + step, targetPct);
        } else if (currentPct < 95 && targetPct > 0) {
            currentPct += 0.15;
        }
        const rounded = Math.round(currentPct);
        adProgressFill.style.width = `${rounded}%`;
        adProgressPct.textContent = `${rounded}%`;
    }, 200);

    try {
        const userName = window.currentUser?.name || 'Unknown';
        const res = await fetch(`${API_BASE}/api/ads/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product, description, platforms, videoDuration, postCount, ctaGoal, userName }),
        });

        if (!res.ok || !res.body) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Ad generation failed (HTTP ${res.status})`);
        }

        const reader = res.body.getReader();
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
                try {
                    const data = JSON.parse(line.slice(6));

                    if (data.type === 'progress') {
                        targetPct = data.pct;
                        adProgressText.textContent = data.text;
                    }

                    if (data.type === 'chunk') {
                        adFullContent += data.content;
                        adOutputBody.innerHTML = marked.parse(adFullContent);
                    }

                    if (data.type === 'complete') {
                        adOutputBody.innerHTML = marked.parse(adFullContent);
                        adOutputActions.style.display = 'flex';
                        adProgress.style.display = 'none';
                        showToast(`Ad content generated for "${product}"`);
                        loadAdHistory();
                    }

                    if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
            }
        }
    } catch (err) {
        console.error('Ad generation error:', err);
        showToast(err.message || 'Ad generation failed', 'error');
    } finally {
        clearInterval(smoothInterval);
        adGenerateBtn.disabled = false;
        adGenerateBtn.querySelector('.btn-text').style.display = 'inline';
        adGenerateBtn.querySelector('.btn-loader').style.display = 'none';
    }
});

// ─── Copy All ───────────────────────────────────────────────────
adCopyBtn.addEventListener('click', async () => {
    if (!adFullContent) return;
    try {
        await navigator.clipboard.writeText(adFullContent);
        showToast('Ad content copied to clipboard');
    } catch {
        showToast('Failed to copy', 'error');
    }
});

// ─── Ad History ─────────────────────────────────────────────────
async function loadAdHistory() {
    try {
        const res = await fetch(`${API_BASE}/api/ads`);
        if (!res.ok) return;
        let ads = await res.json();

        const filterVal = document.getElementById('postHistoryFilter')?.value || 'all';
        const currentUser = window.currentUser?.name || 'Unknown';

        if (filterVal === 'me') {
            ads = ads.filter(a => a.userName === currentUser);
        }

        if (ads.length === 0) {
            adHistoryEmpty.style.display = '';
            adHistoryList.style.display = 'none';
            return;
        }

        adHistoryEmpty.style.display = 'none';
        adHistoryList.style.display = '';

        adHistoryList.innerHTML = ads.map(ad => {
            const date = new Date(ad.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const toggles = Object.entries(ad.platforms || {}).filter(([, v]) => v).map(([k]) => {
                const icons = { instagram: '📸', reels: '🎬', youtubeShorts: '📺', linkedin: '💼', x: '🐦', videoScript: '🎥' };
                return icons[k] || '';
            }).join(' ');
            return `
              <div class="blog-history-item" data-ad-id="${ad.id}">
                <div class="blog-item-info">
                  <div class="blog-item-title">${ad.product}</div>
                  <div class="blog-item-meta">
                    <span class="blog-item-date">${date}</span>
                    <span class="blog-item-date" style="color: var(--accent-primary)">By ${ad.userName || 'Unknown'}</span>
                    ${toggles ? `<span class="blog-item-date">${toggles}</span>` : ''}
                  </div>
                </div>
                <div class="blog-item-actions">
                  <button class="delete-call-btn delete-ad-btn" data-ad-id="${ad.id}" title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
                  </button>
                </div>
              </div>`;
        }).join('');

        // Click to view
        adHistoryList.querySelectorAll('.blog-history-item').forEach(item => {
            item.addEventListener('click', e => {
                if (e.target.closest('.delete-ad-btn')) return;
                viewAd(item.dataset.adId);
            });
        });

        // Delete
        adHistoryList.querySelectorAll('.delete-ad-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                deleteAd(btn.dataset.adId);
            });
        });
    } catch (err) {
        console.error('Failed to load ad history:', err);
    }
}

async function viewAd(adId) {
    try {
        const res = await fetch(`${API_BASE}/api/ads/${adId}`);
        if (!res.ok) return;
        const ad = await res.json();

        adFullContent = ad.content;
        adEmpty.style.display = 'none';
        adOutputBody.style.display = 'block';
        adOutputBody.innerHTML = marked.parse(ad.content);
        adOutputActions.style.display = 'flex';
        adProgress.style.display = 'none';

        document.querySelectorAll('#adHistoryList .blog-history-item').forEach(i => {
            i.classList.toggle('active', i.dataset.adId === adId);
        });

        showToast(`Loaded: "${ad.product}"`);
    } catch {
        showToast('Failed to load ad', 'error');
    }
}

async function deleteAd(adId) {
    const confirmed = await showDeleteModal('Are you sure you want to delete this post? This action cannot be undone.');
    if (!confirmed) return;
    await fetch(`${API_BASE}/api/ads/${adId}`, { method: 'DELETE' });
    loadAdHistory();
    showToast('Post deleted');
}

// ─── Filter Events ──────────────────────────────────────────────
document.getElementById('blogHistoryFilter')?.addEventListener('change', loadBlogHistory);
document.getElementById('postHistoryFilter')?.addEventListener('change', loadAdHistory);

// ═══════════════════════════════════════════════════════════════════
// ─── IMAGE & VIDEO (FAL.AI) ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const MEDIA_MODELS = {
    'text-to-image': {
        'fal-ai/nano-banana-2': 'Nano Banana 2 (Google)',
        'fal-ai/nano-banana-pro': 'Nano Banana Pro (Google)',
        'fal-ai/recraft/v4/pro/text-to-image': 'Recraft V4 Pro',
        'fal-ai/flux-2-flex': 'FLUX 2 Flex',
        'fal-ai/flux-pro/v2': 'FLUX.2 Pro',
        'fal-ai/recraft-v3': 'Recraft V3',
        'fal-ai/flux/schnell': 'FLUX.1 Schnell (Fast)',
        'fal-ai/flux/dev': 'FLUX.1 Dev',
        'imagineart/imagineart-1.5-preview/text-to-image': 'ImagineArt 1.5',
    },
    'image-to-image': {
        'fal-ai/nano-banana-2/edit': 'Nano Banana 2 Edit',
        'fal-ai/nano-banana-pro/edit': 'Nano Banana Pro Edit',
        'fal-ai/flux-kontext/pro': 'FLUX Kontext Pro',
        'fal-ai/seedream/v4.5': 'Seedream V4.5',
    },
    'text-to-video': {
        'fal-ai/kling-video/v3/pro/text-to-video': 'Kling 3.0 Pro',
        'fal-ai/veo2/text-to-video': 'Veo 2.0',
        'fal-ai/sora': 'Sora (No Watermark)',
        'fal-ai/kling-video/v1.2/pro': 'Kling 1.2 Pro (Legacy)',
    },
    'image-to-video': {
        'fal-ai/kling-video/v3/pro/image-to-video': 'Kling 3.0 Pro',
        'fal-ai/kling-video/o3/standard/image-to-video': 'Kling O3',
        'fal-ai/veo2/image-to-video': 'Veo 2.0',
        'fal-ai/kling-video/v1.2/pro': 'Kling 1.2 Pro (Legacy)',
    },
};

// Media DOM Elements (Redesigned)
var mediaTypeImageBtn = document.getElementById('mediaTypeImageBtn');
var mediaTypeVideoBtn = document.getElementById('mediaTypeVideoBtn');
var mediaTypeAudioBtn = document.getElementById('mediaTypeAudioBtn');
var mediaRefTriggerBtn = document.getElementById('mediaRefTriggerBtn');
var mediaRefInput = document.getElementById('mediaRefInput');
var mediaRefPreviewMini = document.getElementById('mediaRefPreviewMini');
var mediaRefImgMini = document.getElementById('mediaRefImgMini');
var mediaRefClearBtn = document.getElementById('mediaRefClearBtn');
var mediaPrompt = document.getElementById('mediaPrompt');


// Bottom Pills UI components
var mediaModelTrigger = document.getElementById('mediaModelTrigger');
var mediaModelOptions = document.getElementById('mediaModelOptions');
var mediaModelText = document.getElementById('mediaModelText');
var mediaModelHidden = document.getElementById('mediaModel');
var mediaModelDropdownWrapper = document.getElementById('mediaModelDropdownWrapper');

var mediaAspectTrigger = document.getElementById('mediaAspectTrigger');
var mediaAspectOptions = document.getElementById('mediaAspectOptions');
var mediaAspectText = document.getElementById('mediaAspectText');
var mediaAspectHidden = document.getElementById('mediaAspect');
var mediaAspectDropdownWrapper = document.getElementById('mediaAspectDropdownWrapper');

var mediaAudioBtn = document.getElementById('mediaAudioBtn');
var mediaAudioHidden = document.getElementById('mediaAudio');

var mediaDurationTrigger = document.getElementById('mediaDurationTrigger');
var mediaDurationOptions = document.getElementById('mediaDurationOptions');
var mediaDurationText = document.getElementById('mediaDurationText');
var mediaDurationHidden = document.getElementById('mediaDuration');
var mediaDurationDropdownWrapper = document.getElementById('mediaDurationDropdownWrapper');

var mediaQuantityTrigger = document.getElementById('mediaQuantityTrigger');
var mediaQuantityOptions = document.getElementById('mediaQuantityOptions');
var mediaQuantityText = document.getElementById('mediaQuantityText');
var mediaQuantityHidden = document.getElementById('mediaQuantity');
var mediaQuantityDropdownWrapper = document.getElementById('mediaQuantityDropdownWrapper');



var mediaForm = document.getElementById('mediaForm');
var mediaGenerateBtn = document.getElementById('mediaGenerateBtn');
var lastMediaResultUrl = null;
var lastMediaIsVideo = false;
var mediaResultContent = document.getElementById('mediaResultContent');
var mediaResultContainer = document.getElementById('mediaResult');
var mediaViewerModal = document.getElementById('mediaViewerModal');
var mediaViewerClose = document.getElementById('mediaViewerClose');
var mediaHistoryGrid = document.getElementById('mediaHistoryGrid');
var mediaHistoryEmpty = document.getElementById('mediaHistoryEmpty');
var mediaDownloadBtn = document.getElementById('mediaDownloadBtn');
var mediaProgressContainer = document.getElementById('mediaProgressContainer');
var mediaProgressFill = document.getElementById('mediaProgressFill');
var mediaProgressText = document.getElementById('mediaProgressText');

var currentMediaBaseType = 'video'; // 'image' or 'video'

// ─── Setup Media Logic ────────────────────────────────────────────────────────
function setupMediaUI() {
    if (!mediaForm) return;

    // Toggle Image/Video/Audio Base Type
    mediaTypeImageBtn.addEventListener('click', () => {
        mediaTypeImageBtn.classList.add('active');
        mediaTypeVideoBtn.classList.remove('active');
        if (mediaTypeAudioBtn) mediaTypeAudioBtn.classList.remove('active');
        currentMediaBaseType = 'image';
        updateMediaUIForType();
    });

    mediaTypeVideoBtn.addEventListener('click', () => {
        mediaTypeVideoBtn.classList.add('active');
        mediaTypeImageBtn.classList.remove('active');
        if (mediaTypeAudioBtn) mediaTypeAudioBtn.classList.remove('active');
        currentMediaBaseType = 'video';
        updateMediaUIForType();
    });

    if (mediaTypeAudioBtn) {
        mediaTypeAudioBtn.addEventListener('click', () => {
            mediaTypeAudioBtn.classList.add('active');
            mediaTypeImageBtn.classList.remove('active');
            mediaTypeVideoBtn.classList.remove('active');
            currentMediaBaseType = 'audio';
            updateMediaUIForType();
        });
    }

    function updateMediaUIForType() {
        populateMediaModels(currentMediaBaseType);
        if (currentMediaBaseType === 'image') {
            mediaDurationDropdownWrapper.style.display = 'none';
            mediaAudioBtn.style.display = 'none';
            mediaAspectDropdownWrapper.style.display = 'flex';
        } else if (currentMediaBaseType === 'audio') {
            mediaDurationDropdownWrapper.style.display = 'flex';
            mediaAudioBtn.style.display = 'none';
            mediaAspectDropdownWrapper.style.display = 'none';
        } else {
            mediaDurationDropdownWrapper.style.display = 'flex';
            mediaAudioBtn.style.display = 'flex';
            mediaAspectDropdownWrapper.style.display = 'flex';
        }
    }

    function populateMediaModels(type) {
        if (!mediaModelOptions) return;
        mediaModelOptions.innerHTML = '';
        let models = {};
        if (type === 'image') models = MEDIA_MODELS['text-to-image'];
        else if (type === 'audio') models = { 'fal-ai/playai/tts/v3': 'PlayAI TTS', 'fal-ai/stable-audio': 'Stable Audio' }; // Fallback models for audio
        else models = MEDIA_MODELS['text-to-video'];

        let firstKey = null, firstName = null;

        Object.entries(models).forEach(([key, name], index) => {
            if (index === 0) { firstKey = key; firstName = name; }
            const opt = document.createElement('div');
            opt.className = 'media-gen-option' + (index === 0 ? ' selected' : '');
            opt.dataset.value = key;
            opt.textContent = name;
            mediaModelOptions.appendChild(opt);
        });

        if (firstKey) {
            mediaModelHidden.value = firstKey;
            mediaModelText.textContent = firstName;
        }
    }

    // Initial population
    updateMediaUIForType();

    // ─── Setup Pill Dropdowns (runs once) ────────────────
    // Shared close-on-click-outside (single listener)
    document.addEventListener('click', (e) => {
        if (!mediaModelDropdownWrapper.contains(e.target)) mediaModelOptions.classList.remove('show');
        if (!mediaAspectDropdownWrapper.contains(e.target)) mediaAspectOptions.classList.remove('show');
        if (mediaDurationDropdownWrapper && !mediaDurationDropdownWrapper.contains(e.target)) {
            mediaDurationOptions.classList.remove('show');
        }
    });

    // Model Pill — use event delegation so dynamically-populated options work
    mediaModelTrigger.onclick = (e) => {
        e.stopPropagation();
        mediaModelOptions.classList.toggle('show');
    };
    mediaModelOptions.addEventListener('click', (e) => {
        const opt = e.target.closest('.media-gen-option');
        if (!opt) return;
        mediaModelOptions.querySelectorAll('.media-gen-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        mediaModelHidden.value = opt.dataset.value;
        mediaModelText.textContent = opt.textContent;
        mediaModelOptions.classList.remove('show');
    });

    // Aspect Pill
    mediaAspectTrigger.onclick = (e) => {
        e.stopPropagation();
        mediaAspectOptions.classList.toggle('show');
    };
    mediaAspectOptions.querySelectorAll('.media-gen-option').forEach(opt => {
        opt.onclick = () => {
            mediaAspectOptions.querySelectorAll('.media-gen-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            mediaAspectHidden.value = opt.dataset.value;
            mediaAspectText.textContent = opt.textContent;
            mediaAspectOptions.classList.remove('show');

            // Update the SVG icon to visually match the selected aspect ratio
            const triggerSvg = mediaAspectTrigger.querySelector('svg');
            if (triggerSvg) {
                const ratio = opt.dataset.value;
                if (ratio === '9:16') {
                    triggerSvg.innerHTML = '<rect x="6" y="2" width="12" height="20" rx="2" />';
                } else if (ratio === '1:1') {
                    triggerSvg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" />';
                } else {
                    // 16:9 (default landscape)
                    triggerSvg.innerHTML = '<rect x="2" y="6" width="20" height="12" rx="2" />';
                }
            }
        };
    });

    // Duration Pill
    if (mediaDurationTrigger) {
        mediaDurationTrigger.onclick = (e) => {
            e.stopPropagation();
            mediaDurationOptions.classList.toggle('show');
        };
        mediaDurationOptions.querySelectorAll('.media-gen-option').forEach(opt => {
            opt.onclick = () => {
                mediaDurationOptions.querySelectorAll('.media-gen-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                mediaDurationHidden.value = opt.dataset.value;
                mediaDurationText.textContent = opt.textContent;
                mediaDurationOptions.classList.remove('show');
            };
        });
    }

    // Quantity Pill
    if (mediaQuantityTrigger) {
        mediaQuantityTrigger.onclick = (e) => {
            e.stopPropagation();
            mediaQuantityOptions.classList.toggle('show');
        };
        mediaQuantityOptions.querySelectorAll('.media-gen-option').forEach(opt => {
            opt.onclick = () => {
                mediaQuantityOptions.querySelectorAll('.media-gen-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                mediaQuantityHidden.value = opt.dataset.value;
                mediaQuantityText.textContent = opt.textContent;
                mediaQuantityOptions.classList.remove('show');
            };
        });
        // Close-on-click-outside
        document.addEventListener('click', (e) => {
            if (mediaQuantityDropdownWrapper && !mediaQuantityDropdownWrapper.contains(e.target)) {
                mediaQuantityOptions.classList.remove('show');
            }
        });
    }

    // Toggleables
    mediaAudioBtn.addEventListener('click', () => {
        const isActive = mediaAudioBtn.classList.toggle('active');
        mediaAudioHidden.value = isActive ? 'true' : 'false';
    });



    // Reference Image Upload Logic
    mediaRefTriggerBtn.addEventListener('click', () => {
        mediaRefInput.click();
    });

    mediaRefInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (re) => {
                mediaRefImgMini.src = re.target.result;
                mediaRefTriggerBtn.style.display = 'none';
                mediaRefPreviewMini.style.display = 'block';
            };
            reader.readAsDataURL(file);
        }
    });

    mediaRefClearBtn.addEventListener('click', () => {
        mediaRefInput.value = '';
        mediaRefImgMini.src = '';
        mediaRefPreviewMini.style.display = 'none';
        mediaRefTriggerBtn.style.display = 'flex';
    });

    mediaForm.addEventListener('submit', handleMediaGeneration);
    renderMediaHistory();
}

// Helper for generic custom selects
function setupCustomSelect(wrapperId, triggerId, textId, optionsId, inputId) {
    const wrapper = document.getElementById(wrapperId);
    const trigger = document.getElementById(triggerId);
    const text = document.getElementById(textId);
    const options = document.getElementById(optionsId);
    const input = document.getElementById(inputId);

    if (!wrapper) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close others
        document.querySelectorAll('.custom-select-wrapper.open').forEach(w => {
            if (w !== wrapper) w.classList.remove('open');
        });
        wrapper.classList.toggle('open');
    });

    options.addEventListener('click', (e) => {
        const option = e.target.closest('.custom-option');
        if (!option) return;

        input.value = option.getAttribute('data-value');
        text.textContent = option.textContent;

        options.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        wrapper.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            wrapper.classList.remove('open');
        }
    });
}

// Note: Media pill dropdowns (model, aspect, duration) are handled inside setupMediaUI() with the correct classes.
// Only keep setupCustomSelect for non-media custom selects that actually use .custom-select-wrapper.
setupCustomSelect('mediaResWrapper', 'mediaResTrigger', 'mediaResText', 'mediaResOptions', 'mediaResolution');
setupCustomSelect('mediaTotalDurationWrapper', 'mediaTotalDurationTrigger', 'mediaTotalDurationText', 'mediaTotalDurationOptions', 'mediaTotalDuration');

// ─── Initialize Media UI ─────────────────────────────
setupMediaUI();

var mediaTotalDurationGroup = document.getElementById('mediaTotalDurationGroup');

// ─── Scene data integration (scene management is in standalone script in index.html) ───

/** Get all scene data for generation — reads from window._sceneData (standalone script) */
function getScenePrompts() {
    // Always flush the current textarea value into the active scene's slot first
    const currentPrompt = (mediaPrompt.value || '').trim();
    if ((window._activeScene || 0) === 0) {
        window._scene0prompt = currentPrompt;
    } else {
        const idx = (window._activeScene || 0) - 1;
        if (window._sceneData && window._sceneData[idx]) {
            window._sceneData[idx].prompt = currentPrompt;
        }
    }

    const scene0prompt = (window._scene0prompt || '').trim();
    const scene0 = {
        prompt: scene0prompt,
        startImg: mediaRefImgMini?.src && (mediaRefImgMini.src.startsWith('http') || mediaRefImgMini.src.startsWith('data:')) ? mediaRefImgMini.src : null,
        endImg: null
    };

    if (!window._sceneData || window._sceneData.length === 0) return [scene0];

    return [scene0, ...window._sceneData.map(s => ({
        prompt: (s.prompt || '').trim(),
        startImg: s.startImg,
        endImg: s.endImg
    }))];
}




document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#mediaDownloadBtn');
    if (!btn || !lastMediaResultUrl) return;
    try {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        const resp = await fetch(lastMediaResultUrl);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = lastMediaIsVideo ? 'fal-video.mp4' : 'fal-image.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    } catch (err) {
        console.error('Download error:', err);
        window.open(lastMediaResultUrl, '_blank');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download`;
    }
});

// Close media viewer modal (exposed globally for inline onclick)
window.closeMediaViewer = function () {
    var m = document.getElementById('mediaViewerModal');
    var c = document.getElementById('mediaResultContent');
    if (m) m.style.display = 'none';
    if (c) c.innerHTML = '';
};

// Generate
async function handleMediaGeneration(e) {
    e.preventDefault();

    // Guard against double-submits launching parallel (costly) generations.
    if (mediaGenerateBtn && mediaGenerateBtn.disabled) return;

    const prompt = mediaPrompt.value.trim();
    if (!prompt) {
        showToast('Please enter a prompt', 'error');
        return;
    }

    const modelId = mediaModelHidden.value;
    let inferredMode = currentMediaBaseType; // 'image', 'video', 'audio'

    console.log('🔵 STEP 1: prompt="' + prompt.slice(0, 50) + '", mode=' + inferredMode + ', model=' + modelId);

    // Detect if a reference image is present and swap model to image-to-video
    const hasRefImage = (mediaRefInput.files && mediaRefInput.files[0]) ||
        (mediaRefImgMini.src && (mediaRefImgMini.src.startsWith('http') || mediaRefImgMini.src.startsWith('data:')));

    console.log('🔵 STEP 2: hasRefImage=' + hasRefImage + ', miniSrc=' + (mediaRefImgMini.src?.slice(0, 50) || 'none'));

    let finalModelId = modelId;
    if (hasRefImage && inferredMode === 'video') {
        // Swap text-to-video model for its image-to-video counterpart
        if (modelId.includes('text-to-video')) {
            finalModelId = modelId.replace('text-to-video', 'image-to-video');
            console.log(`📸 Image detected — switched model to: ${finalModelId}`);
        }
        // Also for image mode with ref image
    } else if (hasRefImage && inferredMode === 'image') {
        // Auto-switch Nano Banana text-to-image → /edit endpoint when ref image is present
        if (modelId.includes('nano-banana') && !modelId.includes('/edit')) {
            finalModelId = modelId + '/edit';
            console.log(`📸 Nano Banana + reference image — switched to edit endpoint: ${finalModelId}`);
        } else if (modelId.includes('text-to-image')) {
            // Check if there's an image-to-image variant for other models
            const i2iModel = modelId.replace('text-to-image', 'image-to-image');
            if (MEDIA_MODELS['image-to-image'] && MEDIA_MODELS['image-to-image'][i2iModel]) {
                finalModelId = i2iModel;
                console.log(`📸 Image detected — switched model to: ${finalModelId}`);
            }
        }
    }

    console.log('🔵 STEP 3: finalModel=' + finalModelId);

    // UI Loading state
    mediaGenerateBtn.disabled = true;
    mediaGenerateBtn.querySelector('.btn-text').style.display = 'none';
    mediaGenerateBtn.querySelector('.btn-loader').style.display = 'block';
    mediaProgressContainer.style.display = 'block';
    mediaProgressFill.style.width = '10%';
    // Show debug info in the UI
    const _dbg = `model=${finalModelId.split('/').pop()} | mode=${inferredMode} | img=${hasRefImage} | dur=${mediaDurationHidden?.value || '?'}`;
    mediaProgressText.textContent = _dbg;
    console.log('🔵 DEBUG:', _dbg);
    mediaResultContent.innerHTML = '';
    if (mediaResultContainer) mediaResultContainer.style.display = 'none';

    const isVideo = inferredMode === 'video';
    const isAudio = inferredMode === 'audio';

    // Form Data preparation
    const requestData = {
        model: finalModelId,
        prompt,
        mode: inferredMode,
        aspectRatio: mediaAspectHidden.value || '16:9',
    };
    console.log('🔵 STEP 4: requestData=', JSON.stringify(requestData).slice(0, 200));

    // If an image is selected, upload to Vercel Blob instead of base64
    if (mediaRefInput.files && mediaRefInput.files[0]) {
        mediaProgressText.textContent = 'Uploading high-res image to Blob store...';
        try {
            const file = mediaRefInput.files[0];
            const tokenRes = await fetch(`${API_BASE}/api/media/upload-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, contentType: file.type })
            });

            if (!tokenRes.ok) throw new Error('Failed to get secure upload token');

            const { clientToken, pathname } = await tokenRes.json();
            if (!clientToken) throw new Error('Server returned empty Blob token. Please verify Vercel Blob is connected.');

            mediaProgressText.textContent = 'Transferring file to cloud...';
            // Use the exact pathname the server embedded in the token to avoid mismatch errors.
            const blob = await put(pathname, file, {
                access: 'public',
                token: clientToken,
                multipart: true,
            });

            requestData.referenceImageUrl = blob.url;

            // Re-assign the miniature preview to the fast cloud URL and clear the file 
            // so we don't redundantly re-upload it if they click "Generate" again.
            mediaRefImgMini.src = blob.url;
            mediaRefInput.value = '';
        } catch (uploadErr) {
            console.error('Blob Upload Error:', uploadErr);
            showToast('Cloud upload failed: ' + uploadErr.message, 'error');
            resetMediaBtn();
            return;
        }
    } else if (mediaRefImgMini.src && mediaRefImgMini.src.startsWith('http')) {
        // Fallback or reusing already uploaded URL
        requestData.referenceImageUrl = mediaRefImgMini.src;
    } else if (mediaRefImgMini.src && mediaRefImgMini.src.startsWith('data:')) {
        // We shouldn't hit this normally if they just uploaded, but as a fallback
        requestData.referenceImageUrl = mediaRefImgMini.src;
    }


    if (isVideo || inferredMode === 'image-to-video' || inferredMode === 'text-to-video') {
        requestData.duration = mediaDurationHidden.value || '5';
        requestData.audio = mediaAudioHidden.value === 'true';
    }

    // Quantity — for image models use num_images, for video submit in parallel
    const quantity = parseInt(mediaQuantityHidden?.value || '1') || 1;
    if (!isVideo && quantity > 1) {
        requestData.num_images = quantity;
    }

    try {
        const scenePrompts = getScenePrompts();
        const isMultiScene = isVideo && scenePrompts.length > 1;

        console.log('🎬 Scene data:', JSON.stringify(scenePrompts.map((s, i) => ({
            scene: i,
            prompt: s.prompt?.slice(0, 50) || '(empty)',
            startImg: s.startImg ? s.startImg.slice(0, 40) + '...' : 'null',
            endImg: s.endImg ? 'yes' : 'null'
        })), null, 2));
        console.log('isVideo:', isVideo, 'isMultiScene:', isMultiScene);

        if (isMultiScene) {
            // ─── Multi-Scene Generation ─────────────────────────────
            // Validate all scenes have prompts
            const emptyScenes = scenePrompts
                .map((s, i) => ({ idx: i + 1, empty: !s.prompt }))
                .filter(s => s.empty);
            if (emptyScenes.length > 0) {
                showToast(`Scene ${emptyScenes.map(s => s.idx).join(', ')} missing prompt — add a prompt to every scene`, 'error');
                resetMediaBtn();
                return;
            }

            mediaProgressText.textContent = `Uploading scene images...`;
            console.log(`🎬 Multi-scene: ${scenePrompts.length} scenes`);

            // Pre-upload any data: URL images to Vercel Blob (avoid 4.5MB body limit)
            for (let i = 0; i < scenePrompts.length; i++) {
                const scene = scenePrompts[i];
                if (scene.startImg && scene.startImg.startsWith('data:')) {
                    try {
                        mediaProgressText.textContent = `Uploading scene ${i + 1} image...`;
                        // Convert data URL to File
                        const resp = await fetch(scene.startImg);
                        const blob = await resp.blob();
                        const file = new File([blob], `scene-${i + 1}.png`, { type: blob.type || 'image/png' });

                        const tokenRes = await fetch(`${API_BASE}/api/media/upload-token`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: file.name, contentType: file.type })
                        });
                        if (!tokenRes.ok) throw new Error('Failed to get upload token');
                        const { clientToken, pathname } = await tokenRes.json();
                        if (!clientToken) throw new Error('Empty Blob token');

                        const uploaded = await put(pathname, file, {
                            access: 'public',
                            token: clientToken,
                            multipart: true,
                        });
                        scene.startImg = uploaded.url;
                        console.log(`📸 Scene ${i + 1} image uploaded: ${uploaded.url.slice(0, 60)}...`);
                    } catch (uploadErr) {
                        console.error(`Scene ${i + 1} image upload failed:`, uploadErr);
                        showToast(`Scene ${i + 1} image upload failed: ${uploadErr.message}`, 'error');
                        resetMediaBtn();
                        return;
                    }
                }
            }

            mediaProgressText.textContent = `Submitting ${scenePrompts.length} scenes...`;

            // Submit all scenes in parallel
            const submissions = await Promise.all(scenePrompts.map(async (scene, idx) => {
                // Build per-scene request — strip inherited referenceImageUrl, use base model
                const sceneData = {
                    ...requestData,
                    prompt: scene.prompt,
                    model: modelId, // Use the ORIGINAL model (text-to-video), not pre-swapped
                };
                delete sceneData.referenceImageUrl; // Remove any inherited image from scene 0

                // If THIS scene has a start image, set it and swap to image-to-video
                if (scene.startImg) {
                    sceneData.referenceImageUrl = scene.startImg;
                    if (sceneData.model && sceneData.model.includes('text-to-video')) {
                        sceneData.model = sceneData.model.replace('text-to-video', 'image-to-video');
                    }
                }
                console.log(`📤 Scene ${idx + 1} submitting: model=${sceneData.model}, prompt="${sceneData.prompt?.slice(0, 40)}", img=${sceneData.referenceImageUrl?.slice(0, 50) || 'none'}`);
                const res = await fetch(`${API_BASE}/api/media/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(sceneData)
                });
                if (!res.ok) {
                    const errText = await res.text();
                    console.error(`❌ Scene ${idx + 1} submit error:`, errText.slice(0, 200));
                    throw new Error(`Scene ${idx + 1} failed: ${errText.slice(0, 100)}`);
                }
                const result = await res.json();
                console.log(`✅ Scene ${idx + 1} queued:`, result.requestId);
                return result;
            }));

            mediaProgressFill.style.width = '20%';
            mediaProgressText.textContent = `All ${scenePrompts.length} scenes queued — polling...`;

            // Track per-scene status for clear progress display
            const sceneStatuses = scenePrompts.map((_, i) => `S${i + 1}: ⏳`);
            function updateMultiSceneProgress() {
                mediaProgressText.textContent = sceneStatuses.join('  |  ');
            }

            // Poll all scenes in parallel — use allSettled so partial results survive
            const sceneVideoUrls = [];
            const results = await Promise.allSettled(submissions.map(async (data, idx) => {
                sceneStatuses[idx] = `S${idx + 1}: queued`;
                updateMultiSceneProgress();

                const url = await pollSceneStatus(data.statusUrl, data.responseUrl, idx, scenePrompts.length, (statusText) => {
                    sceneStatuses[idx] = `S${idx + 1}: ${statusText}`;
                    updateMultiSceneProgress();
                });
                sceneStatuses[idx] = `S${idx + 1}: ✅`;
                updateMultiSceneProgress();
                sceneVideoUrls[idx] = url;
                return url;
            }));

            // Check which scenes succeeded
            const failedScenes = results
                .map((r, i) => ({ idx: i, ...r }))
                .filter(r => r.status === 'rejected');
            const succeededUrls = sceneVideoUrls.filter(Boolean);

            if (succeededUrls.length === 0) {
                throw new Error(`All ${scenePrompts.length} scenes failed: ${failedScenes[0]?.reason?.message || 'unknown'}`);
            }

            if (failedScenes.length > 0) {
                showToast(`${failedScenes.length} scene(s) failed — opening editor with ${succeededUrls.length} completed`, 'error');
                console.warn('Failed scenes:', failedScenes.map(f => `Scene ${f.idx + 1}: ${f.reason?.message}`));
            }

            mediaProgressFill.style.width = '100%';
            mediaProgressText.textContent = `✅ ${succeededUrls.length}/${scenePrompts.length} scenes complete! Opening editor...`;
            showToast(`${succeededUrls.length} scenes ready — opening video editor`, 'success');

            // Open the video editor popup instead of auto-merging
            // Filter out null URLs from failed scenes
            const validUrls = sceneVideoUrls.filter(Boolean);
            const validLabels = scenePrompts
                .filter((_, i) => sceneVideoUrls[i])
                .map(s => s.prompt);
            openVideoEditor(
                validUrls,
                validLabels,
                (mergedUrl, clips) => {
                    if (!mergedUrl) {
                        // User cancelled — save clips individually
                        const historyEntry = {
                            url: sceneVideoUrls[0],
                            sceneUrls: sceneVideoUrls,
                            prompt: scenePrompts.map(s => s.prompt).join(' → '),
                            mode: 'video',
                            model: finalModelId,
                            date: new Date().toISOString(),
                            isMultiScene: true,
                            merged: false,
                        };
                        saveToMediaHistory(historyEntry);
                        renderMediaHistory();

                        // Show individual scenes in result area
                        lastMediaResultUrl = sceneVideoUrls[0];
                        lastMediaIsVideo = true;
                        window.lastMediaResultUrl = sceneVideoUrls[0];
                        window.lastMediaIsVideo = true;
                        mediaResultContent.innerHTML = sceneVideoUrls.map((url, i) =>
                            `<div style="margin-bottom:12px;">
                                <p style="margin:0 0 4px;font-size:13px;color:rgba(255,255,255,0.6);">Scene ${i + 1}</p>
                                <video src="${url}" controls ${i === 0 ? 'autoplay' : ''} style="width:100%;border-radius:12px;"></video>
                            </div>`
                        ).join('');
                        if (mediaResultContainer) mediaResultContainer.style.display = 'block';
                    }
                    resetMediaBtn();
                }
            );

            renderMediaHistory();
            return;
        }

        // ─── Single Scene (existing flow) ─────────────────────────────
        mediaProgressText.textContent = `Step 1: Sending to ${finalModelId}...`;
        console.log('📤 Request data:', JSON.stringify(requestData).slice(0, 500));

        const res = await fetch(`${API_BASE}/api/media/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });

        if (!res.ok) {
            let errText = await res.text();
            console.error('❌ Generate failed:', res.status, errText.slice(0, 300));
            if (res.status === 413) {
                throw new Error('Image is too large. Vercel allows max 4.5MB.');
            }
            try {
                const parsed = JSON.parse(errText);
                throw new Error(parsed.error || 'Server error');
            } catch (e) {
                throw new Error(`Server returned ${res.status}: ${errText.slice(0, 100)}`);
            }
        }

        const data = await res.json();
        if (!data.success && data.error) {
            throw new Error(data.error);
        }

        mediaProgressFill.style.width = '30%';
        mediaProgressText.textContent = `Step 2: Queued (${data.requestId?.slice(0, 8)}...) — polling...`;
        console.log('✅ Queued:', data.requestId, 'statusUrl:', data.statusUrl, 'responseUrl:', data.responseUrl);

        // Poll using Fal.ai's own URLs
        await pollMediaStatus(data.statusUrl, data.responseUrl, inferredMode);

    } catch (err) {
        console.error('Generation Error:', err);
        mediaProgressText.textContent = `❌ Error: ${err.message}`;
        showToast(err.message || 'Generation failed', 'error');
        setTimeout(() => resetMediaBtn(), 5000);
    }
}

// Generate
// ─── Helper: Poll Fal.ai status ──────────────────────────────
async function pollMediaStatus(statusUrl, responseUrl, inferredMode) {
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 8;

    for (let attempt = 0; attempt < 200; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        mediaProgressText.textContent = `Checking status (${attempt + 1})...`;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const statusRes = await fetch(`${API_BASE}/api/media/check-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ statusUrl }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!statusRes.ok || !statusRes.headers.get('content-type')?.includes('json')) {
                consecutiveErrors++;
                const errText = await statusRes.text().catch(() => 'no body');
                console.warn(`Poll ${attempt + 1}: HTTP ${statusRes.status} — ${errText.slice(0, 200)}`);
                mediaProgressText.textContent = `HTTP ${statusRes.status}: ${errText.slice(0, 60)} (retry ${consecutiveErrors})`;
                if (consecutiveErrors >= maxConsecutiveErrors) throw new Error(`HTTP ${statusRes.status}: ${errText.slice(0, 150)}`);
                continue;
            }

            const data = await statusRes.json();
            consecutiveErrors = 0;

            if (data.status === 'COMPLETED') {
                mediaProgressText.textContent = 'Fetching your video...';
                mediaProgressFill.style.width = '90%';

                const resultRes = await fetch(`${API_BASE}/api/media/fetch-result`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ responseUrl }),
                });
                if (!resultRes.ok) {
                    const errText = await resultRes.text().catch(() => '');
                    throw new Error(`Failed to fetch result: ${errText.slice(0, 100)}`);
                }
                const resultData = await resultRes.json();
                console.log('✅ Got result:', JSON.stringify(resultData.result).slice(0, 300));
                handleMediaSuccess(resultData.result, inferredMode);
                return;

            } else if (data.status === 'FAILED') {
                throw new Error(data.error || 'Generation failed on Fal.ai');

            } else {
                const label = data.status === 'IN_QUEUE' ? 'In queue' : 'Generating';
                mediaProgressText.textContent = `${label} (${attempt + 1})...`;
                mediaProgressFill.style.width = `${Math.min(85, 15 + attempt * 2)}%`;
            }

        } catch (pollErr) {
            if (pollErr.name === 'AbortError') {
                consecutiveErrors++;
                mediaProgressText.textContent = `Timeout, retrying (${consecutiveErrors})...`;
                if (consecutiveErrors >= maxConsecutiveErrors) throw new Error('Polling timed out repeatedly');
                continue;
            }
            // Show the ACTUAL error message so user can report it
            console.error(`Poll error: ${pollErr.message}`);
            mediaProgressText.textContent = `❌ ${pollErr.message.slice(0, 80)}`;
            // If it's a definitive error (not transient), throw immediately
            if (pollErr.message.includes('fetch result') || pollErr.message.includes('Generation failed')) {
                throw pollErr;
            }
            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) throw pollErr;
        }
    }
    throw new Error('Generation timed out after 6 minutes');
}

// Poll a single scene and return its video URL (for multi-scene)
async function pollSceneStatus(statusUrl, responseUrl, sceneIdx, totalScenes, onProgress) {
    let consecutiveErrors = 0;
    const updateProgress = (text) => {
        if (onProgress) onProgress(text);
        else mediaProgressText.textContent = `Scene ${sceneIdx + 1}/${totalScenes}: ${text}`;
    };

    for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const statusRes = await fetch(`${API_BASE}/api/media/check-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ statusUrl }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!statusRes.ok || !statusRes.headers.get('content-type')?.includes('json')) {
                consecutiveErrors++;
                updateProgress(`retry ${consecutiveErrors}`);
                if (consecutiveErrors >= 8) throw new Error(`Scene ${sceneIdx + 1} timed out`);
                continue;
            }

            const data = await statusRes.json();
            consecutiveErrors = 0;

            if (data.status === 'COMPLETED') {
                updateProgress('fetching...');
                const resultRes = await fetch(`${API_BASE}/api/media/fetch-result`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ responseUrl }),
                });
                if (!resultRes.ok) throw new Error(`Scene ${sceneIdx + 1} fetch failed`);
                const resultData = await resultRes.json();
                const result = resultData.result;
                // Extract video URL
                const url = result.video?.url || result.video_url || result.url
                    || result.output?.video?.url || result.output?.url || result.data?.video?.url || result.data?.url
                    || (Array.isArray(result.videos) && result.videos[0]?.url)
                    || (Array.isArray(result.output) && result.output[0]?.url);
                if (!url) throw new Error(`Scene ${sceneIdx + 1}: no URL in result`);
                console.log(`✅ Scene ${sceneIdx + 1}/${totalScenes} complete: ${url.slice(0, 80)}`);
                return url;
            } else if (data.status === 'FAILED') {
                throw new Error(`Scene ${sceneIdx + 1} failed: ${data.error || 'unknown'}`);
            } else {
                const label = data.status === 'IN_QUEUE'
                    ? (data.queue_position ? `queue #${data.queue_position}` : 'queued')
                    : `gen ${attempt + 1}`;
                updateProgress(label);
            }
        } catch (pollErr) {
            if (pollErr.name === 'AbortError') {
                consecutiveErrors++;
                updateProgress(`timeout ${consecutiveErrors}`);
                if (consecutiveErrors >= 8) throw new Error(`Scene ${sceneIdx + 1} timed out`);
                continue;
            }
            if (pollErr.message.includes('fetch failed') || pollErr.message.includes('no URL') || pollErr.message.includes('failed:')) throw pollErr;
            consecutiveErrors++;
            if (consecutiveErrors >= 8) throw pollErr;
        }
    }
    throw new Error(`Scene ${sceneIdx + 1} timed out after 6 minutes`);
}

// Save a single entry to media history
function saveToMediaHistory(entry) {
    const history = JSON.parse(localStorage.getItem('orbit_media_history') || '[]');
    history.unshift(entry);
    if (history.length > 50) history.length = 50;
    localStorage.setItem('orbit_media_history', JSON.stringify(history));
}

function handleMediaSuccess(result, mode) {
    const isVideo = mode.includes('video');

    // Log full result to help debug
    console.log('Media result:', JSON.stringify(result).slice(0, 500));

    // Collect all URLs
    let urls = [];
    if (isVideo) {
        const url = result.video?.url
            || result.video_url
            || result.url
            || result.output?.video?.url
            || result.output?.url
            || result.data?.video?.url
            || result.data?.url
            || (Array.isArray(result.videos) && result.videos[0]?.url)
            || (Array.isArray(result.output) && result.output[0]?.url);
        if (url) urls.push(url);
    } else {
        // Multiple images
        if (Array.isArray(result.images) && result.images.length > 0) {
            urls = result.images.map(img => img.url).filter(Boolean);
        } else {
            const url = result.image?.url
                || result.url
                || result.output?.url
                || (Array.isArray(result.output) && result.output[0]?.url);
            if (url) urls.push(url);
        }
    }

    if (urls.length === 0) {
        console.error('No URL found in result:', result);
        showToast('Generation succeeded but no URL was found in result. Check console.', 'error');
        resetMediaBtn();
        return;
    }

    // Set globals for Download button (first URL)
    lastMediaResultUrl = urls[0];
    lastMediaIsVideo = isVideo;

    // Show Done! on the progress bar for 2 seconds, then hide
    mediaProgressFill.style.width = '100%';
    mediaProgressText.textContent = '✅ Done!';
    showToast(`Generation complete! ${urls.length > 1 ? urls.length + ' images' : ''}`, 'success');

    setTimeout(() => {
        resetMediaBtn();
    }, 2000);

    // Save to history (save all URLs)
    const history = JSON.parse(localStorage.getItem('orbit_media_history') || '[]');
    urls.forEach(url => {
        history.unshift({ url, prompt: mediaPrompt.value.slice(0, 60), mode, ts: Date.now() });
    });
    if (history.length > 50) history.length = 50;
    localStorage.setItem('orbit_media_history', JSON.stringify(history));
    renderMediaHistory();
}

function resetMediaBtn() {
    mediaGenerateBtn.disabled = false;
    mediaGenerateBtn.querySelector('.btn-text').style.display = 'block';
    mediaGenerateBtn.querySelector('.btn-loader').style.display = 'none';
    mediaProgressContainer.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════
// ─── VIDEO EDITOR ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

let veClips = []; // { url, duration, trimStart, trimEnd, label }
let veActiveClipIdx = -1;
let veScenePrompts = [];
let veOnComplete = null; // callback(mergedBlobUrl, clips)

window.closeVideoEditor = function () {
    const modal = document.getElementById('videoEditorModal');
    if (modal) modal.style.display = 'none';
    const player = document.getElementById('vePreviewPlayer');
    if (player) { player.pause(); player.removeAttribute('src'); }
};

function openVideoEditor(sceneUrls, sceneLabels, onComplete) {
    veClips = [];
    veActiveClipIdx = -1;
    veScenePrompts = sceneLabels || [];
    veOnComplete = onComplete || null;

    const modal = document.getElementById('videoEditorModal');
    const tracks = document.getElementById('veTracks');
    const player = document.getElementById('vePreviewPlayer');
    const emptyMsg = document.getElementById('vePreviewEmpty');
    const status = document.getElementById('veStatus');

    if (!modal || !tracks) return;

    modal.style.display = '';
    tracks.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:0.8rem;padding:12px;">Loading clips...</div>';
    if (emptyMsg) emptyMsg.style.display = '';
    if (player) { player.style.display = 'none'; player.removeAttribute('src'); }
    if (status) status.textContent = '';

    // Load all clip metadata
    let loaded = 0;
    sceneUrls.forEach((url, i) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.crossOrigin = 'anonymous';
        v.src = url;
        v.onloadedmetadata = () => {
            veClips[i] = {
                url,
                duration: v.duration || 5,
                trimStart: 0,
                trimEnd: v.duration || 5,
                label: veScenePrompts[i] || `Clip ${i + 1}`,
            };
            loaded++;
            if (loaded === sceneUrls.length) {
                renderTimeline();
                selectClip(0);
            }
        };
        v.onerror = () => {
            veClips[i] = { url, duration: 5, trimStart: 0, trimEnd: 5, label: veScenePrompts[i] || `Clip ${i + 1}` };
            loaded++;
            if (loaded === sceneUrls.length) {
                renderTimeline();
                selectClip(0);
            }
        };
    });

    // Wire up buttons
    document.getElementById('vePlayAllBtn').onclick = playAll;
    document.getElementById('veMergeBtn').onclick = mergeAndSave;
    document.getElementById('veCancelBtn').onclick = () => {
        window.closeVideoEditor();
        if (veOnComplete) veOnComplete(null, veClips);
    };
}

function renderTimeline() {
    const tracks = document.getElementById('veTracks');
    const ruler = document.getElementById('veRuler');
    const totalDurEl = document.getElementById('veTotalDur');
    if (!tracks) return;

    const totalDur = veClips.reduce((s, c) => s + (c.trimEnd - c.trimStart), 0);
    if (totalDurEl) totalDurEl.textContent = totalDur.toFixed(1) + 's';

    // Render time ruler
    if (ruler) {
        ruler.innerHTML = '';
        const step = totalDur <= 10 ? 1 : totalDur <= 30 ? 2 : totalDur <= 60 ? 5 : 10;
        for (let t = 0; t <= totalDur; t += step) {
            const pct = totalDur > 0 ? (t / totalDur) * 100 : 0;
            const tick = document.createElement('div');
            tick.className = 've-ruler-tick';
            tick.style.left = pct + '%';
            tick.textContent = t.toFixed(0) + 's';
            ruler.appendChild(tick);
        }
    }

    // Build track row with clips
    let html = '<div class="ve-track-row">';
    veClips.forEach((clip, i) => {
        const trimmedDur = clip.trimEnd - clip.trimStart;
        const pct = totalDur > 0 ? (trimmedDur / totalDur) * 100 : 100 / veClips.length;
        const activeClass = i === veActiveClipIdx ? ' active' : '';
        const durStr = trimmedDur.toFixed(1) + 's';

        html += `<div class="ve-track-clip${activeClass}" data-idx="${i}" 
                      draggable="true" style="width:${pct}%;flex:none;">
            <div class="ve-clip-trim-left" data-idx="${i}" data-side="start"></div>
            <div class="ve-clip-info">
                <div class="ve-clip-name">${clip.label}</div>
                <div class="ve-clip-time">${durStr} / ${clip.duration.toFixed(1)}s</div>
            </div>
            <div class="ve-clip-trim-right" data-idx="${i}" data-side="end"></div>
        </div>`;
    });
    html += '</div>';
    tracks.innerHTML = html;

    // Click to select clip
    tracks.querySelectorAll('.ve-track-clip').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('ve-clip-trim-left') || e.target.classList.contains('ve-clip-trim-right')) return;
            selectClip(parseInt(el.dataset.idx));
        });
    });

    // Drag & Drop to reorder
    let dragIdx = -1;
    tracks.querySelectorAll('.ve-track-clip').forEach(el => {
        el.addEventListener('dragstart', (e) => {
            dragIdx = parseInt(el.dataset.idx);
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            dragIdx = -1;
            // Remove any drop markers
            tracks.querySelectorAll('.ve-drop-marker').forEach(m => m.remove());
        });
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            const dropIdx = parseInt(el.dataset.idx);
            if (dragIdx >= 0 && dragIdx !== dropIdx) {
                // Reorder clips
                const [moved] = veClips.splice(dragIdx, 1);
                veClips.splice(dropIdx, 0, moved);
                veActiveClipIdx = dropIdx;
                renderTimeline();
                selectClip(dropIdx);
            }
        });
    });

    // Trim handles (drag on edges)
    tracks.querySelectorAll('.ve-clip-trim-left, .ve-clip-trim-right').forEach(handle => {
        let startX = 0;
        let startVal = 0;
        const idx = parseInt(handle.dataset.idx);
        const side = handle.dataset.side;
        const clip = veClips[idx];
        if (!clip) return;

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const sensitivity = clip.duration / 200; // px to seconds
            const newVal = startVal + dx * sensitivity;
            if (side === 'start') {
                clip.trimStart = Math.max(0, Math.min(newVal, clip.trimEnd - 0.2));
            } else {
                clip.trimEnd = Math.min(clip.duration, Math.max(newVal, clip.trimStart + 0.2));
            }
            renderTimeline();
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            startX = e.clientX;
            startVal = side === 'start' ? clip.trimStart : clip.trimEnd;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

function selectClip(idx) {
    if (idx < 0 || idx >= veClips.length) return;
    veActiveClipIdx = idx;
    const clip = veClips[idx];
    const player = document.getElementById('vePreviewPlayer');
    const emptyMsg = document.getElementById('vePreviewEmpty');
    const status = document.getElementById('veStatus');
    const playhead = document.getElementById('vePlayhead');

    if (player) {
        player.style.display = '';
        player.src = clip.url;
        player.currentTime = clip.trimStart;
        player.play().catch(() => { });

        // Calculate playhead base position (time before this clip)
        const totalDur = veClips.reduce((s, c) => s + (c.trimEnd - c.trimStart), 0);
        const timeBefore = veClips.slice(0, idx).reduce((s, c) => s + (c.trimEnd - c.trimStart), 0);

        // Enforce trim end + move playhead
        const onTime = () => {
            if (player.currentTime >= clip.trimEnd) {
                player.pause();
                player.currentTime = clip.trimStart;
            }
            // Update playhead position
            if (playhead && totalDur > 0) {
                const clipProgress = (player.currentTime - clip.trimStart) / (clip.trimEnd - clip.trimStart);
                const clipDur = clip.trimEnd - clip.trimStart;
                const globalTime = timeBefore + clipProgress * clipDur;
                const pct = (globalTime / totalDur) * 100;
                playhead.style.left = Math.min(100, Math.max(0, pct)) + '%';
            }
        };
        player.removeEventListener('timeupdate', player._veTrimHandler);
        player._veTrimHandler = onTime;
        player.addEventListener('timeupdate', onTime);
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    if (status) status.textContent = `Clip ${idx + 1} — ${clip.label}`;

    // Update active class on track clips
    const tracks = document.getElementById('veTracks');
    if (tracks) {
        tracks.querySelectorAll('.ve-track-clip').forEach(el => {
            if (parseInt(el.dataset.idx) === idx) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }
}

async function playAll() {
    const player = document.getElementById('vePreviewPlayer');
    const status = document.getElementById('veStatus');
    if (!player) return;

    for (let i = 0; i < veClips.length; i++) {
        const clip = veClips[i];
        selectClip(i);
        player.currentTime = clip.trimStart;

        if (status) status.textContent = `Playing Scene ${i + 1} of ${veClips.length}...`;
        player.play().catch(() => { });

        // Wait for clip to finish its trimmed range
        await new Promise(resolve => {
            const check = () => {
                if (player.currentTime >= clip.trimEnd - 0.05 || player.paused) {
                    player.removeEventListener('timeupdate', check);
                    resolve();
                }
            };
            player.addEventListener('timeupdate', check);
            // Safety timeout
            setTimeout(resolve, (clip.trimEnd - clip.trimStart + 1) * 1000);
        });
        player.pause();
    }
    if (status) status.textContent = '✅ Playback complete';
}

async function mergeAndSave() {
    const mergeBtn = document.getElementById('veMergeBtn');
    const status = document.getElementById('veStatus');
    const canvas = document.getElementById('veMergeCanvas');
    const player = document.getElementById('vePreviewPlayer');

    if (!canvas || !player) return;

    // Disable button
    if (mergeBtn) {
        mergeBtn.disabled = true;
        mergeBtn.querySelector('.ve-btn-text').style.display = 'none';
        mergeBtn.querySelector('.ve-btn-loader').style.display = 'inline';
    }

    try {
        // Determine canvas size from first clip
        const probeVid = document.createElement('video');
        probeVid.muted = true;
        probeVid.src = veClips[0].url;
        await new Promise((res, rej) => { probeVid.onloadedmetadata = res; probeVid.onerror = rej; });
        const W = probeVid.videoWidth || 1280;
        const H = probeVid.videoHeight || 720;
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Set up MediaRecorder
        const stream = canvas.captureStream(30);
        const recorder = new MediaRecorder(stream, {
            mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
                : MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8'
                    : 'video/webm',
            videoBitsPerSecond: 5_000_000,
        });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        recorder.start(100); // collect data every 100ms

        // Process each clip
        for (let i = 0; i < veClips.length; i++) {
            const clip = veClips[i];
            if (status) status.textContent = `Merging scene ${i + 1} of ${veClips.length}...`;

            // Load clip into a video element
            const vid = document.createElement('video');
            vid.muted = true;
            vid.playsInline = true;
            vid.src = clip.url;
            await new Promise((res) => { vid.oncanplaythrough = res; vid.load(); });
            vid.currentTime = clip.trimStart;
            await new Promise((res) => { vid.onseeked = res; });

            vid.play();

            // Draw frames to canvas
            await new Promise((resolve) => {
                const drawFrame = () => {
                    if (vid.currentTime >= clip.trimEnd || vid.ended) {
                        vid.pause();
                        resolve();
                        return;
                    }
                    ctx.drawImage(vid, 0, 0, W, H);
                    requestAnimationFrame(drawFrame);
                };
                drawFrame();
                // Safety timeout
                const maxMs = (clip.trimEnd - clip.trimStart + 2) * 1000;
                setTimeout(() => { vid.pause(); resolve(); }, maxMs);
            });
        }

        // Stop recording
        recorder.stop();
        await new Promise(res => { recorder.onstop = res; });

        const blob = new Blob(chunks, { type: recorder.mimeType });
        const mergedUrl = URL.createObjectURL(blob);

        if (status) status.textContent = '✅ Merge complete!';

        // Show merged video in preview
        player.src = mergedUrl;
        player.removeEventListener('timeupdate', player._veTrimHandler);
        player.play().catch(() => { });

        // Save to history
        const historyEntry = {
            url: mergedUrl,
            blobUrl: mergedUrl,
            sceneUrls: veClips.map(c => c.url),
            prompt: veClips.map((c, i) => `Scene ${i + 1}`).join(' → '),
            mode: 'video',
            model: 'merged',
            date: new Date().toISOString(),
            isMultiScene: true,
            merged: true,
        };

        // Also set global state
        lastMediaResultUrl = mergedUrl;
        lastMediaIsVideo = true;
        window.lastMediaResultUrl = mergedUrl;
        window.lastMediaIsVideo = true;

        saveToMediaHistory(historyEntry);
        renderMediaHistory();

        showToast('Video merged and saved!', 'success');

        if (veOnComplete) veOnComplete(mergedUrl, veClips);

        // Close editor after a short delay
        setTimeout(() => window.closeVideoEditor(), 1500);

    } catch (err) {
        console.error('Merge error:', err);
        if (status) status.textContent = `❌ Merge failed: ${err.message}`;
        showToast('Video merge failed', 'error');
    } finally {
        if (mergeBtn) {
            mergeBtn.disabled = false;
            mergeBtn.querySelector('.ve-btn-text').style.display = '';
            mergeBtn.querySelector('.ve-btn-loader').style.display = 'none';
        }
    }
}

function renderMediaHistory() {
    try {
        // Look up DOM elements directly (hoisted vars may be undefined during early page restore)
        var grid = document.getElementById('mediaHistoryGrid');
        var empty = document.getElementById('mediaHistoryEmpty');
        var modal = document.getElementById('mediaViewerModal');
        var content = document.getElementById('mediaResultContent');
        var selectToggleBtn = document.getElementById('mediaSelectToggleBtn');
        if (!grid) { console.warn('mediaHistoryGrid not found'); return; }
        const history = JSON.parse(localStorage.getItem('orbit_media_history') || '[]');
        if (history.length === 0) {
            if (empty) empty.style.display = '';
            grid.style.display = 'none';
            if (selectToggleBtn) selectToggleBtn.style.display = 'none';
            return;
        }
        if (empty) empty.style.display = 'none';
        grid.style.display = 'grid';
        // Show Select button when there are items
        if (selectToggleBtn) selectToggleBtn.style.display = '';

        const checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

        grid.innerHTML = history.map((item, idx) => {
            const isVid = item.mode?.includes('video');
            const media = isVid
                ? `<video src="${item.url}" muted></video><div class="video-play-badge">▶</div>`
                : `<img src="${item.url}" alt="${item.prompt}" />`;
            return `<div class="media-history-item${isVid ? ' is-video' : ''}" data-idx="${idx}" data-url="${item.url}" data-mode="${item.mode || ''}">
                <div class="media-select-checkbox">${checkSvg}</div>
                ${media}
                <div class="media-history-label">${item.prompt}</div>
            </div>`;
        }).join('');

        // Click handler: open modal popup (or toggle selection in selection mode)
        grid.querySelectorAll('.media-history-item').forEach(el => {
            el.addEventListener('click', () => {
                // Selection mode: toggle selected
                if (window._mediaSelectionMode) {
                    el.classList.toggle('selected');
                    if (window.updateSelectionCount) window.updateSelectionCount();
                    return;
                }

                // Normal mode: open viewer
                const idx = parseInt(el.dataset.idx);
                const item = history[idx];
                if (!item) return;
                const isVid = item.mode?.includes('video');

                // Fill modal content
                if (content) {
                    if (isVid) {
                        content.innerHTML = `<div style="position:relative; width:100%; aspect-ratio:16/9; background:#000;"><video src="${item.url}" controls loop playsinline style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:contain;"></video></div>`;
                    } else {
                        content.innerHTML = `<img src="${item.url}" style="width:100%; display:block; object-fit:contain;" />`;
                    }
                }

                // Set download globals (exposed on window for standalone script)
                lastMediaResultUrl = item.url;
                lastMediaIsVideo = isVid;
                window.lastMediaResultUrl = item.url;
                window.lastMediaIsVideo = isVid;

                // Show modal
                if (modal) modal.style.display = '';

                // Show/hide Create Video button (only for images)
                var cvBtn = document.getElementById('mediaCreateVideoBtn');
                if (cvBtn) cvBtn.style.display = isVid ? 'none' : 'inline-flex';
            });
        });
    } catch (err) {
        console.error('renderMediaHistory error:', err);
    }
}
renderMediaHistory();

// Expose functions on window IMMEDIATELY for inline scripts
window.renderMediaHistory = renderMediaHistory;
window.saveToMediaHistory = saveToMediaHistory;
window.openVideoEditor = openVideoEditor;
window.showToast = showToast;

// Define editSelectedMedia here so it can call openVideoEditor directly
window.editSelectedMedia = function () {
    console.log('[editSelectedMedia] called');
    var grid = document.getElementById('mediaHistoryGrid');
    if (!grid) { console.log('[editSelectedMedia] no grid'); return; }

    var selected = grid.querySelectorAll('.media-history-item.selected');
    var urls = [];
    var labels = [];
    for (var i = 0; i < selected.length; i++) {
        var mode = selected[i].getAttribute('data-mode') || '';
        if (mode.indexOf('video') !== -1) {
            urls.push(selected[i].getAttribute('data-url'));
            labels.push('Clip ' + (urls.length));
        }
    }
    console.log('[editSelectedMedia] urls:', urls.length);

    if (urls.length === 0) {
        showToast('Select at least one video to edit', 'error');
        return;
    }

    // Exit selection mode
    if (window.toggleMediaSelectionMode) window.toggleMediaSelectionMode(true);

    // Open editor directly (not via window)
    openVideoEditor(urls, labels, function (mergedUrl) {
        if (mergedUrl) {
            saveToMediaHistory({
                url: mergedUrl, blobUrl: mergedUrl,
                prompt: labels.join(' → '), mode: 'video',
                model: 'merged', date: new Date().toISOString(),
                isMultiScene: true, merged: true,
            });
            renderMediaHistory();
            showToast('Merged video saved!', 'success');
        }
    });
};

// ═══════════════════════════════════════════════════════════════════
// ─── REDDIT AGENTS ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

const redditCreateAgentBtn = document.getElementById('redditCreateAgentBtn');
const redditCancelAgentBtn = document.getElementById('redditCancelAgentBtn');
const redditAgentForm = document.getElementById('redditAgentForm');
const redditAgentList = document.getElementById('redditAgentList');
const redditNoAgents = document.getElementById('redditNoAgents');
const redditActivityLog = document.getElementById('redditActivityLog');
const redditNoActivity = document.getElementById('redditNoActivity');
const redditManualScanBtn = document.getElementById('redditManualScanBtn');

// Stats Elements
const redditStatScanned = document.getElementById('redditStatScanned');
const redditStatPosted = document.getElementById('redditStatPosted');
const redditStatReplies = document.getElementById('redditStatReplies');
const redditStatEngagement = document.getElementById('redditStatEngagement');

// State
function safeParseLS(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
}
let redditAgents = safeParseLS('orbit_reddit_agents', []);
let redditActivity = safeParseLS('orbit_reddit_activity', []);

// Toggle Form
if (redditCreateAgentBtn) {
    redditCreateAgentBtn.addEventListener('click', () => {
        redditAgentForm.style.display = 'block';
        redditNoAgents.style.display = 'none';
        redditAgentForm.scrollIntoView({ behavior: 'smooth' });
    });
}
if (redditCancelAgentBtn) {
    redditCancelAgentBtn.addEventListener('click', () => {
        redditAgentForm.style.display = 'none';
        if (redditAgents.length === 0) redditNoAgents.style.display = 'flex';
        redditAgentForm.reset();
    });
}

// Create Agent
if (redditAgentForm) {
    redditAgentForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const newAgent = {
            id: Date.now().toString(),
            name: document.getElementById('redditAgentName').value,
            subreddits: document.getElementById('redditAgentSubreddits').value.split(',').map(s => s.trim()),
            keywords: document.getElementById('redditAgentKeywords').value.split(',').map(s => s.trim()),
            pitch: document.getElementById('redditAgentPitch').value,
            status: 'active',
            created: Date.now()
        };

        redditAgents.push(newAgent);
        localStorage.setItem('orbit_reddit_agents', JSON.stringify(redditAgents));

        redditAgentForm.reset();
        redditAgentForm.style.display = 'none';
        showToast('Reddit Agent created & active!');
        renderRedditAgents();
    });
}

function deleteRedditAgent(id) {
    if (confirm('Are you sure you want to delete this agent?')) {
        redditAgents = redditAgents.filter(a => a.id !== id);
        localStorage.setItem('orbit_reddit_agents', JSON.stringify(redditAgents));
        renderRedditAgents();
        showToast('Agent deleted');
    }
}

// Render Agents
function renderRedditAgents() {
    if (!redditAgentList) return;

    if (redditAgents.length === 0) {
        redditAgentList.innerHTML = '';
        redditNoAgents.style.display = 'flex';
        return;
    }

    redditNoAgents.style.display = 'none';
    redditAgentList.innerHTML = redditAgents.map(agent => {
        const isAuth = !!agent.redditUsername;
        const authBadge = isAuth
            ? `<span style="font-size:0.7rem; color:#10b981; margin-left:8px;">● connected (u/${agent.redditUsername})</span>`
            : `<span style="font-size:0.7rem; color:#f59e0b; margin-left:8px;">● pending auth</span>`;

        return `
        <div class="reddit-agent-item" data-id="${agent.id}">
            <div class="reddit-agent-info">
                <h4>${agent.name} ${authBadge}</h4>
                <p>Monitoring ${agent.subreddits.length} subs for ${agent.keywords.length} keywords</p>
                <div class="reddit-agent-tags">
                    ${agent.subreddits.slice(0, 3).map(sub => `<span class="reddit-agent-tag">r/${sub}</span>`).join('')}
                    ${agent.subreddits.length > 3 ? `<span class="reddit-agent-tag">+${agent.subreddits.length - 3}</span>` : ''}
                </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
                ${!isAuth ? `<button class="btn-primary btn-sm" onclick="connectRedditAuth('${agent.id}')" style="padding:4px 12px; font-size:0.8rem;">Connect to Reddit</button>` : ''}
                <button class="btn-small-outline" onclick="deleteRedditAgent('${agent.id}')" style="color:#ef4444; border-color: rgba(239,68,68,0.3);">Stop & Delete</button>
            </div>
        </div>
        `;
    }).join('');

    // Attach functions to global scope for onclick handlers
    window.deleteRedditAgent = deleteRedditAgent;
    window.connectRedditAuth = connectRedditAuth;
}

// ─── Reddit OAuth Flow ──────────────────────────────────────────
function connectRedditAuth(agentId) {
    const width = 600;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;

    // Open the auth popup
    window.open(
        `/api/reddit/auth?agentId=${agentId}`,
        'RedditAuth',
        `width=${width},height=${height},top=${top},left=${left}`
    );
}

// Listen for messages from the OAuth popup
window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (data && data.type === 'REDDIT_AUTH_SUCCESS') {
        const { agentId, username } = data;

        // Update the agent locally
        const agentIndex = redditAgents.findIndex(a => a.id === agentId);
        if (agentIndex !== -1) {
            redditAgents[agentIndex].redditUsername = username;
            localStorage.setItem('orbit_reddit_agents', JSON.stringify(redditAgents));
            renderRedditAgents();
            showToast(`Successfully linked u/${username} to agent!`);
        }
    }
});

// Render Activity Log
function renderRedditActivity() {
    if (!redditActivityLog) return;

    if (redditActivity.length === 0) {
        redditActivityLog.innerHTML = '';
        redditNoActivity.style.display = 'flex';
        updateRedditStats();
        return;
    }

    redditNoActivity.style.display = 'none';
    redditActivityLog.innerHTML = redditActivity.map(log => `
        <div class="reddit-timeline-item">
            <div class="reddit-timeline-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/><path d="M8 11V15"/><path d="M16 11V15"/><path d="M12 11V15"/></svg>
            </div>
            <div class="reddit-timeline-content">
                <div class="reddit-timeline-header">
                    <span class="reddit-timeline-agent">${log.agentName}</span>
                    <span class="reddit-timeline-time">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div class="reddit-timeline-post">
                    <strong>r/${log.subreddit}</strong>: Found matching post containing "${log.keywordMatched}"
                </div>
                <div class="reddit-timeline-reply">
                    "<em>${log.replyContent}</em>"
                </div>
            </div>
        </div>
    `).join('');

    updateRedditStats();
}

function updateRedditStats() {
    const totalPosted = redditActivity.length;
    if (redditStatScanned) redditStatScanned.textContent = (totalPosted * 142).toLocaleString(); // Mock
    if (redditStatPosted) redditStatPosted.textContent = totalPosted.toLocaleString();
    if (redditStatReplies) redditStatReplies.textContent = Math.floor(totalPosted * 1.3).toLocaleString(); // Mock
    if (redditStatEngagement) redditStatEngagement.textContent = Math.floor(totalPosted * 14.5).toLocaleString(); // Mock
}

// Manual Scan Simulation
if (redditManualScanBtn) {
    redditManualScanBtn.addEventListener('click', async () => {
        if (redditAgents.length === 0) {
            showToast('Create an agent first!', 'error');
            return;
        }

        const originalText = redditManualScanBtn.innerHTML;
        redditManualScanBtn.innerHTML = '<span class="spinner" style="border-width:2px; height:12px; width:12px;"></span> Scanning Reddit...';
        redditManualScanBtn.disabled = true;

        // Simulate network/AI delay
        await new Promise(r => setTimeout(r, 2000));

        // Pick a random agent to log activity for
        const agent = redditAgents[Math.floor(Math.random() * redditAgents.length)];
        const sub = agent.subreddits[0] || 'entrepreneur';
        const keyword = agent.keywords[0] || 'software';

        const newLog = {
            id: Date.now().toString(),
            agentName: agent.name,
            subreddit: sub,
            keywordMatched: keyword,
            timestamp: Date.now(),
            replyContent: `If you're struggling with ${keyword}, I highly recommend checking out Celeritech. We use their tools for exactly this and it streamlined our entire workflow.`
        };

        // Append to start
        redditActivity.unshift(newLog);
        if (redditActivity.length > 30) redditActivity.pop();
        localStorage.setItem('orbit_reddit_activity', JSON.stringify(redditActivity));

        renderRedditActivity();
        showToast('Scan complete. 1 new opportunity found and posted.');

        redditManualScanBtn.innerHTML = originalText;
        redditManualScanBtn.disabled = false;
    });
}

// ═══════════════════════════════════════════════════════════════════
// ─── POST SCHEDULER ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

let schedulerInitialized = false;
let schedCalYear, schedCalMonth;

const PLATFORM_META = {
    facebook:  { name: 'Facebook',  charLimit: null,  color: '#1877f2', iconClass: 'sched-plat-facebook' },
    instagram: { name: 'Instagram', charLimit: 2200,  color: '#e1306c', iconClass: 'sched-plat-instagram' },
    youtube:   { name: 'YouTube',   charLimit: 5000,  color: '#ff0000', iconClass: 'sched-plat-youtube' },
    x:         { name: 'X',         charLimit: 280,   color: '#1d9bf0', iconClass: 'sched-plat-x' },
    linkedin:  { name: 'LinkedIn',  charLimit: 3000,  color: '#0a66c2', iconClass: 'sched-plat-linkedin' },
};

// localStorage helpers
function getScheduledPosts() {
    try { return JSON.parse(localStorage.getItem('orbit_scheduled_posts') || '[]'); } catch { return []; }
}
function saveScheduledPosts(posts) {
    localStorage.setItem('orbit_scheduled_posts', JSON.stringify(posts));
}

function initScheduler() {
    if (schedulerInitialized) {
        renderSchedulerQueue();
        renderAccountsStatus();
        return;
    }
    schedulerInitialized = true;

    // ─── Sub-tab navigation ──────────────────────────────────────
    const schedTabs = document.querySelectorAll('.sched-tab');
    const schedViews = {
        accounts: document.getElementById('schedAccounts'),
        compose: document.getElementById('schedCompose'),
        calendar: document.getElementById('schedCalendar'),
        analytics: document.getElementById('schedAnalytics'),
    };

    schedTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            schedTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const view = tab.dataset.schedView;
            Object.values(schedViews).forEach(v => v.style.display = 'none');
            schedViews[view].style.display = '';
            if (view === 'accounts') renderAccountsStatus();
            if (view === 'calendar') renderCalendar();
            if (view === 'analytics') renderSchedulerAnalytics();
        });
    });

    // ─── Apply to All toggle ─────────────────────────────────────
    const applyAllToggle = document.getElementById('schedApplyAll');
    const applyHint = document.getElementById('schedApplyHint');
    const sharedCompose = document.getElementById('schedSharedCompose');
    const individualCompose = document.getElementById('schedIndividualCompose');

    applyAllToggle.addEventListener('change', () => {
        if (applyAllToggle.checked) {
            sharedCompose.style.display = '';
            individualCompose.style.display = 'none';
            applyHint.textContent = 'One post for all platforms';
        } else {
            sharedCompose.style.display = 'none';
            individualCompose.style.display = '';
            applyHint.textContent = 'Customize each platform';
            renderIndividualCards();
        }
    });

    // ─── Character count ─────────────────────────────────────────
    const schedContent = document.getElementById('schedContent');
    const schedCharCount = document.getElementById('schedCharCount');
    schedContent.addEventListener('input', () => {
        schedCharCount.textContent = `${schedContent.value.length} characters`;
    });

    // ─── Media upload ────────────────────────────────────────────
    const schedMediaArea = document.getElementById('schedMediaUploadArea');
    const schedMediaInput = document.getElementById('schedMediaInput');
    const schedMediaPreview = document.getElementById('schedMediaPreviewGrid');

    schedMediaArea.addEventListener('click', () => schedMediaInput.click());
    schedMediaInput.addEventListener('change', () => {
        const files = Array.from(schedMediaInput.files);
        schedMediaPreview.innerHTML = '';
        files.forEach(f => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const div = document.createElement('div');
                div.style.cssText = 'width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border-light);';
                if (f.type.startsWith('video/')) {
                    div.innerHTML = `<video src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;"></video>`;
                } else {
                    div.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;" />`;
                }
                schedMediaPreview.appendChild(div);
            };
            reader.readAsDataURL(f);
        });
    });

    // ─── Default datetime to +1 hour ─────────────────────────────
    const schedDateTime = document.getElementById('schedDateTime');
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    const pad = n => n.toString().padStart(2, '0');
    schedDateTime.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // ─── Form submit ─────────────────────────────────────────────
    const schedulerForm = document.getElementById('schedulerForm');
    schedulerForm.addEventListener('submit', e => {
        e.preventDefault();

        const selectedPlatforms = getSelectedPlatforms();
        if (selectedPlatforms.length === 0) {
            showToast('Please select at least one platform', 'error');
            return;
        }

        const dateTime = schedDateTime.value;
        if (!dateTime) {
            showToast('Please select a date and time', 'error');
            return;
        }

        let contentMap = {};
        if (applyAllToggle.checked) {
            const content = schedContent.value.trim();
            if (!content) {
                showToast('Please write some content', 'error');
                return;
            }
            selectedPlatforms.forEach(p => { contentMap[p] = content; });
        } else {
            selectedPlatforms.forEach(p => {
                const textarea = document.getElementById(`schedIndiv_${p}`);
                contentMap[p] = textarea ? textarea.value.trim() : '';
            });
            const hasContent = Object.values(contentMap).some(c => c.length > 0);
            if (!hasContent) {
                showToast('Please write content for at least one platform', 'error');
                return;
            }
        }

        const post = {
            id: Date.now().toString(),
            platforms: selectedPlatforms,
            contentMap,
            scheduledAt: new Date(dateTime).toISOString(),
            status: 'pending',
            createdAt: new Date().toISOString(),
            userName: window.currentUser?.name || 'Unknown',
        };

        const posts = getScheduledPosts();
        posts.push(post);
        saveScheduledPosts(posts);

        // Reset form
        schedContent.value = '';
        schedCharCount.textContent = '0 characters';
        schedMediaPreview.innerHTML = '';
        schedMediaInput.value = '';

        // Reset platform checkboxes
        document.querySelectorAll('.sched-platform-btn input').forEach(cb => cb.checked = false);

        // Reset datetime to +1h
        const next = new Date();
        next.setHours(next.getHours() + 1, 0, 0, 0);
        schedDateTime.value = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;

        showToast(`Post scheduled for ${selectedPlatforms.length} platform${selectedPlatforms.length > 1 ? 's' : ''}!`);
        renderSchedulerQueue();
    });

    // ─── Calendar setup ──────────────────────────────────────────
    const today = new Date();
    schedCalYear = today.getFullYear();
    schedCalMonth = today.getMonth();

    try {
        document.getElementById('schedCalPrev').addEventListener('click', () => {
            schedCalMonth--;
            if (schedCalMonth < 0) { schedCalMonth = 11; schedCalYear--; }
            renderCalendar();
        });
        document.getElementById('schedCalNext').addEventListener('click', () => {
            schedCalMonth++;
            if (schedCalMonth > 11) { schedCalMonth = 0; schedCalYear++; }
            renderCalendar();
        });
        document.getElementById('schedCalToday').addEventListener('click', () => {
            const t = new Date();
            schedCalYear = t.getFullYear();
            schedCalMonth = t.getMonth();
            renderCalendar();
        });
        document.getElementById('schedDayDetailClose').addEventListener('click', () => {
            document.getElementById('schedDayDetail').style.display = 'none';
        });
    } catch (calErr) {
        console.warn('Calendar element binding error (non-fatal):', calErr.message);
    }

    // Initial renders
    renderSchedulerQueue();
    renderAccountsStatus();
    console.log('🔌 initAccountConnections about to run...');
    initAccountConnections();
    console.log('🔌 initAccountConnections complete');
}

function getSelectedPlatforms() {
    const platforms = [];
    document.querySelectorAll('.sched-platform-btn').forEach(btn => {
        const cb = btn.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) platforms.push(btn.dataset.platform);
    });
    return platforms;
}

function renderIndividualCards() {
    const container = document.getElementById('schedIndividualCards');
    const selected = getSelectedPlatforms();
    if (selected.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:24px;">Select platforms above to customize individual posts</p>';
        return;
    }

    container.innerHTML = selected.map(p => {
        const meta = PLATFORM_META[p];
        const charHint = meta.charLimit ? `Max ${meta.charLimit.toLocaleString()} chars` : 'No limit';
        const svgIcon = document.querySelector(`.sched-platform-btn[data-platform="${p}"] .sched-plat-icon`);
        const iconHtml = svgIcon ? svgIcon.outerHTML : '';
        return `
            <div class="sched-indiv-card">
                <div class="sched-indiv-card-header">
                    ${iconHtml}
                    <h4>${meta.name}</h4>
                    <span class="sched-char-limit">${charHint}</span>
                </div>
                <textarea id="schedIndiv_${p}" rows="3" placeholder="Write your ${meta.name} post…"${meta.charLimit ? ` maxlength="${meta.charLimit}"` : ''}></textarea>
            </div>
        `;
    }).join('');
}

// Re-render individual cards when platforms change
document.querySelectorAll('.sched-platform-btn input').forEach(cb => {
    cb.addEventListener('change', () => {
        const applyAll = document.getElementById('schedApplyAll');
        if (applyAll && !applyAll.checked) renderIndividualCards();
    });
});

function renderSchedulerQueue() {
    const posts = getScheduledPosts().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    const queueEmpty = document.getElementById('schedQueueEmpty');
    const queueList = document.getElementById('schedQueueList');

    if (posts.length === 0) {
        queueEmpty.style.display = '';
        queueList.style.display = 'none';
        return;
    }
    queueEmpty.style.display = 'none';
    queueList.style.display = '';

    queueList.innerHTML = posts.map(post => {
        const d = new Date(post.scheduledAt);
        const month = d.toLocaleString('en', { month: 'short' });
        const day = d.getDate();
        const time = d.toLocaleString('en', { hour: 'numeric', minute: '2-digit', hour12: true });
        const preview = Object.values(post.contentMap)[0] || '';
        const dots = post.platforms.map(p => `<span class="sched-cal-dot ${p}" title="${PLATFORM_META[p]?.name || p}" style="width:10px;height:10px;"></span>`).join('');

        return `
            <div class="sched-queue-item" data-post-id="${post.id}">
                <div class="sched-queue-date">
                    <span class="q-month">${month}</span>
                    <span class="q-day">${day}</span>
                </div>
                <div class="sched-queue-info">
                    <div class="q-text">${preview || 'No content'}</div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div class="q-platforms">${dots}</div>
                        <span class="q-time">${time}</span>
                    </div>
                </div>
                <div class="sched-queue-actions">
                    <button onclick="deleteScheduledPost('${post.id}')" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.deleteScheduledPost = function(postId) {
    const posts = getScheduledPosts().filter(p => p.id !== postId);
    saveScheduledPosts(posts);
    renderSchedulerQueue();
    // Refresh calendar if visible
    const calView = document.getElementById('schedCalendar');
    if (calView && calView.style.display !== 'none') renderCalendar();
    // Refresh analytics if visible
    const anaView = document.getElementById('schedAnalytics');
    if (anaView && anaView.style.display !== 'none') renderSchedulerAnalytics();
    showToast('Scheduled post deleted');
};

// ─── Calendar Render ─────────────────────────────────────────────
function renderCalendar() {
    const calBody = document.getElementById('schedCalBody');
    const calTitle = document.getElementById('schedCalTitle');
    const posts = getScheduledPosts();

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    calTitle.textContent = `${monthNames[schedCalMonth]} ${schedCalYear}`;

    const firstDay = new Date(schedCalYear, schedCalMonth, 1);
    const lastDay = new Date(schedCalYear, schedCalMonth + 1, 0);
    const startOffset = firstDay.getDay(); // 0=Sun
    const daysInMonth = lastDay.getDate();
    const prevMonthDays = new Date(schedCalYear, schedCalMonth, 0).getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${(today.getMonth()+1).toString().padStart(2,'0')}-${today.getDate().toString().padStart(2,'0')}`;

    // Build post lookup by date string (YYYY-MM-DD)
    const postsByDate = {};
    posts.forEach(post => {
        const d = new Date(post.scheduledAt);
        const key = `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
        if (!postsByDate[key]) postsByDate[key] = [];
        postsByDate[key].push(post);
    });

    let cells = '';
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    for (let i = 0; i < totalCells; i++) {
        let dayNum, dateStr, isOtherMonth = false;

        if (i < startOffset) {
            // Previous month
            dayNum = prevMonthDays - startOffset + 1 + i;
            const m = schedCalMonth === 0 ? 12 : schedCalMonth;
            const y = schedCalMonth === 0 ? schedCalYear - 1 : schedCalYear;
            dateStr = `${y}-${m.toString().padStart(2,'0')}-${dayNum.toString().padStart(2,'0')}`;
            isOtherMonth = true;
        } else if (i - startOffset >= daysInMonth) {
            // Next month
            dayNum = i - startOffset - daysInMonth + 1;
            const m = schedCalMonth === 11 ? 1 : schedCalMonth + 2;
            const y = schedCalMonth === 11 ? schedCalYear + 1 : schedCalYear;
            dateStr = `${y}-${m.toString().padStart(2,'0')}-${dayNum.toString().padStart(2,'0')}`;
            isOtherMonth = true;
        } else {
            dayNum = i - startOffset + 1;
            dateStr = `${schedCalYear}-${(schedCalMonth+1).toString().padStart(2,'0')}-${dayNum.toString().padStart(2,'0')}`;
        }

        const isToday = dateStr === todayStr;
        const dayPosts = postsByDate[dateStr] || [];

        let dotsHtml = '';
        if (dayPosts.length > 0) {
            const allPlatforms = [...new Set(dayPosts.flatMap(p => p.platforms))];
            dotsHtml = `<div class="sched-cal-dots">${allPlatforms.map(p => `<span class="sched-cal-dot ${p}"></span>`).join('')}</div>`;
            if (dayPosts.length === 1) {
                const preview = Object.values(dayPosts[0].contentMap)[0] || '';
                dotsHtml += `<div class="sched-cal-post-pill">${preview.substring(0, 20)}${preview.length > 20 ? '…' : ''}</div>`;
            } else {
                dotsHtml += `<div class="sched-cal-post-pill">${dayPosts.length} posts</div>`;
            }
        }

        cells += `<div class="sched-cal-cell${isToday ? ' today' : ''}${isOtherMonth ? ' other-month' : ''}" data-date="${dateStr}">
            <div class="day-num">${dayNum}</div>
            ${dotsHtml}
        </div>`;
    }

    calBody.innerHTML = cells;

    // Click handler for day cells
    calBody.querySelectorAll('.sched-cal-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            const date = cell.dataset.date;
            const dayPosts = postsByDate[date] || [];
            showDayDetail(date, dayPosts);
        });
    });
}

function showDayDetail(dateStr, dayPosts) {
    const detail = document.getElementById('schedDayDetail');
    const title = document.getElementById('schedDayDetailTitle');
    const list = document.getElementById('schedDayDetailList');

    const d = new Date(dateStr + 'T00:00:00');
    title.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    if (dayPosts.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:16px;">No posts scheduled for this day</p>';
    } else {
        list.innerHTML = dayPosts.map(post => {
            const time = new Date(post.scheduledAt).toLocaleString('en', { hour: 'numeric', minute: '2-digit', hour12: true });
            const dots = post.platforms.map(p => `<span class="sched-cal-dot ${p}" style="width:10px;height:10px;"></span>`).join('');
            const preview = Object.values(post.contentMap)[0] || 'No content';
            return `
                <div class="sched-day-post-item">
                    <div class="sched-day-post-platforms">${dots}</div>
                    <div class="sched-day-post-content">${preview}</div>
                    <div class="sched-day-post-time">${time}</div>
                    <div class="sched-day-post-actions">
                        <button onclick="deleteScheduledPost('${post.id}')" title="Delete">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    detail.style.display = '';
}

// ─── Analytics Render ────────────────────────────────────────────
function renderSchedulerAnalytics() {
    const posts = getScheduledPosts();
    const breakdown = document.getElementById('schedAnalyticsBreakdown');
    const empty = document.getElementById('schedAnalyticsEmpty');

    // Stats
    const total = posts.length;
    const published = posts.filter(p => p.status === 'published').length;
    const pending = posts.filter(p => p.status === 'pending').length;
    const allPlatforms = [...new Set(posts.flatMap(p => p.platforms))];

    document.getElementById('schedStatTotal').textContent = total;
    document.getElementById('schedStatPublished').textContent = published;
    document.getElementById('schedStatPending').textContent = pending;
    document.getElementById('schedStatPlatforms').textContent = allPlatforms.length;

    if (total === 0) {
        breakdown.style.display = 'none';
        empty.style.display = '';
        return;
    }

    breakdown.style.display = '';
    empty.style.display = 'none';

    // Count per platform
    const platformCounts = {};
    posts.forEach(post => {
        post.platforms.forEach(p => {
            platformCounts[p] = (platformCounts[p] || 0) + 1;
        });
    });

    const maxCount = Math.max(...Object.values(platformCounts), 1);

    breakdown.innerHTML = Object.entries(PLATFORM_META).map(([key, meta]) => {
        const count = platformCounts[key] || 0;
        const pct = Math.round((count / maxCount) * 100);
        const iconEl = document.querySelector(`.sched-platform-btn[data-platform="${key}"] .sched-plat-icon`);
        const iconHtml = iconEl ? `<span style="width:24px;height:24px;display:flex;align-items:center;justify-content:center;">${iconEl.innerHTML}</span>` : '';
        return `
            <div class="sched-analytics-bar-row">
                <div class="sched-analytics-bar-label">
                    ${iconHtml}
                    ${meta.name}
                </div>
                <div class="sched-analytics-bar-track">
                    <div class="sched-analytics-bar-fill ${key}" style="width:${count > 0 ? Math.max(pct, 8) : 0}%">
                        ${count > 0 ? count + ' post' + (count > 1 ? 's' : '') : ''}
                    </div>
                </div>
                <div class="sched-analytics-bar-count">${count}</div>
            </div>
        `;
    }).join('');
}

// ═══════════════════════════════════════════════════════════════════
// ─── ACCOUNT CONNECTIONS (OAuth via Server) ─────────────────────
// ═══════════════════════════════════════════════════════════════════

// Local cache (synced from server)
let cachedAccountStatus = {};

async function fetchAccountStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/oauth/status`);
        if (res.ok) {
            cachedAccountStatus = await res.json();
            _oauthConnectedStatus = cachedAccountStatus;
            // Cache locally for fast initial render
            localStorage.setItem('orbit_connected_accounts', JSON.stringify(cachedAccountStatus));
        }
    } catch (err) {
        console.warn('Could not fetch account status:', err.message);
        // Fall back to cached
        try { cachedAccountStatus = JSON.parse(localStorage.getItem('orbit_connected_accounts') || '{}'); } catch { cachedAccountStatus = {}; }
    }
    return cachedAccountStatus;
}

function renderAccountsStatus() {
    fetchAccountStatus().then(accounts => {
        const platforms = ['facebook', 'instagram', 'youtube', 'x', 'linkedin'];
        let connectedCount = 0;

        platforms.forEach(p => {
            const isConnected = accounts[p]?.connected === true;
            if (isConnected) connectedCount++;

            const statusEl = document.getElementById(`schedStatus${p.charAt(0).toUpperCase() + p.slice(1)}`);
            const btnEl = document.getElementById(`schedBtn${p.charAt(0).toUpperCase() + p.slice(1)}`);
            const cardEl = btnEl?.closest('.sched-account-card');

            if (statusEl) {
                if (isConnected) {
                    statusEl.className = 'sched-account-status connected-status';
                    const userName = accounts[p].name || 'Connected';
                    statusEl.innerHTML = `<span class="status-dot"></span><span>Connected as ${escHtml(userName)}</span>`;
                } else {
                    statusEl.className = 'sched-account-status disconnected';
                    statusEl.innerHTML = '<span class="status-dot"></span><span>Not connected</span>';
                }
            }

            if (btnEl) {
                if (isConnected) {
                    btnEl.className = 'sched-connect-btn connected-btn';
                    btnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Connected`;
                } else {
                    btnEl.className = 'sched-connect-btn';
                    btnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> Connect`;
                }
            }

            if (cardEl) {
                cardEl.classList.toggle('connected', isConnected);
            }
        });

        // Update banner stats
        const connectedEl = document.getElementById('schedConnectedCount');
        const disconnectedEl = document.getElementById('schedDisconnectedCount');
        if (connectedEl) connectedEl.textContent = connectedCount;
        if (disconnectedEl) disconnectedEl.textContent = 5 - connectedCount;

        // Update platform selector opacity in compose view
        document.querySelectorAll('.sched-platform-btn').forEach(btn => {
            const p = btn.dataset.platform;
            const isConnected = accounts[p]?.connected === true;
            btn.style.opacity = isConnected ? '1' : '0.5';
            btn.title = isConnected ? `${PLATFORM_META[p]?.name} — Connected` : `${PLATFORM_META[p]?.name} — Not connected`;
        });
    });
}

function initAccountConnections() {
    // OAuth popup messages and connect/disconnect clicks are handled once,
    // globally, via the delegated listeners defined near the top of this file
    // (window 'message' + document 'click' on .sched-connect-btn). Binding them
    // again here caused duplicate toasts and double requests, so we only need
    // to render the initial status.
    renderAccountsStatus();
}


// ═══════════════════════════════════════════════════════════════════
// ─── ONE PAGER MODULE ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Use setTimeout to ensure this runs AFTER all other module code,
// even if an earlier line throws a runtime error during execution.
setTimeout(function initOnePager() {
  try {
    console.log('🔧 One Pager module initializing…');

    var previewFrame = document.getElementById('opPreviewFrame');
    var previewContainer = document.getElementById('opPreviewContainer');
    var previewActions = document.getElementById('opPreviewActions');
    var emptyState = document.getElementById('opEmpty');
    var downloadBtn = document.getElementById('opDownloadPdfBtn');
    var generateBtn = document.getElementById('opGenerateBtn');
    var progressContainer = document.getElementById('opProgressContainer');
    var progressFill = document.getElementById('opProgressFill');
    var loadingTextEl = document.getElementById('opLoadingText');

    if (!generateBtn) {
        console.warn('⚠ One Pager button not found');
        return;
    }
    console.log('✅ One Pager elements found');

    var opWithImage = false;
    var lastGeneratedTitle = 'one-pager';

    // Image toggle buttons
    var imgBtns = document.querySelectorAll('.op-img-btn');
    for (var ii = 0; ii < imgBtns.length; ii++) {
        (function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                for (var j = 0; j < imgBtns.length; j++) imgBtns[j].classList.remove('active');
                btn.classList.add('active');
                opWithImage = btn.getAttribute('data-img') === 'yes';
                console.log('🖼️ Image:', opWithImage);
            });
        })(imgBtns[ii]);
    }

    function arrowSvg() {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="#ea580c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    function boldify(text) {
        if (!text) return '';
        return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }

    function renderPreview(data) {
        var d = data || {};
        var companyProduct = d.companyProduct || 'CELERITECH';
        var briefFor = d.briefFor || '';
        var tags = d.tags || '';
        var headline = d.headline || d.title || '';
        var accentWord = d.accentWord || '';
        var subtitle = d.subtitle || '';
        var stats = d.stats || [];
        var sections = d.sections || [];
        var darkBanner = d.darkBanner || {};
        var testimonials = d.testimonials || [];
        var cta = d.cta || {};
        var contact = d.contact || {};
        var img = d.headerImage || null;
        var logo = 'https://ik.imagekit.io/kusosheutk/A-color.png';
        lastGeneratedTitle = headline || 'one-pager';

        var headlineHtml = headline;
        if (accentWord && headline.indexOf(accentWord) >= 0) {
            // accentWord coloring removed — titles stay dark grey
        }

        var BG = 'background:radial-gradient(ellipse at 0% 0%,rgba(234,136,80,0.15) 0%,transparent 50%),radial-gradient(ellipse at 100% 0%,rgba(176,148,220,0.12) 0%,transparent 50%),radial-gradient(ellipse at 50% 100%,rgba(200,180,230,0.10) 0%,transparent 50%),linear-gradient(180deg,#fefefe 0%,#f8f4f0 100%);';
        var PAD = 'padding-left:32px;padding-right:32px;';
        var h = '<div class="op-page" style="width:816px;max-width:816px;margin:0;font-family:Inter,-apple-system,sans-serif;' + BG + 'color:#1e293b;box-sizing:border-box;padding:0;">';

        // ─── HEADER ───
        h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 32px;border-bottom:1px solid rgba(0,0,0,0.06);">';
        h += '<div style="display:flex;align-items:center;gap:8px;"><img src="' + logo + '" alt="Celeritech" style="height:28px;" crossorigin="anonymous" />';
        h += '<span style="font-size:0.65rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#1e293b;">' + companyProduct + '</span></div>';
        if (briefFor) h += '<div style="font-size:0.55rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;">' + briefFor + '</div>';
        h += '</div>';

        // ─── HERO ───
        h += '<div style="' + PAD + 'padding-top:14px;padding-bottom:10px;">';
        if (tags) h += '<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#ea580c;margin-bottom:8px;">' + tags + '</div>';
        h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:1.5rem;font-weight:900;font-style:italic;line-height:1.1;margin-bottom:6px;letter-spacing:-0.02em;color:#334155;">' + headlineHtml + '</div>';
        if (subtitle) h += '<div style="font-size:0.7rem;line-height:1.5;color:#475569;margin-bottom:10px;">' + subtitle + '</div>';
        if (img) h += '<img src="' + img + '" alt="" style="width:100%;max-height:120px;object-fit:cover;border-radius:8px;margin-bottom:10px;" />';
        h += '</div>';

        // ─── STATS ───
        if (stats.length > 0) {
            h += '<div style="display:flex;gap:0;padding:10px 32px;border-top:1px solid rgba(0,0,0,0.06);border-bottom:1px solid rgba(0,0,0,0.06);margin-bottom:10px;">';
            for (var si = 0; si < stats.length; si++) {
                h += '<div style="flex:1;text-align:center;' + (si > 0 ? 'border-left:1px solid rgba(0,0,0,0.06);' : '') + '">';
                h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:1.4rem;font-weight:900;color:#ea580c;line-height:1;margin-bottom:2px;">' + (stats[si].value || '') + '</div>';
                h += '<div style="font-size:0.45rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#94a3b8;">' + (stats[si].label || '') + '</div></div>';
            }
            h += '</div>';
        }

        // ─── SECTIONS ───
        for (var si2 = 0; si2 < sections.length; si2++) {
            var sec = sections[si2];
            var secNum = sec.number || String(si2 + 1).padStart(2, '0');
            h += '<div style="' + PAD + 'margin-bottom:10px;">';
            h += '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">';
            h += '<span style="font-size:0.65rem;font-weight:800;color:#ea580c;">' + secNum + '</span>';
            h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:0.9rem;font-weight:800;font-style:italic;line-height:1.2;color:#334155;">' + (sec.title || '') + '</div></div>';

            if (sec.type === 'checklist' && sec.items) {
                h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;margin-bottom:6px;">';
                for (var ci = 0; ci < sec.items.length; ci++) {
                    h += '<div style="display:flex;align-items:flex-start;gap:6px;font-size:0.68rem;color:#334155;line-height:1.4;">';
                    h += '<div style="flex-shrink:0;width:12px;height:12px;border:1.5px solid #cbd5e1;border-radius:2px;margin-top:1px;"></div>';
                    h += '<span>' + sec.items[ci] + '</span></div>';
                }
                h += '</div>';
                if (sec.callout) {
                    h += '<div style="display:flex;align-items:stretch;gap:8px;margin-top:4px;">';
                    h += '<div style="width:2px;background:linear-gradient(180deg,#f97316,#ea580c);border-radius:2px;flex-shrink:0;"></div>';
                    h += '<div style="font-size:0.68rem;color:#334155;line-height:1.4;">' + boldify(sec.callout) + '</div></div>';
                }
            } else if (sec.type === 'comparison' && sec.items) {
                h += '<div style="background:#fff;border-radius:8px;border:1px solid rgba(0,0,0,0.05);overflow:hidden;">';
                h += '<div style="display:grid;grid-template-columns:1fr 28px 1fr;padding:6px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">';
                h += '<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#94a3b8;">NOW</div><div></div>';
                h += '<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#94a3b8;">AFTER</div></div>';
                for (var ri = 0; ri < sec.items.length; ri++) {
                    var row = sec.items[ri];
                    h += '<div style="display:grid;grid-template-columns:1fr 28px 1fr;padding:6px 12px;border-bottom:1px solid #f1f5f9;align-items:center;">';
                    h += '<div style="font-size:0.68rem;color:#94a3b8;line-height:1.3;">' + (row.before || '') + '</div>';
                    h += '<div style="display:flex;justify-content:center;">' + arrowSvg() + '</div>';
                    h += '<div style="font-size:0.68rem;color:#0f172a;font-weight:600;line-height:1.3;">' + (row.after || '') + '</div></div>';
                }
                h += '</div>';
            }
            h += '</div>';
        }

        // ─── DARK BANNER (full width) ───
        if (darkBanner.headline || (darkBanner.tags && darkBanner.tags.length)) {
            h += '<div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:14px 32px;margin:8px 0;">';
            if (darkBanner.headline) h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:0.85rem;font-weight:800;line-height:1.2;margin-bottom:6px;color:#f8fafc;">' + darkBanner.headline + '</div>';
            if (darkBanner.tags && darkBanner.tags.length) {
                h += '<div style="display:flex;flex-wrap:wrap;gap:4px 10px;">';
                for (var ti = 0; ti < darkBanner.tags.length; ti++) h += '<span style="font-size:0.55rem;color:#94a3b8;">' + darkBanner.tags[ti] + (ti < darkBanner.tags.length - 1 ? ' ·' : '') + '</span>';
                h += '</div>';
            }
            h += '</div>';
        }

        // ─── CTA (full width) ───
        if (cta.headline) {
            h += '<div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:14px 32px;margin:8px 0;">';
            h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:0.85rem;font-weight:800;line-height:1.2;margin-bottom:4px;color:#f8fafc;">' + cta.headline + '</div>';
            if (cta.description) h += '<div style="font-size:0.68rem;color:#94a3b8;line-height:1.4;">' + cta.description + '</div>';
            h += '</div>';
        }

        // ─── CONTACT ───
        if (contact.email || contact.phone || contact.website) {
            h += '<div style="display:flex;gap:16px;' + PAD + 'padding-top:8px;padding-bottom:4px;font-size:0.6rem;color:#94a3b8;">';
            if (contact.email) h += '<span>✉ ' + contact.email + '</span>';
            if (contact.phone) h += '<span>☎ ' + contact.phone + '</span>';
            if (contact.website) h += '<span>↗ ' + contact.website + '</span>';
            h += '</div>';
        }

        h += '</div>'; // close page

        if (previewFrame) previewFrame.innerHTML = h;
        if (previewContainer) previewContainer.style.display = 'block';
        if (emptyState) emptyState.style.display = 'none';
        if (previewActions) previewActions.style.display = 'flex';
        var previewSection = previewContainer || previewFrame;
        if (previewSection) setTimeout(function() { previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);

        // Save to history
        try {
            var history = JSON.parse(localStorage.getItem('op_history') || '[]');
            history.unshift({ id: Date.now(), title: headline || 'Untitled', date: new Date().toISOString(), data: d, html: h });
            if (history.length > 20) history = history.slice(0, 20);
            localStorage.setItem('op_history', JSON.stringify(history));
            if (typeof renderOnePagerHistory === 'function') renderOnePagerHistory();
        } catch(e) { console.warn('Failed to save one-pager history:', e); }

        console.log('✅ Preview rendered:', headline);
    }

    var _opGenerating = false;

    function doGenerate() {
        console.log('📄 Generate clicked');

        if (_opGenerating) {
            console.log('⚠ One Pager generation already in progress, skipping');
            return;
        }

        var descEl = document.getElementById('opDescription');
        var description = descEl ? descEl.value.trim() : '';
        if (!description) {
            if (typeof showToast === 'function') showToast('Please describe your product or service', 'error');
            else alert('Please describe your product or service');
            return;
        }

        // Safety: auto-reset _opGenerating after 60s in case of stuck state
        setTimeout(function() { _opGenerating = false; }, 60000);

        _opGenerating = true;

        var btnText = generateBtn.querySelector('.btn-text');
        var btnLoader = generateBtn.querySelector('.btn-loader');
        if (btnText) btnText.style.display = 'none';
        if (btnLoader) btnLoader.style.display = '';
        generateBtn.disabled = true;
        if (progressContainer) {
            progressContainer.style.display = '';
            if (progressFill) progressFill.style.width = '0%';
            if (loadingTextEl) loadingTextEl.textContent = 'Starting generation…';
        }

        var apiUrl = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/onepager/generate';
        console.log('   Fetching:', apiUrl);

        fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: description, withImage: opWithImage }),
        })
        .then(function(res) {
            if (!res.ok) throw new Error('Server ' + res.status);
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            function pump() {
                return reader.read().then(function(r) {
                    if (r.done) return;
                    buffer += decoder.decode(r.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].indexOf('data: ') !== 0) continue;
                        try {
                            var d = JSON.parse(lines[i].slice(6));
                            if (d.type === 'progress') {
                                var pct = Math.round((d.step / d.total) * 100);
                                if (progressFill) progressFill.style.width = pct + '%';
                                if (loadingTextEl) loadingTextEl.textContent = d.message;
                            }
                            if (d.type === 'result') { renderPreview(d); if (typeof showToast === 'function') showToast('One pager generated!'); }
                            if (d.type === 'error') { if (typeof showToast === 'function') showToast(d.error, 'error'); }
                        } catch (pe) { /* skip */ }
                    }
                    return pump();
                });
            }
            return pump();
        })
        .catch(function(err) {
            console.error('Generate error:', err);
            if (typeof showToast === 'function') showToast('Failed: ' + err.message, 'error');
            else alert('Generation failed: ' + err.message);
        })
        .finally(function() {
            _opGenerating = false;
            var bt = generateBtn.querySelector('.btn-text');
            var bl = generateBtn.querySelector('.btn-loader');
            if (bt) bt.style.display = '';
            if (bl) bl.style.display = 'none';
            generateBtn.disabled = false;
            if (progressContainer) progressContainer.style.display = 'none';
        });
    }

    generateBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        doGenerate();
    });
    window._generateOnePager = doGenerate;

    if (downloadBtn) {
        downloadBtn.addEventListener('click', function() {
            if (!previewFrame) return;
            var pageEl = previewFrame.querySelector('.op-page') || previewFrame.firstElementChild;
            if (!pageEl) { if (typeof showToast === 'function') showToast('Generate first', 'error'); return; }
            downloadBtn.disabled = true;
            var orig = downloadBtn.innerHTML;
            downloadBtn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,0.3);border-top-color:#fff;"></span> Generating PDF…';
            var fname = lastGeneratedTitle.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40) + '_one_pager.pdf';

            // Capture as image then scale to fit one letter page
            var h2c = window.html2canvas || (html2pdf && html2pdf().constructor && window.html2canvas);
            if (!h2c) { 
                // Fallback: use html2pdf normally
                html2pdf().set({
                    margin: 0, filename: fname,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true, allowTaint: true, logging: false, backgroundColor: '#fefefe', scrollY: -window.scrollY },
                    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
                }).from(pageEl).save().finally(function() { downloadBtn.disabled = false; downloadBtn.innerHTML = orig; });
                return;
            }
            h2c(pageEl, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                logging: false,
                backgroundColor: '#fefefe',
                scrollY: -window.scrollY,
            }).then(function(canvas) {
                var imgData = canvas.toDataURL('image/jpeg', 0.95);
                var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
                var pdf = new JsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });
                var pageW = 8.5;
                var pageH = 11;
                // Always fill full page width, cap height at page
                var fitW = pageW;
                var fitH = pageW * (canvas.height / canvas.width);
                if (fitH > pageH) fitH = pageH;
                pdf.addImage(imgData, 'JPEG', 0, 0, fitW, fitH);
                pdf.save(fname);
                if (typeof showToast === 'function') showToast('PDF downloaded!');
            }).catch(function(e) {
                console.error('PDF err:', e);
            }).finally(function() {
                downloadBtn.disabled = false;
                downloadBtn.innerHTML = orig;
            });
        });
    }

    console.log('✅ One Pager module ready');
  } catch (initErr) {
    console.error('❌ One Pager module init error:', initErr);
  }
}, 0);

// ═══════════════════════════════════════════════════════════════════
// ─── SCRAPING LEAD GEN MODULE ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

(function () {
    let leadgenInitialized = false;
    let leadgenRefreshInterval = null;
    let leadgenCampaigns = [];
    let leadgenCurrentCampaignId = null;
    let leadgenLeads = [];
    let leadgenSelectedLeads = new Set();

    // ─── Helper Functions ────────────────────────────────────────
    function lgFormatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
            d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    function lgFormatScore(score) {
        if (score == null) return '<span class="score-badge score-na">—</span>';
        const cls = score >= 75 ? 'score-high' : score >= 50 ? 'score-mid' : 'score-low';
        return `<span class="score-badge ${cls}">${score}</span>`;
    }

    function lgStatusBadge(status) {
        const map = {
            running: { icon: '🟢', cls: 'lg-status-running' },
            paused: { icon: '🟡', cls: 'lg-status-paused' },
            draft: { icon: '⚫', cls: 'lg-status-draft' },
            error: { icon: '🔴', cls: 'lg-status-error' },
        };
        const s = map[status] || map.draft;
        return `<span class="campaign-status-badge ${s.cls}">${s.icon} ${status || 'draft'}</span>`;
    }

    function lgShowToast(message, type) {
        if (typeof showToast === 'function') showToast(message, type);
    }

    // ─── Initialize Page ─────────────────────────────────────────
    window.initLeadgenPage = function () {
        if (!leadgenInitialized) {
            setupLeadgenTabSwitcher();
            setupNewCampaignModal();
            setupLeadgenResultsEvents();
            leadgenInitialized = true;
        }
        fetchCampaigns();

        // Auto-refresh every 30s
        if (leadgenRefreshInterval) clearInterval(leadgenRefreshInterval);
        leadgenRefreshInterval = setInterval(() => {
            const page = localStorage.getItem('orbit_active_page');
            if (page === 'leadgen') fetchCampaigns();
        }, 30000);
    };

    // ─── Tab Switcher ────────────────────────────────────────────
    function setupLeadgenTabSwitcher() {
        const tabs = document.getElementById('leadgenTabs');
        if (!tabs) return;
        tabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.leadgen-tab');
            if (!tab) return;
            const target = tab.dataset.tab;
            tabs.querySelectorAll('.leadgen-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('leadgenCampaignsTab').style.display = target === 'campaigns' ? '' : 'none';
            document.getElementById('leadgenResultsTab').style.display = target === 'results' ? '' : 'none';

            if (target === 'results') refreshLeadgenCampaignSelector();
        });
    }

    // ─── Fetch Campaigns ─────────────────────────────────────────
    async function fetchCampaigns() {
        try {
            const res = await fetch(`${API_BASE}/api/campaigns`);
            if (res.ok) {
                leadgenCampaigns = await res.json();
            } else {
                leadgenCampaigns = [];
            }
        } catch {
            // Server unavailable — use empty list
            leadgenCampaigns = [];
        }
        renderCampaignCards();
    }

    // ─── Render Campaign Cards ───────────────────────────────────
    function renderCampaignCards() {
        const grid = document.getElementById('campaignCardsGrid');
        if (!grid) return;

        if (!leadgenCampaigns.length) {
            grid.innerHTML = `
                <div class="leadgen-empty-state">
                    <div class="empty-icon">📡</div>
                    <h4>No campaigns yet</h4>
                    <p>Create your first scraping campaign to start finding leads.</p>
                </div>`;
            return;
        }

        grid.innerHTML = leadgenCampaigns.map(c => `
            <div class="campaign-card" data-id="${c.id || c._id}">
                <div class="campaign-card-header">
                    ${lgStatusBadge(c.status)}
                    <span class="campaign-card-name">${c.name || 'Untitled Campaign'}</span>
                </div>
                <div class="campaign-card-stats">
                    <div class="campaign-stat"><span class="campaign-stat-val">${c.stats?.found || 0}</span><span class="campaign-stat-lbl">Found</span></div>
                    <div class="campaign-stat"><span class="campaign-stat-val">${c.stats?.qualified || 0}</span><span class="campaign-stat-lbl">Qualified</span></div>
                    <div class="campaign-stat"><span class="campaign-stat-val">${c.stats?.emailed || 0}</span><span class="campaign-stat-lbl">Emailed</span></div>
                    <div class="campaign-stat"><span class="campaign-stat-val">${c.stats?.replied || 0}</span><span class="campaign-stat-lbl">Replied</span></div>
                    <div class="campaign-stat"><span class="campaign-stat-val">${c.stats?.meetings || 0}</span><span class="campaign-stat-lbl">Meetings</span></div>
                </div>
                <div class="campaign-card-meta">
                    <span>Last run: ${lgFormatDate(c.lastRun)}</span>
                    <span>Next run: ${lgFormatDate(c.nextRun)}</span>
                </div>
                <div class="campaign-card-actions">
                    ${c.status === 'running'
                ? `<button class="btn-small-outline lg-pause-btn" data-id="${c.id || c._id}">⏸ Pause</button>`
                : `<button class="btn-small-outline lg-resume-btn" data-id="${c.id || c._id}">▶ Resume</button>`}
                    <button class="btn-small-outline lg-runnow-btn" data-id="${c.id || c._id}">⚡ Run Now</button>
                    <button class="btn-small-outline lg-viewresults-btn" data-id="${c.id || c._id}">📊 Results</button>
                    <button class="btn-small-outline btn-danger-text lg-delete-btn" data-id="${c.id || c._id}">🗑</button>
                </div>
            </div>
        `).join('');

        // Bind campaign card action buttons
        grid.querySelectorAll('.lg-pause-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); pauseCampaign(btn.dataset.id); });
        });
        grid.querySelectorAll('.lg-resume-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); resumeCampaign(btn.dataset.id); });
        });
        grid.querySelectorAll('.lg-runnow-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); runNowCampaign(btn.dataset.id); });
        });
        grid.querySelectorAll('.lg-viewresults-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                switchToResultsTab(btn.dataset.id);
            });
        });
        grid.querySelectorAll('.lg-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); deleteCampaign(btn.dataset.id); });
        });
    }

    // ─── Campaign Actions ────────────────────────────────────────
    async function campaignAction(id, path, method, okMsg, failMsg) {
        try {
            const res = await fetch(`${API_BASE}/api/campaigns/${id}${path}`, { method });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            lgShowToast(okMsg);
            fetchCampaigns();
        } catch (err) {
            lgShowToast(`${failMsg}: ${err.message}`, 'error');
        }
    }

    async function pauseCampaign(id) {
        return campaignAction(id, '/pause', 'POST', 'Campaign paused', 'Failed to pause campaign');
    }

    async function resumeCampaign(id) {
        return campaignAction(id, '/resume', 'POST', 'Campaign resumed', 'Failed to resume campaign');
    }

    async function runNowCampaign(id) {
        return campaignAction(id, '/run-now', 'POST', 'Campaign running now!', 'Failed to run campaign');
    }

    async function deleteCampaign(id) {
        if (!confirm('Delete this campaign? This cannot be undone.')) return;
        return campaignAction(id, '', 'DELETE', 'Campaign deleted', 'Failed to delete campaign');
    }

    function switchToResultsTab(campaignId) {
        const tabs = document.getElementById('leadgenTabs');
        tabs.querySelectorAll('.leadgen-tab').forEach(t => t.classList.remove('active'));
        tabs.querySelector('[data-tab="results"]').classList.add('active');
        document.getElementById('leadgenCampaignsTab').style.display = 'none';
        document.getElementById('leadgenResultsTab').style.display = '';
        refreshLeadgenCampaignSelector();
        if (campaignId) {
            const sel = document.getElementById('leadgenCampaignSelect');
            sel.value = campaignId;
            leadgenCurrentCampaignId = campaignId;
            fetchLeads(campaignId);
        }
    }

    // ─── Results Tab Events ──────────────────────────────────────
    function setupLeadgenResultsEvents() {
        const sel = document.getElementById('leadgenCampaignSelect');
        if (sel) sel.addEventListener('change', () => {
            leadgenCurrentCampaignId = sel.value;
            if (sel.value) fetchLeads(sel.value);
        });

        const statusFilter = document.getElementById('leadgenStatusFilter');
        const scoreFilter = document.getElementById('leadgenMinScore');
        const searchFilter = document.getElementById('leadgenSearchInput');

        [statusFilter, scoreFilter, searchFilter].forEach(el => {
            if (el) el.addEventListener('input', () => renderLeadTable());
        });

        const selectAll = document.getElementById('leadSelectAll');
        if (selectAll) selectAll.addEventListener('change', () => {
            const checkboxes = document.querySelectorAll('#leadTableBody .lead-checkbox');
            checkboxes.forEach(cb => { cb.checked = selectAll.checked; });
            leadgenSelectedLeads.clear();
            if (selectAll.checked) {
                leadgenLeads.forEach(l => leadgenSelectedLeads.add(l.id || l._id));
            }
            updateBulkActions();
        });

        // Bulk action buttons
        document.getElementById('bulkEmailBtn')?.addEventListener('click', bulkEmail);
        document.getElementById('bulkCallBtn')?.addEventListener('click', bulkCall);
        document.getElementById('bulkExportBtn')?.addEventListener('click', bulkExportCSV);
        document.getElementById('bulkGhlBtn')?.addEventListener('click', bulkPushGHL);
    }

    function refreshLeadgenCampaignSelector() {
        const sel = document.getElementById('leadgenCampaignSelect');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '<option value="">Select a campaign…</option>' +
            leadgenCampaigns.map(c =>
                `<option value="${c.id || c._id}">${c.name || 'Untitled'}</option>`
            ).join('');
        if (prev && leadgenCampaigns.find(c => (c.id || c._id) === prev)) {
            sel.value = prev;
        }
    }

    // ─── Fetch & Render Leads ────────────────────────────────────
    async function fetchLeads(campaignId) {
        try {
            const res = await fetch(`${API_BASE}/api/campaigns/${campaignId}/leads`);
            if (res.ok) {
                leadgenLeads = await res.json();
                // Update stats bar
                const campaign = leadgenCampaigns.find(c => (c.id || c._id) === campaignId);
                if (campaign?.stats) {
                    document.getElementById('statFound').textContent = campaign.stats.found || 0;
                    document.getElementById('statQualified').textContent = campaign.stats.qualified || 0;
                    document.getElementById('statEmailed').textContent = campaign.stats.emailed || 0;
                    document.getElementById('statReplied').textContent = campaign.stats.replied || 0;
                    document.getElementById('statMeetings').textContent = campaign.stats.meetings || 0;
                }
            } else {
                leadgenLeads = [];
            }
        } catch {
            leadgenLeads = [];
        }
        renderLeadTable();
    }

    function renderLeadTable() {
        const tbody = document.getElementById('leadTableBody');
        const empty = document.getElementById('leadTableEmpty');
        const table = document.getElementById('leadTable');
        if (!tbody) return;

        // Apply filters
        const statusFilter = document.getElementById('leadgenStatusFilter')?.value || 'all';
        const minScore = parseInt(document.getElementById('leadgenMinScore')?.value) || 0;
        const search = (document.getElementById('leadgenSearchInput')?.value || '').toLowerCase();

        let filtered = leadgenLeads.filter(lead => {
            if (statusFilter !== 'all' && lead.status !== statusFilter) return false;
            if (lead.score != null && lead.score < minScore) return false;
            if (search && !(lead.company?.name || '').toLowerCase().includes(search) &&
                !(lead.contact?.name || '').toLowerCase().includes(search)) return false;
            return true;
        });

        if (!filtered.length) {
            tbody.innerHTML = '';
            if (table) table.style.display = 'none';
            if (empty) empty.style.display = '';
            return;
        }

        if (table) table.style.display = '';
        if (empty) empty.style.display = 'none';

        tbody.innerHTML = filtered.map(lead => {
            const id = lead.id || lead._id;
            const checked = leadgenSelectedLeads.has(id) ? 'checked' : '';
            const company = lead.company || {};
            const contact = lead.contact || {};

            // Email status
            let emailStatus = '❌ Not sent';
            if (lead.emailStatus === 'sent') emailStatus = `✅ Sent ${lgFormatDate(lead.emailSentAt)}`;
            else if (lead.emailStatus === 'scheduled') emailStatus = `⏳ Scheduled ${lgFormatDate(lead.emailScheduledAt)}`;

            // Reply status
            let replyStatus = '— N/A';
            if (lead.replyStatus === 'replied') replyStatus = `✅ Replied ${lgFormatDate(lead.repliedAt)}`;
            else if (lead.emailStatus === 'sent') replyStatus = '❌ No reply';

            // Next action
            let nextAction = '—';
            if (lead.nextAction === 'email') nextAction = `📧 Email ${lgFormatDate(lead.nextActionDate)}`;
            else if (lead.nextAction === 'call') nextAction = `📞 Call ${lgFormatDate(lead.nextActionDate)}`;
            else if (lead.nextAction === 'done') nextAction = '✅ Done';

            return `<tr class="lead-row" data-id="${id}">
                <td><input type="checkbox" class="lead-checkbox" data-id="${id}" ${checked} /></td>
                <td>${lgFormatScore(lead.score)}</td>
                <td>
                    <div class="lead-company-name">${company.name || '—'}</div>
                    <div class="lead-company-meta">${company.city || ''}${company.state ? ', ' + company.state : ''}</div>
                    <div class="lead-company-meta">${company.employees ? '~' + company.employees + ' emp' : ''}${company.revenue ? ' · $' + company.revenue : ''}</div>
                </td>
                <td>
                    <div class="lead-contact-name">${contact.name || '—'}</div>
                    <div class="lead-contact-meta">${contact.title || ''}</div>
                    <div class="lead-contact-meta">${contact.email || ''}</div>
                </td>
                <td><span class="lead-email-status">${emailStatus}</span></td>
                <td><span class="lead-reply-status">${replyStatus}</span></td>
                <td><span class="lead-next-action">${nextAction}</span></td>
            </tr>`;
        }).join('');

        // Bind row click → open lead detail modal
        tbody.querySelectorAll('.lead-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                openLeadDetailModal(row.dataset.id);
            });
        });

        // Bind checkboxes
        tbody.querySelectorAll('.lead-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) leadgenSelectedLeads.add(cb.dataset.id);
                else leadgenSelectedLeads.delete(cb.dataset.id);
                updateBulkActions();
            });
        });
    }

    function updateBulkActions() {
        const bar = document.getElementById('leadgenBulkActions');
        const count = document.getElementById('leadgenSelectedCount');
        if (leadgenSelectedLeads.size > 0) {
            bar.style.display = '';
            count.textContent = `${leadgenSelectedLeads.size} selected`;
        } else {
            bar.style.display = 'none';
        }
    }

    // ─── Lead Detail Modal ───────────────────────────────────────
    async function openLeadDetailModal(leadId) {
        let lead;
        try {
            const res = await fetch(`${API_BASE}/api/leads/${leadId}`);
            if (res.ok) lead = await res.json();
        } catch { }
        if (!lead) lead = leadgenLeads.find(l => (l.id || l._id) === leadId);
        if (!lead) { lgShowToast('Lead not found', 'error'); return; }

        // Remove any existing modal
        document.getElementById('leadDetailModal')?.remove();

        const company = lead.company || {};
        const contact = lead.contact || {};
        const qualification = lead.qualification || {};
        const outreach = lead.outreachTimeline || [];
        const contacts = lead.contacts || [contact];

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'leadDetailModal';
        modal.innerHTML = `
            <div class="lead-modal" onclick="event.stopPropagation()">
                <div class="lead-modal-header">
                    <div class="lead-modal-title">
                        <h2>${company.name || 'Unknown Company'}</h2>
                        ${lgFormatScore(lead.score)}
                    </div>
                    <button class="lead-modal-close" id="leadModalClose">✕</button>
                </div>

                <div class="lead-modal-body">
                    <!-- Company Info -->
                    <div class="lead-section">
                        <h4>🏢 Company Info</h4>
                        <div class="lead-info-grid">
                            ${company.website ? `<div class="lead-info-item"><span class="lead-info-label">Website</span><a href="${company.website}" target="_blank">${company.website}</a></div>` : ''}
                            ${company.address ? `<div class="lead-info-item"><span class="lead-info-label">Address</span><span>${company.address}</span></div>` : ''}
                            ${company.phone ? `<div class="lead-info-item"><span class="lead-info-label">Phone</span><span>${company.phone}</span></div>` : ''}
                            ${company.employees ? `<div class="lead-info-item"><span class="lead-info-label">Employees</span><span>${company.employees}</span></div>` : ''}
                            ${company.revenue ? `<div class="lead-info-item"><span class="lead-info-label">Revenue</span><span>$${company.revenue}</span></div>` : ''}
                            ${company.products ? `<div class="lead-info-item"><span class="lead-info-label">Products</span><span>${company.products}</span></div>` : ''}
                            ${company.certifications ? `<div class="lead-info-item"><span class="lead-info-label">Certifications</span><span>${company.certifications}</span></div>` : ''}
                            ${company.software ? `<div class="lead-info-item"><span class="lead-info-label">Software</span><span>${company.software}</span></div>` : ''}
                            ${company.socialLinks ? `<div class="lead-info-item"><span class="lead-info-label">Social</span><span>${Array.isArray(company.socialLinks) ? company.socialLinks.map(s => `<a href="${s}" target="_blank">${s}</a>`).join(', ') : company.socialLinks}</span></div>` : ''}
                        </div>
                    </div>

                    <!-- Contacts -->
                    <div class="lead-section">
                        <h4>👥 Contacts</h4>
                        <div class="lead-contacts-list">
                            ${contacts.map(c => `
                                <div class="lead-contact-card">
                                    <div class="lead-contact-name-lg">${c.name || '—'}</div>
                                    <div class="lead-contact-detail">${c.title || ''}</div>
                                    <div class="lead-contact-detail">${c.email || ''}</div>
                                    <div class="lead-contact-detail">${c.phone || ''}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- AI Qualification -->
                    <div class="lead-section">
                        <h4>🤖 AI Qualification</h4>
                        <div class="lead-qual-score">
                            <div class="lead-qual-bar"><div class="lead-qual-fill" style="width:${qualification.score || lead.score || 0}%; background:${(qualification.score || lead.score || 0) >= 75 ? '#10b981' : (qualification.score || lead.score || 0) >= 50 ? '#f59e0b' : '#ef4444'};"></div></div>
                            <span class="lead-qual-num">${qualification.score || lead.score || 0}/100</span>
                        </div>
                        ${qualification.reasoning ? `<p class="lead-qual-reasoning">${qualification.reasoning}</p>` : ''}
                        ${qualification.painPoints?.length ? `
                            <div class="lead-pain-points">
                                <strong>Pain Points:</strong>
                                <ul>${qualification.painPoints.map(p => `<li>${p}</li>`).join('')}</ul>
                            </div>
                        ` : ''}
                    </div>

                    <!-- Outreach Timeline -->
                    <div class="lead-section">
                        <h4>📬 Outreach Timeline</h4>
                        <div class="outreach-timeline">
                            ${outreach.length ? outreach.map(o => `
                                <div class="outreach-event">
                                    <span class="outreach-icon">${o.type === 'email_sent' ? '📧' : o.type === 'reply_received' ? '💬' : o.type === 'call_made' ? '📞' : '📌'}</span>
                                    <div class="outreach-info">
                                        <span class="outreach-desc">${o.description || o.type}</span>
                                        <span class="outreach-date">${lgFormatDate(o.date)}</span>
                                    </div>
                                </div>
                            `).join('') : '<p style="color:var(--text-muted);font-size:0.85rem;">No outreach activity yet.</p>'}
                        </div>
                    </div>

                    <!-- Email Draft -->
                    <div class="lead-section">
                        <h4>✉️ Email Draft</h4>
                        <div class="lead-email-draft">
                            <div class="form-group">
                                <label>To</label>
                                <input type="text" id="leadEmailTo" value="${contact.email || ''}" class="lead-modal-input" />
                            </div>
                            <div class="form-group">
                                <label>Subject</label>
                                <input type="text" id="leadEmailSubject" value="${lead.emailDraft?.subject || ''}" class="lead-modal-input" />
                            </div>
                            <div class="form-group">
                                <label>Body</label>
                                <textarea id="leadEmailBody" class="lead-modal-textarea" rows="6">${lead.emailDraft?.body || ''}</textarea>
                            </div>
                            <button class="btn-primary" id="leadSendEmailBtn" style="margin-top:8px; padding:10px 24px; font-size:0.85rem;">📧 Send Now</button>
                        </div>
                    </div>
                </div>

                <!-- Action buttons -->
                <div class="lead-modal-actions">
                    <button class="btn-small-outline" id="leadActionEmail">📧 Email</button>
                    <button class="btn-small-outline" id="leadActionCall">📞 AI Call</button>
                    <button class="btn-small-outline" id="leadActionGHL">→ Push to GHL</button>
                    <button class="btn-small-outline" id="leadActionEdit">✏️ Edit</button>
                    <button class="btn-small-outline btn-danger-text" id="leadActionDisqualify">❌ Disqualify</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close modal
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        document.getElementById('leadModalClose').addEventListener('click', () => modal.remove());

        // Send email
        document.getElementById('leadSendEmailBtn').addEventListener('click', async () => {
            const to = document.getElementById('leadEmailTo').value;
            const subject = document.getElementById('leadEmailSubject').value;
            const body = document.getElementById('leadEmailBody').value;
            if (!to || !subject) { lgShowToast('Fill in email and subject', 'error'); return; }
            try {
                await fetch(`${API_BASE}/api/leads/${leadId}/email`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to, subject, body }),
                });
                lgShowToast('Email sent!');
            } catch { lgShowToast('Failed to send email', 'error'); }
        });

        // Action buttons
        document.getElementById('leadActionEmail').addEventListener('click', () => {
            document.getElementById('leadEmailTo').focus();
        });
        document.getElementById('leadActionCall').addEventListener('click', async () => {
            try {
                await fetch(`${API_BASE}/api/leads/${leadId}/call`, { method: 'POST' });
                lgShowToast('AI call initiated');
            } catch { lgShowToast('Call failed', 'error'); }
        });
        document.getElementById('leadActionGHL').addEventListener('click', async () => {
            try {
                await fetch(`${API_BASE}/api/leads/${leadId}/push-ghl`, { method: 'POST' });
                lgShowToast('Pushed to GHL!');
            } catch { lgShowToast('Push failed', 'error'); }
        });
        document.getElementById('leadActionEdit').addEventListener('click', () => {
            lgShowToast('Edit mode — modify fields directly in the modal');
        });
        document.getElementById('leadActionDisqualify').addEventListener('click', async () => {
            try {
                await fetch(`${API_BASE}/api/leads/${leadId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'disqualified' }),
                });
                lgShowToast('Lead disqualified');
                modal.remove();
                if (leadgenCurrentCampaignId) fetchLeads(leadgenCurrentCampaignId);
            } catch { lgShowToast('Failed to disqualify', 'error'); }
        });
    }

    // ─── Bulk Actions ────────────────────────────────────────────
    async function bulkEmail() {
        lgShowToast(`Sending emails to ${leadgenSelectedLeads.size} leads…`);
        for (const id of leadgenSelectedLeads) {
            try { await fetch(`${API_BASE}/api/leads/${id}/email`, { method: 'POST' }); } catch { }
        }
        lgShowToast('Bulk email complete!');
        leadgenSelectedLeads.clear();
        updateBulkActions();
        if (leadgenCurrentCampaignId) fetchLeads(leadgenCurrentCampaignId);
    }

    async function bulkCall() {
        lgShowToast(`Initiating calls for ${leadgenSelectedLeads.size} leads…`);
        for (const id of leadgenSelectedLeads) {
            try { await fetch(`${API_BASE}/api/leads/${id}/call`, { method: 'POST' }); } catch { }
        }
        lgShowToast('Bulk calls initiated!');
        leadgenSelectedLeads.clear();
        updateBulkActions();
    }

    function bulkExportCSV() {
        const selected = leadgenLeads.filter(l => leadgenSelectedLeads.has(l.id || l._id));
        if (!selected.length) return;
        const headers = ['Company', 'Score', 'Contact', 'Email', 'Title', 'City', 'State', 'Status'];
        const rows = selected.map(l => [
            l.company?.name || '', l.score || '', l.contact?.name || '', l.contact?.email || '',
            l.contact?.title || '', l.company?.city || '', l.company?.state || '', l.status || ''
        ]);
        const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'leads_export.csv'; a.click();
        URL.revokeObjectURL(url);
        lgShowToast('CSV exported!');
    }

    async function bulkPushGHL() {
        lgShowToast(`Pushing ${leadgenSelectedLeads.size} leads to GHL…`);
        for (const id of leadgenSelectedLeads) {
            try { await fetch(`${API_BASE}/api/leads/${id}/push-ghl`, { method: 'POST' }); } catch { }
        }
        lgShowToast('Pushed to GHL!');
        leadgenSelectedLeads.clear();
        updateBulkActions();
    }

    // ─── New Campaign Modal ──────────────────────────────────────
    function setupNewCampaignModal() {
        const btn = document.getElementById('lgNewCampaignBtn');
        if (!btn) return;

        btn.addEventListener('click', () => {
            // Remove existing modal if any
            document.getElementById('newCampaignModal')?.remove();

            const US_REGIONS = {
                'Southeast': ['Alabama', 'Arkansas', 'Florida', 'Georgia', 'Kentucky', 'Louisiana', 'Mississippi', 'North Carolina', 'South Carolina', 'Tennessee', 'Virginia', 'West Virginia'],
                'Northeast': ['Connecticut', 'Delaware', 'Maine', 'Maryland', 'Massachusetts', 'New Hampshire', 'New Jersey', 'New York', 'Pennsylvania', 'Rhode Island', 'Vermont'],
                'Midwest': ['Illinois', 'Indiana', 'Iowa', 'Kansas', 'Michigan', 'Minnesota', 'Missouri', 'Nebraska', 'North Dakota', 'Ohio', 'South Dakota', 'Wisconsin'],
                'West': ['Alaska', 'California', 'Colorado', 'Hawaii', 'Idaho', 'Montana', 'Nevada', 'Oregon', 'Utah', 'Washington', 'Wyoming'],
                'Southwest': ['Arizona', 'New Mexico', 'Oklahoma', 'Texas'],
            };

            const SUB_CATEGORIES = {
                'food_beverage': ['Dairy', 'Bakery', 'Meat Processing', 'Seafood', 'Snack Foods', 'Beverage', 'Frozen Foods', 'Condiments/Sauces'],
                'healthcare': ['Hospitals', 'Clinics', 'Pharma', 'Medical Devices', 'Home Health', 'Mental Health'],
                'technology': ['SaaS', 'Hardware', 'IT Services', 'Cybersecurity', 'AI/ML', 'Cloud'],
                'construction': ['General Contractor', 'Specialty Trades', 'Heavy Civil', 'Residential', 'Commercial'],
                'professional_services': ['Legal', 'Accounting', 'Consulting', 'HR', 'Marketing'],
                'retail': ['E-commerce', 'Brick & Mortar', 'Wholesale', 'Specialty', 'Grocery'],
            };

            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.id = 'newCampaignModal';
            modal.innerHTML = `
                <div class="new-campaign-modal" onclick="event.stopPropagation()">
                    <div class="ncm-header">
                        <h2>🚀 New Scraping Campaign</h2>
                        <button class="lead-modal-close" id="ncmClose">✕</button>
                    </div>
                    <div class="ncm-body">
                        <div class="form-group">
                            <label>Campaign Name</label>
                            <input type="text" id="ncmName" class="lead-modal-input" placeholder="e.g. Southeast F&B Q1 2026" />
                        </div>

                        <div class="ncm-form-row">
                            <div class="form-group" style="flex:1;">
                                <label>Industry</label>
                                <select id="ncmIndustry" class="lead-modal-select">
                                    <option value="food_beverage">Food & Beverage Manufacturing</option>
                                    <option value="healthcare">Healthcare</option>
                                    <option value="technology">Technology</option>
                                    <option value="construction">Construction</option>
                                    <option value="professional_services">Professional Services</option>
                                    <option value="retail">Retail</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Schedule</label>
                                <select id="ncmSchedule" class="lead-modal-select">
                                    <option value="2">Every 2 hours</option>
                                    <option value="4">Every 4 hours</option>
                                    <option value="6">Every 6 hours</option>
                                    <option value="12" selected>Every 12 hours</option>
                                    <option value="24">Every 24 hours</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Sub-categories</label>
                            <div class="ncm-subcats" id="ncmSubcats">
                                ${(SUB_CATEGORIES['food_beverage'] || []).map(sc =>
                `<label class="ncm-checkbox-label"><input type="checkbox" value="${sc}" />${sc}</label>`
            ).join('')}
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Custom Keywords <small>(comma-separated)</small></label>
                            <textarea id="ncmKeywords" class="lead-modal-textarea" rows="2" placeholder="ERP, food safety, HACCP, automation…"></textarea>
                        </div>

                        <div class="ncm-form-row">
                            <div class="form-group" style="flex:1;">
                                <label>Employees (min)</label>
                                <input type="number" id="ncmEmpMin" class="lead-modal-input" value="20" />
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Employees (max)</label>
                                <input type="number" id="ncmEmpMax" class="lead-modal-input" value="500" />
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Revenue min ($)</label>
                                <input type="number" id="ncmRevMin" class="lead-modal-input" value="1000000" />
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Revenue max ($)</label>
                                <input type="number" id="ncmRevMax" class="lead-modal-input" value="50000000" />
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Regions</label>
                            <div class="ncm-regions" id="ncmRegions">
                                ${Object.entries(US_REGIONS).map(([region, states]) => `
                                    <div class="ncm-region-group">
                                        <label class="ncm-region-header"><input type="checkbox" class="ncm-region-toggle" data-region="${region}" /><strong>${region}</strong></label>
                                        <div class="ncm-state-list">
                                            ${states.map(s => `<label class="ncm-checkbox-label ncm-state-cb"><input type="checkbox" value="${s}" class="ncm-state" data-region="${region}" />${s}</label>`).join('')}
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Cities <small>(comma-separated, optional)</small></label>
                            <input type="text" id="ncmCities" class="lead-modal-input" placeholder="Miami, Atlanta, Nashville…" />
                        </div>

                        <div class="ncm-outreach-section">
                            <h4>📧 Outreach Settings</h4>
                            <div class="ncm-form-row">
                                <div class="form-group" style="flex:1;">
                                    <label>Auto-email</label>
                                    <label class="toggle-switch"><input type="checkbox" id="ncmAutoEmail" checked /><span class="toggle-slider"></span></label>
                                </div>
                                <div class="form-group" style="flex:1;">
                                    <label>Min score for email</label>
                                    <input type="number" id="ncmMinScoreEmail" class="lead-modal-input" value="70" />
                                </div>
                                <div class="form-group" style="flex:1;">
                                    <label>Follow-up days</label>
                                    <select id="ncmFollowUpDays" class="lead-modal-select">
                                        <option value="2">2 days</option>
                                        <option value="3" selected>3 days</option>
                                        <option value="5">5 days</option>
                                        <option value="7">7 days</option>
                                    </select>
                                </div>
                                <div class="form-group" style="flex:1;">
                                    <label>Max emails/lead</label>
                                    <select id="ncmMaxEmails" class="lead-modal-select">
                                        <option value="1">1</option>
                                        <option value="2">2</option>
                                        <option value="3" selected>3</option>
                                        <option value="4">4</option>
                                        <option value="5">5</option>
                                    </select>
                                </div>
                            </div>
                            <div class="ncm-form-row">
                                <div class="form-group" style="flex:1;">
                                    <label>Auto-call</label>
                                    <label class="toggle-switch"><input type="checkbox" id="ncmAutoCall" /><span class="toggle-slider"></span></label>
                                </div>
                                <div class="form-group" style="flex:1;">
                                    <label>Push to GHL</label>
                                    <label class="toggle-switch"><input type="checkbox" id="ncmAutoGHL" /><span class="toggle-slider"></span></label>
                                </div>
                                <div class="form-group" style="flex:1;">
                                    <label>Min score for GHL</label>
                                    <input type="number" id="ncmMinScoreGHL" class="lead-modal-input" value="80" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="ncm-footer">
                        <button class="btn-outline" id="ncmCancelBtn">Cancel</button>
                        <button class="btn-primary" id="ncmDeployBtn" style="margin-top:0; padding:12px 28px;">Deploy Agent 🚀</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Close handlers
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            document.getElementById('ncmClose').addEventListener('click', () => modal.remove());
            document.getElementById('ncmCancelBtn').addEventListener('click', () => modal.remove());

            // Industry change → update sub-categories
            const industrySelect = document.getElementById('ncmIndustry');
            industrySelect.addEventListener('change', () => {
                const subcatsDiv = document.getElementById('ncmSubcats');
                const subs = SUB_CATEGORIES[industrySelect.value] || [];
                subcatsDiv.innerHTML = subs.map(sc =>
                    `<label class="ncm-checkbox-label"><input type="checkbox" value="${sc}" />${sc}</label>`
                ).join('') || '<span style="color:var(--text-muted);font-size:0.85rem;">No sub-categories for this industry</span>';
            });

            // Region toggle → select all states in region
            modal.querySelectorAll('.ncm-region-toggle').forEach(toggle => {
                toggle.addEventListener('change', () => {
                    const region = toggle.dataset.region;
                    const checked = toggle.checked;
                    modal.querySelectorAll(`.ncm-state[data-region="${region}"]`).forEach(cb => { cb.checked = checked; });
                });
            });

            // Deploy button
            document.getElementById('ncmDeployBtn').addEventListener('click', async () => {
                const name = document.getElementById('ncmName').value.trim();
                if (!name) { lgShowToast('Enter a campaign name', 'error'); return; }

                const selectedStates = [...modal.querySelectorAll('.ncm-state:checked')].map(cb => cb.value);
                const selectedSubcats = [...modal.querySelectorAll('#ncmSubcats input:checked')].map(cb => cb.value);

                const campaignData = {
                    name,
                    industry: document.getElementById('ncmIndustry').value,
                    subCategories: selectedSubcats,
                    keywords: document.getElementById('ncmKeywords').value.split(',').map(k => k.trim()).filter(Boolean),
                    employeeRange: {
                        min: parseInt(document.getElementById('ncmEmpMin').value) || 0,
                        max: parseInt(document.getElementById('ncmEmpMax').value) || 99999,
                    },
                    revenueRange: {
                        min: parseInt(document.getElementById('ncmRevMin').value) || 0,
                        max: parseInt(document.getElementById('ncmRevMax').value) || 999999999,
                    },
                    regions: selectedStates,
                    cities: document.getElementById('ncmCities').value.split(',').map(c => c.trim()).filter(Boolean),
                    schedule: parseInt(document.getElementById('ncmSchedule').value),
                    outreach: {
                        autoEmail: document.getElementById('ncmAutoEmail').checked,
                        minScoreEmail: parseInt(document.getElementById('ncmMinScoreEmail').value) || 70,
                        followUpDays: parseInt(document.getElementById('ncmFollowUpDays').value) || 3,
                        maxEmails: parseInt(document.getElementById('ncmMaxEmails').value) || 3,
                        autoCall: document.getElementById('ncmAutoCall').checked,
                        autoGHL: document.getElementById('ncmAutoGHL').checked,
                        minScoreGHL: parseInt(document.getElementById('ncmMinScoreGHL').value) || 80,
                    },
                };

                try {
                    const deployBtn = document.getElementById('ncmDeployBtn');
                    deployBtn.disabled = true;
                    deployBtn.textContent = 'Deploying…';

                    const createRes = await fetch(`${API_BASE}/api/campaigns`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(campaignData),
                    });
                    const created = await createRes.json();
                    const campaignId = created.id || created._id;

                    // Deploy the agent
                    await fetch(`${API_BASE}/api/campaigns/${campaignId}/deploy`, { method: 'POST' });

                    lgShowToast('🚀 Campaign deployed!');
                    modal.remove();
                    fetchCampaigns();
                } catch (err) {
                    lgShowToast('Failed to deploy campaign: ' + (err.message || 'Unknown error'), 'error');
                    const deployBtn = document.getElementById('ncmDeployBtn');
                    if (deployBtn) { deployBtn.disabled = false; deployBtn.textContent = 'Deploy Agent 🚀'; }
                }
            });
        });
    }

    console.log('✅ Scraping Lead Gen module ready');
})();

// ═══════════════════════════════════════════════════════════════════
// ─── TREND ANALYSIS ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
(function () {
    const state = {
        bound: false,
        subtab: 'dashboard',
        bucket: 'all',
        category: 'all',
        platform: 'all',
        sort: 'performance',
        candidates: [],
        health: null,
        dismissed: new Set(),
        generations: [],
        queueStatus: 'all',
        queueOutput: 'all',
        recreating: new Set(),
        analyzing: new Set(),
        expandedAnalysis: new Set(),
        report: null,
    };

    const tApi = (path) => `${typeof API_BASE !== 'undefined' ? API_BASE : ''}${path}`;
    const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t); };

    function fmtNum(n) {
        if (n === null || n === undefined) return '—';
        const v = Number(n);
        if (isNaN(v)) return '—';
        if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(v);
    }

    function ageStr(iso) {
        if (!iso) return '—';
        const ms = Date.now() - new Date(iso).getTime();
        if (isNaN(ms)) return '—';
        const h = ms / 3.6e6;
        if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
        if (h < 24) return Math.round(h) + 'h';
        return Math.round(h / 24) + 'd';
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const PLATFORM_GLYPH = { tiktok: '🎵', instagram: '📸', youtube: '▶' };

    const CATEGORY_META = {
        companies: { label: '🏢 Companies', cls: 'cat-companies' },
        food: { label: '🍔 Food', cls: 'cat-food' },
        oil: { label: '🛢️ Oil & gas', cls: 'cat-oil' },
    };
    function catMeta(cat) { return CATEGORY_META[cat] || CATEGORY_META.companies; }

    const PLATFORM_META = {
        tiktok: { label: '🎵 TikTok', cls: 'plat-tiktok' },
        instagram: { label: '📸 Instagram Reels', cls: 'plat-instagram' },
        youtube: { label: '▶️ YouTube Shorts', cls: 'plat-youtube' },
    };
    function platMeta(p) { return PLATFORM_META[p] || { label: p || '—', cls: '' }; }

    function bucketMeta(bucket) {
        switch (bucket) {
            case 'trendjack': return { cls: 'trend-bucket-trendjack', label: 'Trendjack' };
            case 'clone_format': return { cls: 'trend-bucket-clone', label: 'Clone format' };
            case 'discard': return { cls: 'trend-bucket-discard', label: 'Discard' };
            default: return { cls: 'trend-bucket-unscored', label: 'Unscored' };
        }
    }

    async function loadHealth() {
        const dbPill = document.getElementById('trendDbPill');
        const edPill = document.getElementById('trendEdPill');
        const meta = document.getElementById('trendStatusMeta');
        try {
            const res = await fetch(tApi('/api/trends/health'));
            const h = await res.json();
            state.health = h;

            const dbOk = h.db && h.db.ok;
            dbPill.className = 'trend-status-pill ' + (dbOk ? 'ok' : 'off');
            dbPill.innerHTML = `<span class="trend-dot"></span> Database: ${dbOk ? 'connected' : (h.db && h.db.configured ? 'error' : 'not configured')}`;

            const ingest = h.ingest || {};
            const provider = ingest.provider;
            const platforms = Array.isArray(ingest.platforms) ? ingest.platforms : [];
            const providerLabel = provider === 'apify'
                ? `Apify: ${platforms.join(', ') || 'ready'}`
                : provider === 'ensembledata'
                    ? 'EnsembleData: TikTok'
                    : 'Ingest: no provider';
            edPill.className = 'trend-status-pill ' + (provider ? 'ok' : 'off');
            edPill.innerHTML = `<span class="trend-dot"></span> ${esc(providerLabel)}`;

            if (meta) {
                const seeds = (h.seedHashtags || []).length;
                meta.textContent = `${seeds} seed hashtags · surface threshold ${h.surfaceThreshold ?? '—'}`;
            }
            renderKeywordChips(h);
            return h;
        } catch (err) {
            dbPill.className = 'trend-status-pill off';
            dbPill.innerHTML = '<span class="trend-dot"></span> Database: unreachable';
            edPill.className = 'trend-status-pill off';
            edPill.innerHTML = '<span class="trend-dot"></span> EnsembleData: unknown';
            return null;
        }
    }

    function renderKeywordChips(h) {
        const wrap = document.getElementById('trendKeywordChips');
        if (!wrap) return;
        const kws = (h && h.topicKeywords) || [
            'FSMA 204', 'food traceability', 'recall', 'cold chain', 'supply chain disruption',
            'food and beverage demand', 'inventory shrink', 'plant downtime',
            'oil and gas operations', 'cross-border logistics',
        ];
        wrap.innerHTML = kws.map((k) => `<span class="trend-keyword-chip">${esc(k)}</span>`).join('');
    }

    function markRoadmap() {
        // Steps 1–8 are now built; posting is manual (auto-post to TikTok needs
        // the platform API + OAuth, out of scope), so step 7 stays "current".
        const done = [1, 2, 3, 4, 5, 6, 8];
        const current = [7];
        document.querySelectorAll('#trendRoadmap li').forEach((li) => {
            const step = parseInt(li.dataset.step);
            li.classList.toggle('done', done.includes(step));
            li.classList.toggle('current', current.includes(step));
        });
    }

    async function loadCandidates() {
        const setup = document.getElementById('trendSetup');
        const empty = document.getElementById('trendEmpty');
        const loading = document.getElementById('trendLoading');
        const cards = document.getElementById('trendCards');
        const discard = document.getElementById('trendCardsDiscard');
        const divider = document.getElementById('trendDiscardDivider');

        setup.style.display = 'none';
        empty.style.display = 'none';
        cards.innerHTML = '';
        discard.innerHTML = '';
        divider.style.display = 'none';

        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) {
            setup.style.display = '';
            updateStats([]);
            return;
        }

        loading.style.display = '';
        try {
            const res = await fetch(tApi('/api/trends/candidates?limit=1000'));
            if (!res.ok) throw new Error('Failed to load candidates');
            state.candidates = await res.json();
        } catch (err) {
            state.candidates = [];
            toast('Could not load candidates', 'error');
        } finally {
            loading.style.display = 'none';
        }

        updateStats(state.candidates);

        if (!state.candidates.length) {
            empty.style.display = '';
            return;
        }
        renderCandidates();
    }

    // Performance score (0..1), no LLM needed. Rewards absolute reach, breakout
    // (views >> followers), momentum, and real engagement — so "very high views"
    // and "high views from a small account" both float to the top, junk sinks.
    function perfScore(c) {
        const views = Number(c.play_count) || 0;
        const ratio = Number(c.baseline_ratio) || 0;          // views / followers
        const vel = Number(c.velocity) || 0;                  // plays / hour
        const eng = views > 0 ? ((Number(c.like_count) || 0) + (Number(c.comment_count) || 0)) / views : 0;
        const viewsN = views > 0 ? Math.min(Math.log10(views) / 7, 1) : 0; // 10M -> 1
        const breakoutN = Math.min(ratio / 100, 1);           // 100x -> 1
        const velN = Math.min(vel / 100000, 1);
        const engN = Math.min(eng / 0.1, 1);                  // 10% -> 1
        return 0.5 * viewsN + 0.3 * breakoutN + 0.12 * velN + 0.08 * engN;
    }

    function updateStats(list) {
        const surfaced = list.filter((c) => Number(c.composite_score) >= (state.health?.surfaceThreshold ?? 0.6));
        const scored = list.filter((c) => c.composite_score != null);
        const snaps = list.reduce((a, c) => a + (Number(c.snapshot_count) || 0), 0);
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('trendStatCandidates', list.length);
        set('trendStatSurfaced', surfaced.length);
        set('trendStatSnapshots', fmtNum(snaps));
        set('trendStatScored', scored.length);
    }

    function renderCandidates() {
        const cards = document.getElementById('trendCards');
        const discardWrap = document.getElementById('trendCardsDiscard');
        const divider = document.getElementById('trendDiscardDivider');

        updateCategoryCounts();

        let list = state.candidates.filter((c) => !state.dismissed.has(c.id));

        if (state.bucket !== 'all') {
            list = list.filter((c) => (c.bucket || 'unscored') === state.bucket);
        }

        if (state.category !== 'all') {
            list = list.filter((c) => (c.category || 'companies') === state.category);
        }

        if (state.platform !== 'all') {
            list = list.filter((c) => c.platform === state.platform);
        }

        const num = (v) => Number(v) || 0;
        list.sort((a, b) => {
            if (state.sort === 'performance') return perfScore(b) - perfScore(a);
            if (state.sort === 'views') return num(b.play_count) - num(a.play_count);
            if (state.sort === 'breakout') return num(b.baseline_ratio) - num(a.baseline_ratio);
            if (state.sort === 'likes') return num(b.like_count) - num(a.like_count);
            if (state.sort === 'comments') return num(b.comment_count) - num(a.comment_count);
            if (state.sort === 'snapshots') return num(b.snapshot_count) - num(a.snapshot_count);
            if (state.sort === 'recent') return new Date(b.first_seen_at) - new Date(a.first_seen_at);
            // composite: scored desc, then performance
            const cs = (Number(b.composite_score) || -1) - (Number(a.composite_score) || -1);
            if (cs !== 0) return cs;
            return perfScore(b) - perfScore(a);
        });

        // No more "below threshold" pile — a weak video just carries a low
        // score and sorts to the bottom. Everything renders in one grid.
        cards.innerHTML = list.map(buildCard).join('');
        if (discardWrap) discardWrap.innerHTML = '';
        if (divider) divider.style.display = 'none';

        bindCardActions();
    }

    // Show how many candidates fall in each industry / platform on the chips.
    function setChipCounts(selector, key, dataAttr) {
        const live = state.candidates.filter((c) => !state.dismissed.has(c.id));
        const counts = { all: live.length };
        for (const c of live) {
            const v = c[key] || (key === 'category' ? 'companies' : '');
            counts[v] = (counts[v] || 0) + 1;
        }
        document.querySelectorAll(selector).forEach((chip) => {
            const k = chip.dataset[dataAttr];
            let n = chip.querySelector('.trend-cat-count');
            if (!n) {
                n = document.createElement('span');
                n.className = 'trend-cat-count';
                chip.appendChild(n);
            }
            n.textContent = counts[k] != null ? counts[k] : 0;
        });
    }
    function updateCategoryCounts() {
        setChipCounts('#trendCategoryFilter .trend-cat-chip', 'category', 'category');
        setChipCounts('#trendPlatformFilter .trend-cat-chip', 'platform', 'platform');
    }

    function metricChip(label, value) {
        if (value == null) return '';
        return `<span class="trend-metric-chip"><b>${value}</b> ${label}</span>`;
    }

    function parseAnalysis(a) {
        if (!a) return null;
        if (typeof a === 'object') return a;
        try { return JSON.parse(a); } catch { return null; }
    }

    // Collapsible deep-analysis panel rendered inside the card once a video
    // has been analyzed (frames + on-screen text + audio transcript + sound).
    function analysisPanel(c) {
        const a = parseAnalysis(c.analysis);
        if (!a) return '';
        const open = state.expandedAnalysis.has(c.id);
        const list = (arr) => (Array.isArray(arr) && arr.length)
            ? `<ul class="trend-an-list">${arr.slice(0, 8).map((x) => `<li>${esc(String(x))}</li>`).join('')}</ul>`
            : '<span class="trend-an-empty">—</span>';
        const row = (label, val) => val ? `<div class="trend-an-row"><span class="trend-an-k">${label}</span><span class="trend-an-v">${esc(String(val))}</span></div>` : '';
        const body = open ? `
          <div class="trend-an-body">
            ${row('Hook', a.hook)}
            ${row('Format', a.format)}
            ${row('Pacing', a.pacing)}
            ${row('Sound', a.sound)}
            <div class="trend-an-block"><span class="trend-an-k">On-screen text</span>${list(a.onScreenText)}</div>
            ${a.transcript ? `<div class="trend-an-block"><span class="trend-an-k">Transcript</span><p class="trend-an-tx">${esc(a.transcript)}</p></div>` : ''}
            <div class="trend-an-block"><span class="trend-an-k">Visual beats</span>${list(a.visualBreakdown)}</div>
            <div class="trend-an-block"><span class="trend-an-k">Why it works</span>${list(a.whyItWorks)}</div>
            ${row('CeleriTech angle', a.celeritechAngle)}
          </div>` : '';
        return `
        <div class="trend-analysis ${open ? 'open' : ''}">
          <button class="trend-an-toggle" data-analysis-toggle="${esc(c.id)}">
            <span>🎬 Video analysis${a.format ? ' · ' + esc(a.format) : ''}</span>
            <span class="trend-an-chev">${open ? '▲' : '▼'}</span>
          </button>
          ${a.summary ? `<div class="trend-an-summary">${esc(a.summary)}</div>` : ''}
          ${body}
        </div>`;
    }

    function buildCard(c) {
        const bm = bucketMeta(c.bucket);
        const glyph = PLATFORM_GLYPH[c.platform] || '🎬';
        const fit = c.bridge_score != null ? Number(c.bridge_score) : null;
        const fitPct = fit != null ? Math.max(0, Math.min(10, fit)) * 10 : 0;
        const author = c.author_id ? `@${esc(c.author_id)}` : 'unknown';
        const followers = c.author_followers != null ? `${fmtNum(c.author_followers)} followers` : '';
        const scored = c.composite_score != null;
        const composite = scored ? Number(c.composite_score) : null;
        const isRecreating = state.recreating.has(c.id);
        const isAnalyzing = state.analyzing.has(c.id);
        const hasAnalysis = !!parseAnalysis(c.analysis);

        // derived metrics (step 2)
        const velocity = c.velocity != null ? `${fmtNum(Math.round(Number(c.velocity)))}/h` : null;
        const baseline = c.baseline_ratio != null ? `${Number(c.baseline_ratio).toFixed(1)}x` : null;

        // generation linkage (step 6)
        const genStatus = c.gen_status || null;
        let recreateLabel = 'Recreate';
        if (isRecreating) recreateLabel = 'Working…';
        else if (['directed', 'imaging', 'qc', 'animating', 'rendering', 'assembling'].includes(genStatus)) recreateLabel = 'In progress…';
        else if (genStatus && ['review', 'approved', 'posted'].includes(genStatus)) recreateLabel = 'Recreate again';

        // YouTube (i.ytimg.com) serves directly; Instagram/TikTok CDNs block
        // hotlinking, so route those through our referer-setting image proxy.
        const thumbSrc = c.thumbnail
            ? (c.platform === 'youtube' ? c.thumbnail : `/api/trends/thumb?u=${encodeURIComponent(c.thumbnail)}`)
            : '';
        const thumb = thumbSrc
            ? `<img class="trend-card-thumb" src="${esc(thumbSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
            : '';
        return `
        <div class="trend-card" data-id="${esc(c.id)}">
          <a class="trend-card-media" href="${esc(c.url)}" target="_blank" rel="noopener" title="Open original video">
            ${thumb}
            <span class="trend-platform-glyph">${glyph}</span>
            <span class="trend-card-play" aria-hidden="true">▶</span>
            <span class="trend-card-bucket ${bm.cls}">${bm.label}</span>
            <span class="trend-card-age">${ageStr(c.created_at)}</span>
            ${composite != null ? `<span class="trend-card-composite" title="Composite score">${composite.toFixed(2)}</span>` : ''}
          </a>
          <div class="trend-card-body">
            <div class="trend-card-author">
              <span>${author}${followers ? ' · ' + followers : ''}</span>
              <span class="trend-cat-badge ${catMeta(c.category).cls}">${catMeta(c.category).label}</span>
            </div>
            <div class="trend-card-caption">${esc(c.caption) || '<span style="color:var(--text-muted)">No caption</span>'}</div>
            <div class="trend-card-statbar">
              <div><b>${fmtNum(c.play_count)}</b><span>Views</span></div>
              <div><b>${fmtNum(c.like_count)}</b><span>Likes</span></div>
              <div><b>${fmtNum(c.comment_count)}</b><span>Comments</span></div>
              <div><b>${fmtNum(c.snapshot_count)}</b><span>Snaps</span></div>
            </div>
            ${(velocity || baseline) ? `<div class="trend-metric-row">${metricChip('velocity', velocity)}${metricChip('vs baseline', baseline)}</div>` : ''}
            <div class="trend-fit">
              <div class="trend-fit-head"><span>CeleriTech fit</span><span>${fit != null ? fit.toFixed(1) + '/10' : '—'}</span></div>
              <div class="trend-fit-track"><div class="trend-fit-fill" style="width:${fitPct}%"></div></div>
            </div>
            <div class="trend-bridge ${scored ? '' : 'pending'}">${scored ? (esc(c.bridge_line || '') || '<span style="color:var(--text-muted)">No bridge line</span>') : 'Not scored yet — hit Score'}</div>
            ${analysisPanel(c)}
            <div class="trend-card-actions">
              <button class="trend-btn-analyze" data-analyze="${esc(c.id)}" ${isAnalyzing ? 'disabled' : ''} title="Analyze the video: frames, on-screen text, audio">
                ${isAnalyzing ? '<span class="spinner" style="width:12px;height:12px;"></span> Analyzing…' : (hasAnalysis ? '↻ Re-analyze' : '🔍 Analyze video')}
              </button>
              <button class="trend-btn-recreate" data-recreate="${esc(c.id)}" ${isRecreating ? 'disabled' : ''} title="Remake this video for a product (image-first chain)">
                ${isRecreating ? '<span class="spinner" style="border-color:rgba(255,255,255,0.4);border-top-color:#fff;width:13px;height:13px;"></span> ' : ''}${recreateLabel}
              </button>
              <button class="trend-btn-dismiss" data-dismiss="${esc(c.id)}" title="Dismiss">✕</button>
              <a class="trend-btn-dismiss" href="${esc(c.url)}" target="_blank" rel="noopener" title="Open source" style="text-decoration:none;">↗</a>
            </div>
          </div>
        </div>`;
    }

    function bindCardActions() {
        document.querySelectorAll('#pageTrends [data-dismiss]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.dismissed.add(btn.dataset.dismiss);
                renderCandidates();
                toast('Dismissed from feed');
            });
        });
        document.querySelectorAll('#pageTrends [data-recreate]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                recreate(btn.dataset.recreate);
            });
        });
        document.querySelectorAll('#pageTrends [data-analyze]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                analyzeVideo(btn.dataset.analyze);
            });
        });
        document.querySelectorAll('#pageTrends [data-analysis-toggle]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.analysisToggle;
                if (state.expandedAnalysis.has(id)) state.expandedAnalysis.delete(id);
                else state.expandedAnalysis.add(id);
                renderCandidates();
            });
        });
    }

    // ─── Deep video analysis (frames + on-screen text + audio) ──────
    async function analyzeVideo(candidateId) {
        if (state.analyzing.has(candidateId)) return;
        state.analyzing.add(candidateId);
        renderCandidates();
        try {
            const res = await fetch(tApi(`/api/trends/candidates/${candidateId}/analyze`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            const data = await res.json();
            if (!res.ok) {
                toast(data.error || 'Analysis failed', 'error');
                return;
            }
            // Patch the candidate in place and auto-expand the panel.
            const c = state.candidates.find((x) => x.id === candidateId);
            if (c) c.analysis = data.analysis;
            state.expandedAnalysis.add(candidateId);
            toast('Video analyzed', 'success');
        } catch (err) {
            toast('Analysis failed: ' + err.message, 'error');
        } finally {
            state.analyzing.delete(candidateId);
            renderCandidates();
        }
    }

    // ─── Recreate: image-first remake chain (Director → Image → QC) ──
    async function recreate(candidateId) {
        if (state.recreating.has(candidateId)) return;

        // Make sure the product list is available for the dialog.
        if (Array.isArray(solState.items) && !solState.items.length) {
            try { await loadSolutions(); } catch { /* auto mode still works */ }
        }

        // Choose the target (product / custom / auto) before kicking off.
        const target = await openRemakeDialog(candidateId);
        if (!target) return; // cancelled

        state.recreating.add(candidateId);
        renderCandidates();
        switchSubtab('queue');
        try {
            // 1) Director — analyze the source (timing + structure) and build the
            //    shot plan retargeted to the chosen target. Auto-analyze can take
            //    a moment for a never-analyzed video.
            toast('Analyzing the source and directing the remake…');
            const dres = await fetch(tApi(`/api/trends/candidates/${candidateId}/direct`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(target),
            });
            const ddata = await dres.json();
            if (!dres.ok) { toast(ddata.error || 'Director failed', 'error'); return; }
            const genId = ddata.generationId;
            await loadGenerations();
            const isSlideshow = (target.output_type === 'slideshow') || (ddata.plan?.output_type === 'slideshow');
            const planLen = ddata.plan?.target_duration_total;
            const lenNote = planLen ? `, ~${Math.round(planLen)}s to match the source` : '';
            const unit = isSlideshow ? 'slides' : 'shots';
            toast(`${isSlideshow ? 'Slide' : 'Shot'} plan ready (${ddata.plan?.shots?.length || 0} ${unit}${isSlideshow ? '' : lenNote}). Rendering images…`);

            // 2) Image agent — render every shot (image-first).
            const ires = await fetch(tApi(`/api/trends/generations/${genId}/images`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            const idata = await ires.json();
            await loadGenerations();
            if (!ires.ok) { toast(idata.error || 'Image render failed', 'error'); return; }
            toast(`Rendered ${idata.made || 0}/${idata.total || 0} images. Running QC…`);

            // 3) QC gate — grade + improve-loop. Non-fatal if it hiccups.
            try {
                const qres = await fetch(tApi(`/api/trends/generations/${genId}/qc`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                const qdata = await qres.json();
                await loadGenerations();
                if (qres.ok) { const m = qcMessage(qdata, isSlideshow ? ' Composing slides…' : ' Writing motion…'); toast(m.text, m.kind); }
                else toast('QC will retry — images are ready to view', 'info');
            } catch {
                toast('Images ready — QC can be re-run from the Queue', 'info');
            }

            // Slideshow branch: skip motion/animation — write copy, then compose
            // the photo carousel + reel directly from the stills.
            if (isSlideshow) {
                try {
                    await fetch(tApi(`/api/trends/generations/${genId}/copy`), {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                    });
                } catch { /* slides still compose without captions */ }
                toast('Composing the slideshow…');
                const sres = await fetch(tApi(`/api/trends/generations/${genId}/slides`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                const sdata = await sres.json();
                await loadGenerations();
                if (sres.ok && sdata.asset_url) toast(`Slideshow ready (${sdata.slides || 0} slides).`, 'success');
                else toast(sdata.error || 'Slides will retry — images are ready in the Queue', 'info');
                return;
            }

            // 4) Motion agent — write a camera/subject motion prompt per shot.
            try {
                await fetch(tApi(`/api/trends/generations/${genId}/motion`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
            } catch { /* video agent falls back to motion_intent */ }

            // 5) Video agent — animate stills into clips. Staged + resumable, so
            // call repeatedly until every shot has a clip (status leaves 'animating').
            toast('Animating shots into clips…');
            const ranVideo = await runVideoLoop(genId);
            await loadGenerations();
            if (!ranVideo.done) {
                toast(ranVideo.message || 'Clips still rendering — resume from the Queue', 'info');
                return;
            }
            toast('All clips rendered. Writing voiceover and captions…');

            // 6) Copy agent — voiceover + per-platform captions/hashtags.
            try {
                await fetch(tApi(`/api/trends/generations/${genId}/copy`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
            } catch { /* assembly produces a silent cut if copy is missing */ }

            // 7) Assembly — stitch clips + VO into the final cut.
            toast('Assembling the final video…');
            const ares = await fetch(tApi(`/api/trends/generations/${genId}/assemble`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            const adata = await ares.json();
            await loadGenerations();
            if (ares.ok && adata.asset_url) toast('Final video ready for review.', 'success');
            else toast(adata.error || 'Assembly will retry — clips are ready in the Queue', 'info');
        } catch (err) {
            toast('Recreate failed: ' + err.message, 'error');
        } finally {
            state.recreating.delete(candidateId);
            renderCandidates();
        }
    }

    // Drive the staged Video agent to completion. Each call animates up to a
    // couple of shots and may leave some still rendering on Higgsfield; we loop
    // until all shots have a clip or we stop making progress.
    async function runVideoLoop(genId, { maxCalls = 12 } = {}) {
        let lastMade = -1, stalls = 0;
        for (let i = 0; i < maxCalls; i++) {
            let data;
            try {
                const res = await fetch(tApi(`/api/trends/generations/${genId}/video`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max: 2 }),
                });
                data = await res.json();
                if (!res.ok) return { done: false, message: data.error };
            } catch (err) {
                return { done: false, message: err.message };
            }
            await loadGenerations();
            if (data.status === 'assembling') return { done: true };
            const progress = (data.made || 0) + (data.pending || 0);
            if (progress <= lastMade) { stalls++; } else { stalls = 0; }
            lastMade = progress;
            if (stalls >= 3) return { done: false, message: 'Some clips are still rendering — resume from the Queue' };
            toast(`Clips: ${data.made || 0} done, ${data.pending || 0} rendering…`);
            await new Promise((r) => setTimeout(r, 3000));
        }
        return { done: false, message: 'Clips are taking a while — resume from the Queue' };
    }

    // Small modal to pick the remake target: product / custom / auto.
    function openRemakeDialog(candidateId) {
        return new Promise((resolve) => {
            const products = (typeof solState !== 'undefined' && Array.isArray(solState.items)) ? solState.items : [];
            const sel = selectedSolutionId();
            const opts = products.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
            const overlay = document.createElement('div');
            overlay.className = 'remake-overlay';
            overlay.innerHTML = `
              <div class="remake-modal" role="dialog" aria-modal="true">
                <h3>Recreate this video</h3>
                <p class="remake-sub">Image-first remake — same structure, hook, angle and format. Recreate it exactly, fit it to a product, or follow your own prompt.</p>
                <div class="remake-output">
                  <button type="button" class="remake-out-btn active" data-out="video">🎬 Video</button>
                  <button type="button" class="remake-out-btn" data-out="slideshow">🖼️ Slideshow</button>
                </div>
                <label class="remake-mode"><input type="radio" name="rmode" value="exact" checked> <span><b>Exact recreation</b> — remake the original as-is (no product)</span></label>
                <label class="remake-mode"><input type="radio" name="rmode" value="product" ${products.length ? '' : 'disabled'}> <span><b>Product</b> — fit it to a product, same structure/angle/format${products.length ? '' : ' (none added yet)'}</span></label>
                <select class="remake-product" disabled>${opts || '<option>No products</option>'}</select>
                <label class="remake-mode"><input type="radio" name="rmode" value="custom"> <span><b>Custom</b> — follow your own prompt/angle</span></label>
                <textarea class="remake-custom" rows="3" placeholder="e.g. Show how a small bakery avoids stockouts" disabled></textarea>
                <label class="remake-mode"><input type="radio" name="rmode" value="auto"> <span><b>Auto</b> — let the system pick the best product to feature</span></label>
                <div class="remake-actions">
                  <button class="btn-ghost" data-remake-cancel>Cancel</button>
                  <button class="trend-btn-recreate" data-remake-go>Generate</button>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            const productSel = overlay.querySelector('.remake-product');
            const customTa = overlay.querySelector('.remake-custom');
            let outputType = 'video';
            overlay.querySelectorAll('.remake-out-btn').forEach((b) => b.addEventListener('click', () => {
                outputType = b.dataset.out;
                overlay.querySelectorAll('.remake-out-btn').forEach((x) => x.classList.toggle('active', x === b));
            }));
            overlay.querySelectorAll('input[name="rmode"]').forEach((r) => r.addEventListener('change', () => {
                const mode = overlay.querySelector('input[name="rmode"]:checked').value;
                productSel.disabled = mode !== 'product';
                customTa.disabled = mode !== 'custom';
            }));
            const close = (val) => { overlay.remove(); resolve(val); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
            overlay.querySelector('[data-remake-cancel]').addEventListener('click', () => close(null));
            overlay.querySelector('[data-remake-go]').addEventListener('click', () => {
                const mode = overlay.querySelector('input[name="rmode"]:checked').value;
                if (mode === 'product') {
                    const pid = productSel.value;
                    if (!pid) { toast('Pick a product', 'error'); return; }
                    setSelectedSolution(pid);
                    close({ target_mode: 'product', product_id: pid, output_type: outputType });
                } else if (mode === 'custom') {
                    const txt = customTa.value.trim();
                    if (!txt) { toast('Type a custom angle', 'error'); return; }
                    close({ target_mode: 'custom', custom_prompt: txt, output_type: outputType });
                } else if (mode === 'auto') {
                    close({ target_mode: 'auto', output_type: outputType });
                } else {
                    close({ target_mode: 'exact', output_type: outputType });
                }
            });
        });
    }

    async function runIngest() {
        const btn = document.getElementById('trendIngestBtn');
        if (!btn) return;
        const orig = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,0.4);border-top-color:#fff;"></span> Ingesting…';
        try {
            const res = await fetch(tApi('/api/trends/ingest'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            if (!res.ok) {
                toast(data.error || 'Ingest unavailable', 'error');
            } else if ((data.totalCandidates || 0) === 0 && Array.isArray(data.errors) && data.errors.length) {
                // Every hashtag failed — surface the real reason instead of a
                // misleading "0 candidates" success message.
                const first = data.errors[0].error || '';
                const quota = /HTTP 495|Maximum requests limit/i.test(first);
                toast(
                    quota
                        ? 'EnsembleData daily quota reached. It resets at 00:00 UTC — try again then or upgrade the plan.'
                        : `Ingest failed: ${first.slice(0, 140)}`,
                    'error'
                );
            } else {
                toast(`Ingest complete: ${data.totalCandidates || 0} candidates, ${data.totalSnapshots || 0} snapshots`);
                await loadHealth();
                await loadCandidates();
            }
        } catch (err) {
            toast('Ingest failed: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = orig;
        }
    }

    function switchSubtab(name) {
        console.log('[trends-debug] switchSubtab called with', name);
        state.subtab = name;
        document.querySelectorAll('#pageTrends .trend-subtab').forEach((t) => {
            const sel = t.dataset.subtab === name;
            t.classList.toggle('active', sel);
            t.setAttribute('aria-selected', sel ? 'true' : 'false');
        });
        const panels = {
            dashboard: 'trendPanelDashboard',
            autopilot: 'trendPanelAutopilot',
            insights: 'trendPanelInsights',
            queue: 'trendPanelQueue',
            solutions: 'trendPanelSolutions',
            topics: 'trendPanelTopics',
            roadmap: 'trendPanelRoadmap',
        };
        Object.entries(panels).forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.style.display = key === name ? '' : 'none';
        });
        if (name === 'solutions') loadSolutions();
        if (name === 'queue') loadGenerations();
        if (name === 'topics') loadTopics();
        if (name === 'insights') loadReport();
        if (name === 'autopilot') loadAutopilot();
    }

    // ─── Autopilot (autonomous daily generation) ────────────────
    // Two parallel agents share the same UI logic, keyed by `agent`:
    //   • default → Trend Autopilot (fits viral concepts to a product/brand)
    //   • ownpage → Instagram Autopilot (retargets concepts to our IG content)
    const AP_AGENTS = {
        default: {
            agent: 'default',
            hasTargetMode: true,
            ids: { toggle: 'apEnabledToggle', label: 'apEnabledLabel', daily: 'apDailyCount',
                output: 'apOutputType', mode: 'apTargetMode', min: 'apMinScore',
                cooldown: 'apCooldown', autoPublish: 'apAutoPublish', save: 'apSaveBtn', run: 'apRunBtn', feed: 'apFeed' },
        },
        ownpage: {
            agent: 'ownpage',
            hasTargetMode: false,
            ids: { toggle: 'ap2EnabledToggle', label: 'ap2EnabledLabel', daily: 'ap2DailyCount',
                output: 'ap2OutputType', mode: null, min: 'ap2MinScore',
                cooldown: 'ap2Cooldown', autoPublish: 'ap2AutoPublish', save: 'ap2SaveBtn', run: 'ap2RunBtn', feed: 'ap2Feed' },
        },
    };

    function setApEnabledUI(cfg, on) {
        const t = document.getElementById(cfg.ids.toggle);
        const lbl = document.getElementById(cfg.ids.label);
        if (t) t.checked = !!on;
        if (lbl) lbl.textContent = on ? 'On' : 'Off';
    }

    async function loadAutopilotAgent(cfg) {
        try {
            const res = await fetch(tApi(`/api/trends/autopilot?agent=${cfg.agent}`));
            if (!res.ok) throw new Error('load failed');
            const data = await res.json();
            const s = data.settings || {};
            setApEnabledUI(cfg, s.enabled);
            const set = (id, v) => { if (!id) return; const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
            set(cfg.ids.daily, s.dailyCount);
            set(cfg.ids.output, s.outputType);
            if (cfg.hasTargetMode) set(cfg.ids.mode, s.targetMode);
            set(cfg.ids.min, s.minScore);
            set(cfg.ids.cooldown, s.cooldownDays);
            const apEl = document.getElementById(cfg.ids.autoPublish);
            if (apEl) apEl.checked = !!s.autoPublish;
            renderAutopilotRuns(cfg, data.runs || []);
        } catch {
            toast('Could not load Autopilot', 'error');
        }
    }

    async function loadAutopilot() {
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) return;
        await Promise.all(Object.values(AP_AGENTS).map(loadAutopilotAgent));
    }

    function apSettingsFromUI(cfg) {
        const val = (id) => (id ? document.getElementById(id)?.value : undefined);
        const out = {
            agent: cfg.agent,
            enabled: !!document.getElementById(cfg.ids.toggle)?.checked,
            dailyCount: parseInt(val(cfg.ids.daily), 10) || 3,
            outputType: val(cfg.ids.output) || 'mix',
            minScore: parseFloat(val(cfg.ids.min)) || 0,
            cooldownDays: parseInt(val(cfg.ids.cooldown), 10) || 0,
            autoPublish: !!document.getElementById(cfg.ids.autoPublish)?.checked,
        };
        if (cfg.hasTargetMode) out.targetMode = val(cfg.ids.mode) || 'auto';
        return out;
    }

    async function saveAutopilotSettings(cfg) {
        try {
            const res = await fetch(tApi('/api/trends/autopilot/settings'), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(apSettingsFromUI(cfg)),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Save failed', 'error'); return; }
            setApEnabledUI(cfg, data.settings?.enabled);
            const name = cfg.agent === 'ownpage' ? 'Instagram Autopilot' : 'Autopilot';
            toast(data.settings?.enabled ? `${name} is ON — it will run daily` : `Settings saved (${name} is off)`, 'success');
        } catch (err) {
            toast('Save failed: ' + err.message, 'error');
        }
    }

    async function runAutopilotNow(cfg) {
        const btn = document.getElementById(cfg.ids.run);
        const orig = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
        try {
            // Persist current settings first so a manual run honors the latest UI.
            await fetch(tApi('/api/trends/autopilot/settings'), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apSettingsFromUI(cfg)),
            }).catch(() => {});
            const res = await fetch(tApi('/api/trends/autopilot/run'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent: cfg.agent }),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Run failed', 'error'); return; }
            toast(data.made ? `Autopilot started ${data.made} remake${data.made > 1 ? 's' : ''} — see the Queue` : (data.notes || 'No eligible candidates right now'), data.made ? 'success' : 'info');
            await loadAutopilotAgent(cfg);
        } catch (err) {
            toast('Run failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    function renderAutopilotRuns(cfg, runs) {
        const feed = document.getElementById(cfg.ids.feed);
        if (!feed) return;
        if (!runs.length) {
            feed.innerHTML = '<div class="trend-empty-inline">No runs yet. Turn Autopilot on, or hit “Run now” to test it.</div>';
            return;
        }
        feed.innerHTML = runs.map((r) => {
            let picked = [];
            try { picked = typeof r.picked === 'string' ? JSON.parse(r.picked) : (r.picked || []); } catch { picked = []; }
            const when = r.started_at ? new Date(r.started_at).toLocaleString() : '';
            const statusCls = r.status === 'done' ? 'ok' : r.status === 'error' ? 'bad' : 'wait';
            const items = picked.map((p) => `
              <div class="ap-pick">
                <span class="ap-pick-badge">${p.output_type === 'slideshow' ? '🖼️' : '🎬'}</span>
                <div class="ap-pick-body">
                  <div class="ap-pick-title">${esc(p.title || 'Remake')}</div>
                  <div class="ap-pick-reason">${p.error ? '⚠ ' + esc(p.error) : 'Picked because: ' + esc(p.reason || '')}</div>
                </div>
                ${p.generation_id ? `<button class="btn-ghost ap-pick-link" data-ap-gen="${esc(p.generation_id)}">View →</button>` : ''}
              </div>`).join('');
            return `
              <div class="ap-run">
                <div class="ap-run-head">
                  <span class="ap-run-status ${statusCls}">${esc(r.status)}</span>
                  <span class="ap-run-when">${esc(when)}</span>
                  <span class="ap-run-trigger">${esc(r.trigger || '')}</span>
                </div>
                ${r.notes ? `<div class="ap-run-notes">${esc(r.notes)}</div>` : ''}
                ${r.error ? `<div class="trend-gen-error">${esc(r.error)}</div>` : ''}
                ${items ? `<div class="ap-picks">${items}</div>` : ''}
              </div>`;
        }).join('');
        feed.querySelectorAll('[data-ap-gen]').forEach((b) =>
            b.addEventListener('click', () => { switchSubtab('queue'); }));
    }

    // ─── Weekly trend report (intelligence) ─────────────────────
    function confBadge(conf) {
        const c = String(conf || '').toLowerCase();
        const map = {
            high: { cls: 'conf-high', label: 'High confidence' },
            medium: { cls: 'conf-medium', label: 'Medium confidence' },
            low: { cls: 'conf-low', label: 'Low confidence' },
            building: { cls: 'conf-building', label: 'Building baseline' },
        };
        const m = map[c] || map.building;
        return `<span class="insights-conf-badge ${m.cls}">${m.label}</span>`;
    }

    function growthStr(g) {
        const v = Number(g) || 0;
        const p = Math.round(v * 100);
        if (p > 0) return `<span class="ins-up">▲ ${p}%</span>`;
        if (p < 0) return `<span class="ins-down">▼ ${Math.abs(p)}%</span>`;
        return `<span class="ins-flat">—</span>`;
    }

    async function loadReport(forceGenerate) {
        const dbOk = state.health && state.health.db && state.health.db.ok;
        const setup = document.getElementById('insightsSetup');
        const loading = document.getElementById('insightsLoading');
        const empty = document.getElementById('insightsEmpty');
        const body = document.getElementById('insightsBody');
        if (!setup) return;
        setup.style.display = 'none';
        empty.style.display = 'none';
        if (!dbOk) { setup.style.display = ''; body.style.display = 'none'; return; }

        loading.style.display = '';
        if (!forceGenerate) body.style.display = body.innerHTML && state.report ? '' : 'none';
        try {
            let report;
            if (forceGenerate) {
                const res = await fetch(tApi('/api/trends/report'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                report = await res.json();
                if (!res.ok) throw new Error(report.error || 'Failed to generate');
            } else {
                const res = await fetch(tApi('/api/trends/report/latest'));
                report = await res.json();
            }
            state.report = report && report.id ? report : null;
        } catch (err) {
            toast('Report error: ' + err.message, 'error');
            state.report = state.report || null;
        } finally {
            loading.style.display = 'none';
        }

        if (!state.report) { empty.style.display = ''; body.style.display = 'none'; return; }
        renderReport(state.report);
    }

    function parseJson(v, fallback) {
        if (v == null) return fallback;
        if (typeof v === 'object') return v;
        try { return JSON.parse(v); } catch { return fallback; }
    }

    function renderReport(report) {
        const body = document.getElementById('insightsBody');
        const period = document.getElementById('insightsPeriod');
        const conf = document.getElementById('insightsConf');
        body.style.display = '';

        const gen = report.generated_at ? new Date(report.generated_at) : null;
        const start = report.period_start ? new Date(report.period_start) : null;
        const fmt = (d) => d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
        period.textContent = `${fmt(start)} – ${fmt(gen)} · generated ${gen ? gen.toLocaleString() : '—'}`;
        conf.innerHTML = confBadge(report.confidence);

        // Summary
        document.getElementById('insightsSummary').innerHTML = report.summary
            ? `<div class="insights-summary-card">${esc(report.summary)}</div>` : '';

        // Recommendations
        const recs = parseJson(report.recommendations, []) || [];
        document.getElementById('insightsRecs').innerHTML = recs.length ? recs.map((r) => `
            <div class="insights-rec ${'cat-' + (r.category || 'companies')}">
              <div class="insights-rec-top">
                <span class="trend-cat-badge ${catMeta(r.category).cls}">${catMeta(r.category).label}</span>
                ${confBadge(r.confidence)}
              </div>
              <div class="insights-rec-title">${esc(r.title || '')}</div>
              ${r.format ? `<div class="insights-rec-format">🎬 ${esc(r.format)}</div>` : ''}
              ${r.angle ? `<div class="insights-rec-angle">${esc(r.angle)}</div>` : ''}
              ${r.why_now ? `<div class="insights-rec-why"><b>Why now:</b> ${esc(r.why_now)}</div>` : ''}
              ${r.evidence ? `<div class="insights-rec-ev">📊 ${esc(r.evidence)}</div>` : ''}
            </div>`).join('') : '<p style="color:var(--text-muted)">No recommendations in this report.</p>';

        // Trending now — category + platform momentum cards
        const trending = parseJson(report.trending, {}) || {};
        const plats = trending.platforms || [];
        const platEl = document.getElementById('insightsPlatforms');
        if (platEl) {
            platEl.innerHTML = plats.map((p) => `
            <div class="insights-cat-card">
              <div class="insights-cat-name"><span class="insights-plat-badge ${platMeta(p.platform).cls}">${platMeta(p.platform).label}</span></div>
              <div class="insights-cat-views">${fmtNum(p.totalViews)} <span>views</span></div>
              <div class="insights-cat-meta">${p.videos} videos · avg ${fmtNum(p.avgViews)}</div>
              <div class="insights-cat-growth">WoW views ${growthStr(p.viewGrowth)}</div>
              ${p.topVideos && p.topVideos[0] ? `<a class="insights-plat-top" href="${esc(p.topVideos[0].url)}" target="_blank" rel="noopener" title="${esc(p.topVideos[0].caption)}">Top: ${esc((p.topVideos[0].caption || '').slice(0, 48))} · ${fmtNum(p.topVideos[0].views)}</a>` : ''}
            </div>`).join('');
        }

        const cats = trending.categories || [];
        document.getElementById('insightsCats').innerHTML = cats.map((c) => `
            <div class="insights-cat-card">
              <div class="insights-cat-name"><span class="trend-cat-badge ${catMeta(c.category).cls}">${catMeta(c.category).label}</span></div>
              <div class="insights-cat-views">${fmtNum(c.totalViews)} <span>views</span></div>
              <div class="insights-cat-meta">${c.videos} videos · avg ${fmtNum(c.avgViews)}</div>
              <div class="insights-cat-growth">WoW views ${growthStr(c.viewGrowth)}</div>
            </div>`).join('');

        // Hottest videos
        const hot = (trending.topVideos || []).slice(0, 8);
        document.getElementById('insightsHot').innerHTML = hot.length ? `
            <div class="insights-hot-list">
              ${hot.map((v, i) => `
                <a class="insights-hot-row" href="${esc(v.url)}" target="_blank" rel="noopener">
                  <span class="insights-hot-rank">${i + 1}</span>
                  <span class="trend-cat-badge ${catMeta(v.category).cls}">${catMeta(v.category).label}</span>
                  <span class="insights-hot-cap">${esc(v.caption || '(no caption)')}</span>
                  <span class="insights-hot-views">${fmtNum(v.views)} views</span>
                </a>`).join('')}
            </div>` : '';

        // Rising topics with forecast
        const rising = parseJson(report.rising, {}) || {};
        const topics = (rising.topics || []);
        document.getElementById('insightsTopics').innerHTML = topics.length ? topics.map((t) => `
            <div class="insights-topic-row">
              <span class="insights-topic-dir dir-${t.direction}">${t.direction === 'rising' ? '▲' : t.direction === 'fading' ? '▼' : '•'}</span>
              <span class="insights-topic-kw">${esc(t.keyword)}</span>
              <span class="insights-topic-mentions">${fmtNum(t.mentions)} mentions ${growthStr(t.growth)}</span>
              <span class="insights-topic-fc" title="Forecast next week">→ ~${fmtNum(t.projectedNext)}</span>
              ${confBadge(t.confidence)}
            </div>`).join('') : '<p style="color:var(--text-muted)">No topic history yet — run a few weekly cycles.</p>';

        // Accelerating videos
        const accel = (rising.accelerating || []);
        document.getElementById('insightsAccel').innerHTML = accel.length ? accel.map((a) => `
            <a class="insights-accel-row" href="${esc(a.url)}" target="_blank" rel="noopener">
              <span class="insights-accel-rate">${fmtNum(a.velocityPerHour)}/hr</span>
              <span class="insights-accel-cap">${esc(a.caption || '(no caption)')}</span>
            </a>`).join('') : '<p style="color:var(--text-muted)">Acceleration needs 2+ snapshots per video — builds over daily cycles.</p>';
    }

    // ─── Step 4: score candidates ───────────────────────────────
    async function scoreCandidates() {
        const btn = document.getElementById('trendScoreBtn');
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) { toast('Connect the database first', 'error'); return; }
        if (state.health.llm && !state.health.llm.configured) {
            toast('ANTHROPIC_API_KEY not configured', 'error');
            return;
        }
        const orig = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-orange"></span> Scoring…'; }
        try {
            const solutionId = selectedSolutionId() || null;
            const res = await fetch(tApi('/api/trends/score'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit: 30, solutionId }),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Scoring unavailable', 'error'); return; }
            if (data.requested === 0) toast('All candidates are already scored');
            else toast(`Scored ${data.scored} candidate${data.scored === 1 ? '' : 's'}${data.usedSolution ? ' for ' + data.usedSolution : ''}`, 'success');
            await loadCandidates();
        } catch (err) {
            toast('Scoring failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = orig; }
        }
    }

    // ─── Step 6/7: generation review queue ──────────────────────
    function genStatusMeta(status) {
        switch (status) {
            case 'directed': return { cls: 'gen-script', label: 'Shot plan ready' };
            case 'imaging': return { cls: 'gen-rendering', label: 'Rendering images' };
            case 'qc': return { cls: 'gen-rendering', label: 'QC grading' };
            case 'animating': return { cls: 'gen-rendering', label: 'Images approved' };
            case 'composing': return { cls: 'gen-rendering', label: 'Composing slideshow' };
            case 'assembling': return { cls: 'gen-rendering', label: 'Assembling' };
            case 'rendering': return { cls: 'gen-rendering', label: 'Rendering' };
            case 'review': return { cls: 'gen-review', label: 'Ready for review' };
            case 'approved': return { cls: 'gen-approved', label: 'Approved' };
            case 'posted': return { cls: 'gen-posted', label: 'Posted' };
            case 'killed': return { cls: 'gen-killed', label: 'Killed' };
            case 'failed': return { cls: 'gen-failed', label: 'Failed' };
            case 'script_only': return { cls: 'gen-script', label: 'Script only' };
            default: return { cls: 'gen-script', label: status || 'Drafted' };
        }
    }

    function updateQueueBadge() {
        const badge = document.getElementById('trendQueueBadge');
        if (!badge) return;
        // Count everything still in the pipeline (rendering) or awaiting action,
        // not just 'review' — so the badge grows when Autopilot starts remakes
        // and shrinks as they get posted/killed/failed.
        const TERMINAL = ['posted', 'killed', 'failed', 'script_only'];
        const active = state.generations.filter((g) => !TERMINAL.includes(g.status)).length;
        badge.textContent = active;
        badge.style.display = active > 0 ? '' : 'none';
    }

    async function loadGenerations() {
        const setup = document.getElementById('queueSetup');
        const empty = document.getElementById('queueEmpty');
        const loading = document.getElementById('queueLoading');
        const list = document.getElementById('trendQueueList');
        setup.style.display = 'none';
        empty.style.display = 'none';
        list.innerHTML = '';

        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) { setup.style.display = ''; return; }

        loading.style.display = '';
        try {
            const res = await fetch(tApi('/api/trends/generations?limit=1000'));
            if (!res.ok) throw new Error('load failed');
            state.generations = await res.json();
        } catch (err) {
            state.generations = [];
            toast('Could not load the queue', 'error');
        } finally {
            loading.style.display = 'none';
        }

        updateQueueBadge();
        renderGenerations();

        // Auto-poll anything still rendering.
        state.generations.filter((g) => g.status === 'rendering').forEach((g) => pollGeneration(g.id));
    }

    // ─── Auto-driver: build every remake to completion without clicks ───
    // The server chain cron does this on a schedule, but on hosting plans that
    // throttle crons it stalls between stages. While the app is open we push each
    // in-flight generation forward one bounded step at a time (images → QC →
    // animate → assemble) via the per-generation advance endpoint, so Autopilot
    // remakes finish on their own. No cron secret needed.
    const AUTO_DRIVE_STATUSES = ['directed', 'imaging', 'qc', 'animating', 'composing', 'assembling'];
    let autoDriveBusy = false;
    let autoDriveTimer = null;

    async function autoDriveTick() {
        if (autoDriveBusy) return;
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) return;
        const active = (state.generations || []).filter((g) => AUTO_DRIVE_STATUSES.includes(g.status));
        if (!active.length) return;
        autoDriveBusy = true;
        try {
            // Advance the oldest in-flight generation by one step. Subsequent
            // ticks cycle through the rest, so the whole queue keeps moving.
            const g = active[active.length - 1]; // oldest (list is newest-first)
            await fetch(tApi(`/api/trends/generations/${g.id}/advance`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            }).catch(() => {});
            await loadGenerations();
        } finally {
            autoDriveBusy = false;
        }
    }

    function startAutoDrive() {
        if (autoDriveTimer) return;
        // Kick once shortly after load, then poll. Steps are long (renders), so a
        // modest interval plus the busy guard avoids overlapping calls.
        autoDriveTimer = setInterval(autoDriveTick, 15000);
        setTimeout(autoDriveTick, 3000);
    }

    function renderGenerations() {
        const list = document.getElementById('trendQueueList');
        const empty = document.getElementById('queueEmpty');
        let items = state.generations.slice();
        if (state.queueStatus !== 'all') items = items.filter((g) => g.status === state.queueStatus);
        if (state.queueOutput !== 'all') items = items.filter((g) => (g.output_type || 'video') === state.queueOutput);

        if (!items.length) {
            list.innerHTML = '';
            empty.style.display = state.generations.length ? 'none' : '';
            if (state.generations.length) {
                list.innerHTML = `<div class="trend-empty-inline">No generations with status "${esc(state.queueStatus)}".</div>`;
            }
            return;
        }
        empty.style.display = 'none';
        list.innerHTML = items.map(buildGenCard).join('');
        bindGenActions();
    }

    // The source video this remake was built from — shown alongside the result
    // so you can compare the concept reference to the output. Prefers the
    // playable media_url; falls back to the post thumbnail, then a source link.
    function buildConceptReference(g) {
        let dj = {};
        try { dj = typeof g.director_json === 'string' ? JSON.parse(g.director_json) : (g.director_json || {}); } catch { dj = {}; }
        const src = g.source_media_url || dj.source_media_url || '';
        const thumb = g.source_thumb || '';
        const link = g.source_url || '';
        if (!src && !thumb && !link) return '';
        let inner;
        if (src) {
            inner = `<video class="trend-gen-ref-video" src="${esc(src)}" controls muted loop preload="metadata" playsinline></video>`;
        } else if (thumb) {
            inner = `<a href="${esc(link)}" target="_blank" rel="noopener"><img class="trend-gen-ref-img" src="${esc(thumb)}" alt="reference" loading="lazy"></a>`;
        } else {
            inner = `<a class="btn-ghost" href="${esc(link)}" target="_blank" rel="noopener">Open reference ↗</a>`;
        }
        const meta = [g.platform ? esc(g.platform) : '', link ? `<a class="trend-gen-ref-link" href="${esc(link)}" target="_blank" rel="noopener">view original ↗</a>` : '']
            .filter(Boolean).join(' · ');
        return `<div class="trend-gen-reference">
          <div class="trend-gen-ref-label">🎯 Concept reference${meta ? ` <span>${meta}</span>` : ''}</div>
          ${inner}
        </div>`;
    }

    function buildGenCard(g) {
        const sm = genStatusMeta(g.status);
        let script = {};
        try { script = typeof g.script_json === 'string' ? JSON.parse(g.script_json) : (g.script_json || {}); } catch { script = {}; }
        const title = script.title || g.resolved_target || g.caption || 'Remake';
        const hook = script.hook || '';
        const onScreen = Array.isArray(script.on_screen_text) ? script.on_screen_text : [];
        let copyJson = {};
        try { copyJson = typeof g.copy_json === 'string' ? JSON.parse(g.copy_json) : (g.copy_json || {}); } catch { copyJson = {}; }
        const platCaptions = copyJson.captions && typeof copyJson.captions === 'object' ? copyJson.captions : {};
        const hashtags = Array.isArray(copyJson.hashtags) && copyJson.hashtags.length
            ? copyJson.hashtags
            : (Array.isArray(script.hashtags) ? script.hashtags : []);

        // Image-first chain shots (Director → Image → QC).
        let shots = [];
        try { shots = typeof g.shots === 'string' ? JSON.parse(g.shots) : (g.shots || []); } catch { shots = []; }
        const isChain = ['directed', 'imaging', 'qc', 'animating', 'composing', 'assembling'].includes(g.status) || shots.length;
        const isSlideshow = g.output_type === 'slideshow';
        let slideUrls = [];
        try { slideUrls = typeof g.slide_urls === 'string' ? JSON.parse(g.slide_urls) : (g.slide_urls || []); } catch { slideUrls = []; }

        let media;
        if (isSlideshow && slideUrls.length) {
            // Composed carousel: the slide strip is the deliverable; the reel
            // (asset_url) is the inline preview.
            const reel = g.asset_url ? `<video class="trend-gen-video" src="${esc(g.asset_url)}" controls preload="metadata" style="margin-bottom:8px;"></video>` : '';
            media = `${reel}<div class="trend-shot-grid">${slideUrls.map((s, i) => `<div class="trend-shot"><img src="${esc(s.url)}" alt="" loading="lazy"><span class="shot-role">slide ${i + 1}</span></div>`).join('')}</div>`;
        } else if (g.asset_url) {
            media = `<video class="trend-gen-video" src="${esc(g.asset_url)}" controls preload="metadata"></video>`;
        } else if (isChain && shots.length) {
            media = `<div class="trend-shot-grid">${shots.map((s) => {
                const ok = s.qc?.pass;
                // Clip state wins the badge once a shot is animated.
                let badge;
                if (s.video_url) badge = '<span class="shot-badge ok">▶ clip</span>';
                else if (s.video_status_url) badge = '<span class="shot-badge wait">▶ …</span>';
                else if (s.video_error && !s.image_url) badge = '<span class="shot-badge bad">⚠</span>';
                else if (s.image_url) badge = (s.qc ? (ok ? '<span class="shot-badge ok">✓ QC</span>' : '<span class="shot-badge bad">✕ QC</span>') : '');
                else badge = '<span class="shot-badge wait">…</span>';
                const inner = s.video_url
                    ? `<video src="${esc(s.video_url)}" muted loop preload="metadata" onmouseover="this.play()" onmouseout="this.pause()"></video><span class="shot-play">▶</span>`
                    : (s.image_url
                        ? `<img src="${esc(s.image_url)}" alt="" loading="lazy">`
                        : `<div class="shot-empty">${s.image_error ? '⚠' : '⏳'}</div>`);
                const tip = s.video_error || s.qc?.notes || s.image_error || s.role || '';
                return `<div class="trend-shot" title="${esc(s.role || '')}${tip && tip !== s.role ? ' — ' + esc(tip) : ''}">${inner}<span class="shot-role">${esc(s.role || '')}</span>${badge}</div>`;
            }).join('')}</div>`;
        } else {
            media = `<div class="trend-gen-media-placeholder">${g.status === 'rendering' ? '<span class="spinner-orange"></span> Rendering video…' : (g.status === 'failed' ? '⚠ Render failed' : '📝 Script only')}</div>`;
        }

        // A still is permanent only if it lives in Blob storage; provider URLs
        // expire and render as broken triangles, so they need re-rendering.
        const isPersistedShot = (s) => typeof s.image_url === 'string' && s.image_url.includes('blob.vercel-storage.com');
        const hasBrokenShots = isChain && shots.length && shots.some((s) => s.image_url && !isPersistedShot(s));
        const missingShots = isChain && shots.some((s) => !s.image_url);

        const actions = [];
        if (g.status === 'rendering') actions.push(`<button class="btn-ghost" data-gen-refresh="${esc(g.id)}">Check status</button>`);
        if (g.status === 'directed' || missingShots || hasBrokenShots) {
            actions.push(`<button class="btn-ghost" data-gen-images="${esc(g.id)}">${hasBrokenShots && !missingShots ? 'Fix broken images' : 'Render images'}</button>`);
        }
        if (g.status === 'qc' || (isChain && shots.some((s) => s.image_url && !s.qc?.pass))) {
            actions.push(`<button class="btn-ghost" data-gen-qc="${esc(g.id)}">Run QC</button>`);
        }
        if (isSlideshow) {
            // Compose: every slide has an image but the carousel/reel isn't built.
            if (!g.asset_url && shots.length && shots.every((s) => s.image_url)) {
                actions.push(`<button class="btn-ghost" data-gen-copy="${esc(g.id)}">Copy</button>`);
                actions.push(`<button class="trend-btn-recreate" style="flex:0 0 auto;padding:9px 18px;" data-gen-slides="${esc(g.id)}">Compose slideshow</button>`);
            }
        } else {
            // Animate: all images present but not every shot has a clip yet.
            if (isChain && !g.asset_url && shots.length && shots.every((s) => s.image_url) && shots.some((s) => !s.video_url)) {
                actions.push(`<button class="btn-ghost" data-gen-video="${esc(g.id)}">Animate clips</button>`);
            }
            // Assemble: every shot has a clip but there is no final cut yet.
            if (isChain && !g.asset_url && shots.length && shots.every((s) => s.video_url)) {
                actions.push(`<button class="btn-ghost" data-gen-copy="${esc(g.id)}">Copy</button>`);
                actions.push(`<button class="trend-btn-recreate" style="flex:0 0 auto;padding:9px 18px;" data-gen-assemble="${esc(g.id)}">Assemble video</button>`);
            }
        }
        if (g.status === 'review') {
            actions.push(`<button class="trend-btn-recreate" style="flex:0 0 auto;padding:9px 18px;" data-gen-approve="${esc(g.id)}">✓ Approve</button>`);
            actions.push(`<button class="btn-ghost danger" data-gen-kill="${esc(g.id)}">Kill</button>`);
        }
        if (g.status === 'approved') {
            actions.push(`<button class="trend-btn-recreate" style="flex:0 0 auto;padding:9px 18px;" data-gen-posted="${esc(g.id)}">Mark posted</button>`);
        }
        // Publish straight to Instagram (only when configured and the asset is ready).
        const igReady = state.health?.instagramPublish?.configured;
        const hasPostable = g.asset_url || (isSlideshow && Array.isArray(g.slide_urls) && g.slide_urls.length);
        if (igReady && hasPostable && ['review', 'approved'].includes(g.status)) {
            actions.push(`<button class="btn-ghost" style="flex:0 0 auto;padding:9px 18px;" data-gen-publish="${esc(g.id)}">📲 Publish to IG</button>`);
        }
        if (g.asset_url) actions.push(`<a class="btn-ghost" href="${esc(g.asset_url)}" download target="_blank" rel="noopener">Download</a>`);
        if (g.source_url) actions.push(`<a class="btn-ghost" href="${esc(g.source_url)}" target="_blank" rel="noopener">Source ↗</a>`);

        return `
        <div class="trend-gen-card" data-gen="${esc(g.id)}">
          <div class="trend-gen-media">${media}${buildConceptReference(g)}</div>
          <div class="trend-gen-body">
            <div class="trend-gen-head">
              <span class="trend-gen-status ${sm.cls}">${sm.label}</span>
              <span class="trend-gen-type">${isSlideshow ? '🖼️ Slideshow' : '🎬 Video'}</span>
              <span class="trend-gen-title">${esc(title)}</span>
            </div>
            ${hook ? `<div class="trend-gen-hook">"${esc(hook)}"</div>` : ''}
            ${g.script ? `<div class="trend-gen-vo"><b>Voiceover:</b> ${esc(g.script)}</div>` : ''}
            ${onScreen.length ? `<div class="trend-gen-onscreen">${onScreen.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
            ${Object.keys(platCaptions).length
                ? Object.entries(platCaptions).map(([p, c]) => c ? `<div class="trend-gen-caption"><b>${esc(p)}:</b> ${esc(c)}</div>` : '').join('')
                : (g.caption ? `<div class="trend-gen-caption"><b>Caption:</b> ${esc(g.caption)}</div>` : '')}
            ${hashtags.length ? `<div class="trend-gen-tags">${hashtags.map((t) => `<span>#${esc(String(t).replace(/^#/, ''))}</span>`).join('')}</div>` : ''}
            ${g.error ? `<div class="trend-gen-error">${esc(g.error)}</div>` : ''}
            ${(() => {
                const errs = [...new Set(shots.filter((s) => s.image_error).map((s) => String(s.image_error)))];
                if (!errs.length) return '';
                return `<div class="trend-gen-error">⚠ Image error: ${esc(errs[0])}${errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''}</div>`;
            })()}
            <div class="trend-gen-actions">${actions.join('')}</div>
          </div>
        </div>`;
    }

    function bindGenActions() {
        const list = document.getElementById('trendQueueList');
        list.querySelectorAll('[data-gen-refresh]').forEach((b) =>
            b.addEventListener('click', () => pollGeneration(b.dataset.genRefresh, true)));
        list.querySelectorAll('[data-gen-approve]').forEach((b) =>
            b.addEventListener('click', () => setGenStatus(b.dataset.genApprove, 'approved')));
        list.querySelectorAll('[data-gen-kill]').forEach((b) =>
            b.addEventListener('click', () => setGenStatus(b.dataset.genKill, 'killed')));
        list.querySelectorAll('[data-gen-posted]').forEach((b) =>
            b.addEventListener('click', () => markPosted(b.dataset.genPosted)));
        list.querySelectorAll('[data-gen-publish]').forEach((b) =>
            b.addEventListener('click', () => publishToInstagram(b.dataset.genPublish, b)));
        list.querySelectorAll('[data-gen-images]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genImages, 'images', b)));
        list.querySelectorAll('[data-gen-qc]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genQc, 'qc', b)));
        list.querySelectorAll('[data-gen-video]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genVideo, 'video', b)));
        list.querySelectorAll('[data-gen-copy]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genCopy, 'copy', b)));
        list.querySelectorAll('[data-gen-assemble]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genAssemble, 'assemble', b)));
        list.querySelectorAll('[data-gen-slides]').forEach((b) =>
            b.addEventListener('click', () => runChainStage(b.dataset.genSlides, 'slides', b)));
    }

    // Mark posted, capturing the public URL so the feedback loop can scrape its
    // real performance and feed winners back into the next run.
    async function markPosted(id) {
        const url = window.prompt('Paste the public post URL (TikTok/Instagram/YouTube) to track its performance. Leave blank to skip.', '');
        if (url === null) return; // cancelled
        try {
            const res = await fetch(tApi(`/api/trends/generations/${id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'posted', posted_url: (url || '').trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Update failed', 'error'); return; }
            const idx = state.generations.findIndex((g) => g.id === id);
            if (idx !== -1) state.generations[idx] = { ...state.generations[idx], ...data };
            updateQueueBadge();
            renderGenerations();
            toast((url || '').trim() ? 'Marked posted — tracking performance' : 'Marked posted', 'success');
        } catch (err) {
            toast('Update failed: ' + err.message, 'error');
        }
    }

    // Publish a finished reel/carousel straight to Instagram (Graph API).
    async function publishToInstagram(id, btn) {
        if (!window.confirm('Publish this to your Instagram now with the generated caption?')) return;
        const orig = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
        try {
            const res = await fetch(tApi(`/api/trends/generations/${id}/publish`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Publish failed', 'error'); return; }
            const idx = state.generations.findIndex((g) => g.id === id);
            if (idx !== -1) state.generations[idx] = { ...state.generations[idx], status: 'posted', posted_url: data.permalink || state.generations[idx].posted_url };
            updateQueueBadge();
            renderGenerations();
            toast(data.permalink ? 'Published to Instagram 🎉' : 'Published to Instagram', 'success');
        } catch (err) {
            toast('Publish failed: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    // Resume a chain stage from the Queue: images / qc / video / copy / assemble.
    // Turn a QC response into an honest toast. The grader (Gemini) can error on
    // every shot (rate limit / quota / transient overload); those land in
    // `errored`, not passed/failed — so a naive "0 passed, 0 need work" was
    // misleading. Surface the real situation instead.
    function qcMessage(data, suffix = '') {
        const passed = data.passed || 0;
        const failed = data.failed || 0;
        const errored = data.errored || 0;
        if (passed === 0 && failed === 0 && errored > 0) {
            return { text: `QC grader was busy — couldn't grade ${errored} shot${errored > 1 ? 's' : ''} (rate limit). Your images are ready; QC will retry automatically.`, kind: 'info' };
        }
        if (passed === 0 && failed === 0) {
            return { text: 'QC found no images to grade yet — render images first.', kind: 'info' };
        }
        const extra = errored > 0 ? `, ${errored} couldn't be graded (will retry)` : '';
        return { text: `QC: ${passed} passed, ${failed} need work${extra}.${suffix}`, kind: 'success' };
    }

    async function runChainStage(genId, stage, btn) {
        const busyLabel = { images: 'Rendering…', qc: 'Grading…', video: 'Animating…', copy: 'Writing…', assemble: 'Assembling…', slides: 'Composing…' }[stage] || 'Working…';
        if (btn) { btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = busyLabel; }
        try {
            // Video is staged + resumable; drive it to completion in a loop, then
            // finish the job automatically (copy + assemble) so there's no manual
            // "Assemble video" step.
            if (stage === 'video') {
                const out = await runVideoLoop(genId);
                await loadGenerations();
                if (!out.done) { toast(out.message || 'Clips still rendering', 'info'); return; }
                toast('All clips rendered. Writing voiceover and assembling…');
                try {
                    await fetch(tApi(`/api/trends/generations/${genId}/copy`), {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                    });
                } catch { /* assembly produces a silent cut if copy is missing */ }
                const ares = await fetch(tApi(`/api/trends/generations/${genId}/assemble`), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                const adata = await ares.json().catch(() => ({}));
                await loadGenerations();
                toast(ares.ok && adata.asset_url ? 'Final video ready for review' : (adata.error || 'Assembly will retry — clips are ready in the Queue'), ares.ok && adata.asset_url ? 'success' : 'info');
                return;
            }
            const res = await fetch(tApi(`/api/trends/generations/${genId}/${stage}`), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            const data = await res.json();
            await loadGenerations();
            if (!res.ok) { toast(data.error || `${stage} failed`, 'error'); return; }
            if (stage === 'images') toast(`Rendered ${data.made || 0}/${data.total || 0} images`, 'success');
            else if (stage === 'qc') { const m = qcMessage(data); toast(m.text, m.kind); }
            else if (stage === 'copy') toast('Voiceover and captions written', 'success');
            else if (stage === 'assemble') toast(data.asset_url ? 'Final video ready for review' : (data.error || 'Assembly will retry'), data.asset_url ? 'success' : 'info');
            else if (stage === 'slides') toast(data.asset_url ? `Slideshow ready (${data.slides || 0} slides)` : (data.error || 'Slides will retry'), data.asset_url ? 'success' : 'info');
        } catch (err) {
            toast(`${stage} failed: ` + err.message, 'error');
        } finally {
            if (btn && btn.dataset.orig) { btn.disabled = false; btn.textContent = btn.dataset.orig; }
        }
    }

    async function setGenStatus(id, status) {
        try {
            const res = await fetch(tApi(`/api/trends/generations/${id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Update failed', 'error'); return; }
            const idx = state.generations.findIndex((g) => g.id === id);
            if (idx !== -1) state.generations[idx] = { ...state.generations[idx], ...data };
            updateQueueBadge();
            renderGenerations();
            toast(status === 'approved' ? 'Approved' : status === 'killed' ? 'Killed' : status === 'posted' ? 'Marked posted' : 'Updated');
        } catch (err) {
            toast('Update failed: ' + err.message, 'error');
        }
    }

    const polling = new Set();
    const pollAttempts = {};
    const MAX_POLLS = 40; // ~8 min at 12s intervals, then stop
    async function pollGeneration(id, once = false) {
        if (polling.has(id) && !once) return;
        polling.add(id);
        pollAttempts[id] = (pollAttempts[id] || 0) + 1;
        try {
            const res = await fetch(tApi(`/api/trends/generations/${id}/refresh`), { method: 'POST' });
            const data = await res.json();
            if (res.ok && data) {
                const idx = state.generations.findIndex((g) => g.id === id);
                if (idx !== -1) state.generations[idx] = { ...state.generations[idx], ...data };
                if (state.subtab === 'queue') { updateQueueBadge(); renderGenerations(); }
                if (data.status === 'rendering' && !once) {
                    if (pollAttempts[id] >= MAX_POLLS) {
                        toast('A render is taking unusually long — check back later', 'error');
                    } else {
                        setTimeout(() => { polling.delete(id); pollGeneration(id); }, 12000);
                        return;
                    }
                }
                if (data.status === 'review') toast('A video finished rendering — ready for review', 'success');
            }
        } catch { /* silent */ }
        polling.delete(id);
    }

    // ─── Step 8: live topics ────────────────────────────────────
    async function loadTopics() {
        const loading = document.getElementById('trendTopicsLoading');
        const wrap = document.getElementById('trendTopicsLive');
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) { if (wrap) wrap.innerHTML = '<div style="color:var(--text-muted);">Connect the database to track topics.</div>'; return; }
        if (loading) loading.style.display = '';
        try {
            const res = await fetch(tApi('/api/trends/topics'));
            const topics = res.ok ? await res.json() : [];
            if (!topics.length) {
                wrap.innerHTML = '<div style="color:var(--text-muted);">No topic snapshots yet. Run ingest, then snapshot topics.</div>';
            } else {
                wrap.innerHTML = topics.map((t) => {
                    const wave = Number(t.wave_score) || 0;
                    const pct = Math.round(wave * 100);
                    const rising = wave > 0.05;
                    return `
                    <div class="trend-topic-row">
                      <span class="trend-topic-name">${esc(t.keyword)}</span>
                      <span class="trend-topic-vol">${fmtNum(t.mention_volume)} mentions</span>
                      <span class="trend-topic-wave ${rising ? 'rising' : ''}">
                        <span class="trend-topic-wave-track"><span class="trend-topic-wave-fill" style="width:${pct}%"></span></span>
                        ${rising ? '▲ ' : ''}${pct}%
                      </span>
                    </div>`;
                }).join('');
            }
        } catch (err) {
            wrap.innerHTML = '<div style="color:#b91c1c;">Could not load topics.</div>';
        } finally {
            if (loading) loading.style.display = 'none';
        }
    }

    async function ingestTopics() {
        const btn = document.getElementById('trendTopicIngestBtn');
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) { toast('Connect the database first', 'error'); return; }
        const orig = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Snapshotting…'; }
        try {
            const res = await fetch(tApi('/api/trends/topics/ingest'), { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Topic snapshot failed', 'error'); return; }
            toast('Topic snapshot taken', 'success');
            await loadTopics();
        } catch (err) {
            toast('Topic snapshot failed', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    // ─── Solutions knowledge base ───────────────────────────────
    const solState = { items: [], openId: null };

    function selectedSolutionId() {
        return localStorage.getItem('trend_selected_solution') || '';
    }

    function setSelectedSolution(id) {
        if (id) localStorage.setItem('trend_selected_solution', id);
        else localStorage.removeItem('trend_selected_solution');
        // Exposed for the generation pipeline (step 6).
        window.trendSelectedSolutionId = id || null;
    }

    function showSolForm(sol) {
        const form = document.getElementById('solForm');
        document.getElementById('solFormTitle').textContent = sol ? 'Edit solution' : 'New solution';
        document.getElementById('solFormId').value = sol ? sol.id : '';
        document.getElementById('solName').value = sol ? (sol.name || '') : '';
        document.getElementById('solDescription').value = sol ? (sol.description || '') : '';
        document.getElementById('solBuyer').value = sol ? (sol.buyer || '') : '';
        document.getElementById('solHooks').value = sol ? (sol.hooks || '') : '';
        document.getElementById('solPains').value = sol ? (sol.pains || '') : '';
        form.style.display = '';
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function hideSolForm() {
        document.getElementById('solForm').style.display = 'none';
    }

    async function saveSolution() {
        const id = document.getElementById('solFormId').value;
        const payload = {
            name: document.getElementById('solName').value.trim(),
            description: document.getElementById('solDescription').value.trim(),
            buyer: document.getElementById('solBuyer').value.trim(),
            hooks: document.getElementById('solHooks').value.trim(),
            pains: document.getElementById('solPains').value.trim(),
        };
        if (!payload.name) { toast('Give the solution a name', 'error'); return; }
        try {
            const res = await fetch(tApi(id ? `/api/trends/solutions/${id}` : '/api/trends/solutions'), {
                method: id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Save failed', 'error'); return; }
            toast(id ? 'Solution updated' : 'Solution created');
            hideSolForm();
            await loadSolutions();
        } catch (err) {
            toast('Save failed: ' + err.message, 'error');
        }
    }

    async function loadSolutions() {
        const setup = document.getElementById('solSetup');
        const empty = document.getElementById('solEmpty');
        const loading = document.getElementById('solLoading');
        const list = document.getElementById('solList');
        setup.style.display = 'none';
        empty.style.display = 'none';
        list.innerHTML = '';

        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (!dbOk) { setup.style.display = ''; return; }

        loading.style.display = '';
        try {
            const res = await fetch(tApi('/api/trends/solutions'));
            if (!res.ok) throw new Error('load failed');
            solState.items = await res.json();
        } catch (err) {
            solState.items = [];
            toast('Could not load solutions', 'error');
        } finally {
            loading.style.display = 'none';
        }

        if (!solState.items.length) { empty.style.display = ''; return; }
        renderSolutions();
    }

    function renderSolutions() {
        const list = document.getElementById('solList');
        const sel = selectedSolutionId();
        list.innerHTML = solState.items.map((s) => {
            const isSel = s.id === sel;
            const isOpen = s.id === solState.openId;
            return `
            <div class="trend-sol-card ${isSel ? 'selected' : ''} ${isOpen ? 'open' : ''}" data-sol="${esc(s.id)}">
              <div class="trend-sol-head" data-toggle="${esc(s.id)}">
                <div class="trend-sol-head-main">
                  <div class="trend-sol-name">${esc(s.name)}${isSel ? '<span class="trend-sol-selected-badge">Selected</span>' : ''}</div>
                  ${s.description ? `<div class="trend-sol-desc">${esc(s.description)}</div>` : ''}
                </div>
                <span class="trend-sol-meta">${s.file_count || 0} file${s.file_count === 1 ? '' : 's'}</span>
                <svg class="trend-sol-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div class="trend-sol-body" data-body="${esc(s.id)}">
                <div class="trend-sol-loading-files" style="color:var(--text-muted);font-size:0.85rem;">Loading files…</div>
              </div>
            </div>`;
        }).join('');

        // Header toggles
        list.querySelectorAll('[data-toggle]').forEach((h) => {
            h.addEventListener('click', () => toggleSolution(h.dataset.toggle));
        });
    }

    async function toggleSolution(id) {
        if (solState.openId === id) { solState.openId = null; renderSolutions(); return; }
        solState.openId = id;
        renderSolutions();
        // Load detail (files) into the open body
        const body = document.querySelector(`#solList [data-body="${CSS.escape(id)}"]`);
        if (!body) return;
        try {
            const res = await fetch(tApi(`/api/trends/solutions/${id}`));
            const sol = await res.json();
            if (!res.ok) throw new Error(sol.error || 'load failed');
            renderSolutionBody(body, sol);
        } catch (err) {
            body.innerHTML = `<div style="color:#b91c1c;font-size:0.85rem;">${esc(err.message)}</div>`;
        }
    }

    function renderSolutionBody(body, sol) {
        const sel = selectedSolutionId();
        const isSel = sol.id === sel;
        const fields = [];
        if (sol.buyer) fields.push(`<div><b>Buyer:</b> ${esc(sol.buyer)}</div>`);
        if (sol.hooks) fields.push(`<div><b>Hooks:</b> ${esc(sol.hooks)}</div>`);
        if (sol.pains) fields.push(`<div><b>Core pains:</b> ${esc(sol.pains)}</div>`);

        const files = (sol.files || []).map((f) => `
            <div class="trend-sol-file">
              <span class="trend-sol-file-icon">📄</span>
              <span class="trend-sol-file-name">${esc(f.filename)}</span>
              <span class="trend-sol-file-size">${f.size_bytes ? fmtBytes(f.size_bytes) : ''}</span>
              <button class="trend-sol-file-del" data-delfile="${esc(f.id)}" data-sol="${esc(sol.id)}" title="Remove">✕</button>
            </div>`).join('');

        body.innerHTML = `
            ${fields.length ? `<div class="trend-sol-fields">${fields.join('')}</div>` : ''}
            <div class="trend-sol-files">${files || '<div style="color:var(--text-muted);font-size:0.85rem;">No files yet.</div>'}</div>
            <div class="trend-sol-dropzone" data-drop="${esc(sol.id)}">
              Drop files here or <strong>click to browse</strong><br/>
              <span style="font-size:0.75rem;">PDF, text, markdown, CSV</span>
            </div>
            <div class="trend-sol-actions">
              <button class="trend-btn-recreate" style="flex:0 0 auto;padding:9px 18px;" data-select="${esc(sol.id)}">
                ${isSel ? '✓ Selected for video' : 'Select for video'}
              </button>
              <button class="btn-ghost" data-edit="${esc(sol.id)}">Edit</button>
              <button class="btn-ghost danger" data-delsol="${esc(sol.id)}">Delete</button>
            </div>`;

        // Dropzone → hidden file input
        const dz = body.querySelector('[data-drop]');
        dz.addEventListener('click', () => triggerUpload(sol.id));
        dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(sol.id, e.dataTransfer.files);
        });

        body.querySelectorAll('[data-delfile]').forEach((b) =>
            b.addEventListener('click', () => deleteSolFile(b.dataset.sol, b.dataset.delfile)));
        body.querySelector('[data-select]').addEventListener('click', () => {
            const newSel = isSel ? '' : sol.id;
            setSelectedSolution(newSel);
            renderSolutions();
            setTimeout(() => toggleSolution(sol.id), 0);
            toast(newSel ? `"${sol.name}" selected for video generation` : 'Selection cleared');
        });
        body.querySelector('[data-edit]').addEventListener('click', () => {
            const full = solState.items.find((x) => x.id === sol.id) || sol;
            showSolForm({ ...full, ...sol });
        });
        body.querySelector('[data-delsol]').addEventListener('click', () => deleteSol(sol.id, sol.name));
    }

    function fmtBytes(n) {
        const v = Number(n);
        if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
        if (v >= 1e3) return (v / 1e3).toFixed(0) + ' KB';
        return v + ' B';
    }

    function triggerUpload(solId) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.accept = '.pdf,.txt,.md,.csv,.json,text/*,application/pdf';
        inp.addEventListener('change', () => { if (inp.files.length) uploadFiles(solId, inp.files); });
        inp.click();
    }

    async function uploadFiles(solId, fileList) {
        const fd = new FormData();
        for (const f of fileList) fd.append('files', f);
        toast('Uploading…');
        try {
            const res = await fetch(tApi(`/api/trends/solutions/${solId}/files`), { method: 'POST', body: fd });
            const data = await res.json();
            if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
            toast(`${data.files.length} file${data.files.length === 1 ? '' : 's'} added`);
            await loadSolutions();
            solState.openId = solId;
            renderSolutions();
            toggleSolution(solId);
        } catch (err) {
            toast('Upload failed: ' + err.message, 'error');
        }
    }

    async function deleteSolFile(solId, fileId) {
        try {
            await fetch(tApi(`/api/trends/solutions/${solId}/files/${fileId}`), { method: 'DELETE' });
            toast('File removed');
            await loadSolutions();
            solState.openId = solId;
            renderSolutions();
            toggleSolution(solId);
        } catch (err) {
            toast('Could not remove file', 'error');
        }
    }

    async function deleteSol(id, name) {
        if (!confirm(`Delete "${name}" and its files? This cannot be undone.`)) return;
        try {
            await fetch(tApi(`/api/trends/solutions/${id}`), { method: 'DELETE' });
            if (selectedSolutionId() === id) setSelectedSolution('');
            toast('Solution deleted');
            await loadSolutions();
        } catch (err) {
            toast('Delete failed', 'error');
        }
    }

    function bindOnce() {
        console.log('[trends-debug] bindOnce called, state.bound =', state.bound);
        if (state.bound) return;
        const page = document.getElementById('pageTrends');
        console.log('[trends-debug] bindOnce page =', page);
        if (!page) return;
        state.bound = true;

        const subtabEls = page.querySelectorAll('.trend-subtab');
        console.log('[trends-debug] subtab count =', subtabEls.length);
        subtabEls.forEach((t) =>
            t.addEventListener('click', () => switchSubtab(t.dataset.subtab)));

        const catSel = document.getElementById('trendCategorySelect');
        if (catSel) catSel.addEventListener('change', () => { state.category = catSel.value; renderCandidates(); });

        const platSel = document.getElementById('trendPlatformSelect');
        if (platSel) platSel.addEventListener('change', () => { state.platform = platSel.value; renderCandidates(); });

        const bucketSel = document.getElementById('trendBucketSelect');
        if (bucketSel) bucketSel.addEventListener('change', () => { state.bucket = bucketSel.value; renderCandidates(); });

        const sortSel = document.getElementById('trendSort');
        if (sortSel) sortSel.addEventListener('change', () => { state.sort = sortSel.value; renderCandidates(); });

        // Autopilot — bind both agents (Trend + Instagram)
        Object.values(AP_AGENTS).forEach((cfg) => {
            const toggle = document.getElementById(cfg.ids.toggle);
            if (toggle) toggle.addEventListener('change', () => saveAutopilotSettings(cfg));
            const save = document.getElementById(cfg.ids.save);
            if (save) save.addEventListener('click', () => saveAutopilotSettings(cfg));
            const run = document.getElementById(cfg.ids.run);
            if (run) run.addEventListener('click', () => runAutopilotNow(cfg));
        });

        const refresh = document.getElementById('trendRefreshBtn');
        if (refresh) refresh.addEventListener('click', async () => { await loadHealth(); await loadCandidates(); });

        const ingest = document.getElementById('trendIngestBtn');
        if (ingest) ingest.addEventListener('click', runIngest);

        const scoreBtn = document.getElementById('trendScoreBtn');
        if (scoreBtn) scoreBtn.addEventListener('click', scoreCandidates);

        const insBtn = document.getElementById('insightsGenBtn');
        if (insBtn) insBtn.addEventListener('click', async () => {
            const orig = insBtn.innerHTML;
            insBtn.disabled = true;
            insBtn.innerHTML = '<span class="spinner-orange"></span> Analyzing…';
            try { await loadReport(true); toast('Weekly report generated', 'success'); }
            finally { insBtn.disabled = false; insBtn.innerHTML = orig; }
        });

        // Queue status filter
        page.querySelectorAll('#trendQueueFilter .trend-chip').forEach((c) =>
            c.addEventListener('click', () => {
                state.queueStatus = c.dataset.qstatus;
                page.querySelectorAll('#trendQueueFilter .trend-chip').forEach((x) => {
                    const on = x === c;
                    x.classList.toggle('active', on);
                    x.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                renderGenerations();
            }));

        // Queue output-type filter (Video / Slideshow)
        page.querySelectorAll('#trendQueueOutput .trend-chip').forEach((c) =>
            c.addEventListener('click', () => {
                state.queueOutput = c.dataset.qoutput;
                page.querySelectorAll('#trendQueueOutput .trend-chip').forEach((x) => {
                    const on = x === c;
                    x.classList.toggle('active', on);
                    x.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                renderGenerations();
            }));

        // Topics
        const topicIngest = document.getElementById('trendTopicIngestBtn');
        if (topicIngest) topicIngest.addEventListener('click', ingestTopics);

        // Solutions form
        const addBtn = document.getElementById('solAddBtn');
        if (addBtn) addBtn.addEventListener('click', () => showSolForm(null));
        const cancelBtn = document.getElementById('solCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', hideSolForm);
        const saveBtn = document.getElementById('solSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSolution);
    }

    window.initTrendsPage = async function initTrendsPage() {
        console.log('[trends-debug] initTrendsPage called');
        bindOnce();
        markRoadmap();
        window.trendSelectedSolutionId = selectedSolutionId() || null;
        await loadHealth();
        await loadCandidates();
        // Resume polling any in-flight renders even if the user hasn't opened
        // the Queue tab yet, and keep the queue badge accurate.
        const dbOk = state.health && state.health.db && state.health.db.ok;
        if (dbOk) {
            await loadGenerations();
            startAutoDrive(); // keep building in-flight remakes automatically
        }
    };

    console.log('✅ Trend Analysis module ready');
})();
