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
    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    toastContainer.appendChild(toast);

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

    // Smooth progress animation
    let currentPct = 0;
    let targetPct = 0;
    const smoothInterval = setInterval(() => {
        if (currentPct < targetPct) {
            // Move smoothly toward target (ease toward it)
            const diff = targetPct - currentPct;
            const step = Math.max(0.3, diff * 0.08);
            currentPct = Math.min(currentPct + step, targetPct);
        } else if (currentPct < 95 && targetPct > 0) {
            // Creep slowly even between SSE events so bar never stalls
            currentPct += 0.15;
        }
        const rounded = Math.round(currentPct);
        progressFill.style.width = `${rounded}%`;
        progressPercent.textContent = `${rounded}%`;
    }, 200);

    try {
        const res = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keywords, description, wordCount, imageCount, target, product, trends, tone, language }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

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
                        targetPct = Math.round((data.step / data.total) * 100);
                        loadingText.textContent = data.message;
                    }

                    if (data.type === 'result') {
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
                            .replace(/<!--\s*SEO_TITLE:.*?-->\n?/g, '')
                            .replace(/<!--\s*META_DESC:.*?-->\n?/g, '')
                            .replace(/<!--\s*SEO_KEYWORDS:.*?-->\n?/g, '');
                        blogBody.innerHTML = cleanContent;
                        englishBlogHtml = cleanContent;
                        blogBody.contentEditable = 'true';

                        showState('content');
                        publishPanel.style.display = 'block';
                        showToast(`Blog generated: "${data.title}"`);

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
      <a href="https://celeritech.biz/ent_reg/" target="_blank">Edit in WordPress →</a>
    `;
        publishResult.style.display = 'block';

        // Mark blog as published in history
        if (currentBlogId) {
            await fetch(`${API_BASE}/api/blogs/${currentBlogId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ published: true, html: englishBlogHtml }),
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
        }
    });
});

// Restore last active page on load
const savedPage = localStorage.getItem('orbit_active_page');
if (savedPage) {
    const savedNavItem = document.querySelector(`.nav-item[data-page="${savedPage}"]`);
    if (savedNavItem) savedNavItem.click();
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
    loadMediaHistory();
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
let redditAgents = JSON.parse(localStorage.getItem('orbit_reddit_agents') || '[]');
let redditActivity = JSON.parse(localStorage.getItem('orbit_reddit_activity') || '[]');

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
                    statusEl.innerHTML = `<span class="status-dot"></span><span>Connected as ${userName}</span>`;
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
    // Listen for OAuth callback postMessage from popup
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'oauth_result') {
            const { status, platform, detail } = event.data;
            if (status === 'success') {
                showToast(`${PLATFORM_META[platform]?.name || platform} connected as ${detail}!`);
            } else {
                showToast(`${PLATFORM_META[platform]?.name || platform} connection failed: ${detail}`, 'error');
            }
            // Refresh status from server
            renderAccountsStatus();
        }
    });

    const connectBtns = document.querySelectorAll('.sched-connect-btn');
    console.log(`🔌 Found ${connectBtns.length} connect buttons`);
    connectBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const platform = btn.dataset.platform;
            console.log(`🔌 Connect clicked for: ${platform}`);
            if (!platform) return;

            const isConnected = cachedAccountStatus[platform]?.connected === true;

            if (isConnected) {
                // Disconnect via server
                try {
                    const res = await fetch(`${API_BASE}/api/oauth/${platform}/disconnect`, { method: 'POST' });
                    if (res.ok) {
                        showToast(`${PLATFORM_META[platform]?.name || platform} disconnected`);
                        renderAccountsStatus();
                    }
                } catch (err) {
                    showToast('Disconnect failed: ' + err.message, 'error');
                }
            } else {
                // Open OAuth popup via server
                const platformName = PLATFORM_META[platform]?.name || platform;
                showToast(`Opening ${platformName} authorization…`);
                const oauthUrl = `${API_BASE}/api/oauth/${platform}/connect`;
                window.open(oauthUrl, `oauth_${platform}`, 'width=600,height=700,left=300,top=100');
            }
        });
    });
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
        var h = '<div class="op-page" style="width:816px;max-width:816px;margin:0;font-family:Inter,-apple-system,sans-serif;' + BG + 'color:#1e293b;box-sizing:border-box;padding:0;">';

        // ─── HEADER (compact) ───
        h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 28px;border-bottom:1px solid rgba(0,0,0,0.06);">';
        h += '<div style="display:flex;align-items:center;gap:8px;"><img src="' + logo + '" alt="Celeritech" style="height:28px;" crossorigin="anonymous" />';
        h += '<span style="font-size:0.65rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#1e293b;">' + companyProduct + '</span></div>';
        if (briefFor) h += '<div style="font-size:0.55rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;">' + briefFor + '</div>';
        h += '</div>';

        // ─── HERO (compact) ───
        h += '<div style="padding:14px 28px 10px;">';
        if (tags) h += '<div style="font-size:0.5rem;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#ea580c;margin-bottom:8px;">' + tags + '</div>';
        h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:1.5rem;font-weight:900;font-style:italic;line-height:1.1;margin-bottom:6px;letter-spacing:-0.02em;color:#334155;">' + headlineHtml + '</div>';
        if (subtitle) h += '<div style="font-size:0.7rem;line-height:1.5;color:#475569;margin-bottom:10px;">' + subtitle + '</div>';
        if (img) h += '<img src="' + img + '" alt="" style="width:100%;max-height:120px;object-fit:cover;border-radius:8px;margin-bottom:10px;" />';

        // ─── STATS (compact) ───
        if (stats.length > 0) {
            h += '<div style="display:flex;gap:0;margin-bottom:14px;padding:10px 0;border-top:1px solid rgba(0,0,0,0.06);border-bottom:1px solid rgba(0,0,0,0.06);">';
            for (var si = 0; si < stats.length; si++) {
                h += '<div style="flex:1;text-align:center;' + (si > 0 ? 'border-left:1px solid rgba(0,0,0,0.06);' : '') + '">';
                h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:1.4rem;font-weight:900;color:#ea580c;line-height:1;margin-bottom:2px;">' + (stats[si].value || '') + '</div>';
                h += '<div style="font-size:0.45rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#94a3b8;">' + (stats[si].label || '') + '</div></div>';
            }
            h += '</div>';
        }

        // ─── SECTIONS (compact) ───
        for (var si2 = 0; si2 < sections.length; si2++) {
            var sec = sections[si2];
            var secNum = sec.number || String(si2 + 1).padStart(2, '0');
            h += '<div style="margin-bottom:10px;">';
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

        // ─── DARK BANNER (compact) ───
        if (darkBanner.headline || (darkBanner.tags && darkBanner.tags.length)) {
            h += '<div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border-radius:8px;padding:14px 20px;margin:8px 0;">';
            if (darkBanner.headline) h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:0.85rem;font-weight:800;line-height:1.2;margin-bottom:6px;color:#f8fafc;">' + darkBanner.headline + '</div>';
            if (darkBanner.tags && darkBanner.tags.length) {
                h += '<div style="display:flex;flex-wrap:wrap;gap:4px 10px;">';
                for (var ti = 0; ti < darkBanner.tags.length; ti++) h += '<span style="font-size:0.55rem;color:#94a3b8;">' + darkBanner.tags[ti] + (ti < darkBanner.tags.length - 1 ? ' ·' : '') + '</span>';
                h += '</div>';
            }
            h += '</div>';
        }

        // ─── CTA (compact, no options) ───
        if (cta.headline) {
            h += '<div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border-radius:8px;padding:14px 20px;margin:8px 0;">';
            h += '<div style="font-family:Montserrat,Inter,sans-serif;font-size:0.85rem;font-weight:800;line-height:1.2;margin-bottom:4px;color:#f8fafc;">' + cta.headline + '</div>';
            if (cta.description) h += '<div style="font-size:0.68rem;color:#94a3b8;line-height:1.4;">' + cta.description + '</div>';
            h += '</div>';
        }

        // ─── CONTACT (compact) ───
        if (contact.email || contact.phone || contact.website) {
            h += '<div style="display:flex;gap:16px;padding:8px 0 4px;font-size:0.6rem;color:#94a3b8;">';
            if (contact.email) h += '<span>✉ ' + contact.email + '</span>';
            if (contact.phone) h += '<span>☎ ' + contact.phone + '</span>';
            if (contact.website) h += '<span>↗ ' + contact.website + '</span>';
            h += '</div>';
        }

        h += '</div></div>'; // close content + page

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
                // Scale image to fit page width, then check height
                var imgW = canvas.width;
                var imgH = canvas.height;
                var ratio = imgW / imgH;
                var fitW = pageW;
                var fitH = pageW / ratio;
                // If image is taller than page, scale to fit height instead
                if (fitH > pageH) {
                    fitH = pageH;
                    fitW = pageH * ratio;
                }
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
