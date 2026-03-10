import { marked } from 'marked';

// ─── DOM Elements ────────────────────────────────────────────────
const blogForm = document.getElementById('blogForm');
const keywordsInput = document.getElementById('keywords');
const descriptionInput = document.getElementById('description');
const wordCountInput = document.getElementById('wordCount');
const wordCountValue = document.getElementById('wordCountValue');
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
let currentPreviewLang = 'en';
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

// ─── Configure marked ────────────────────────────────────────────
marked.setOptions({
    breaks: true,
    gfm: true,
});

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
            body: JSON.stringify({ keywords, description, wordCount, target, product, trends, tone, language }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

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

    // Use the current (possibly edited) content from the preview
    const editedHtml = blogBody.innerHTML;

    publishBtn.disabled = true;
    publishBtn.querySelector('.btn-text').style.display = 'none';
    publishBtn.querySelector('.btn-loader').style.display = 'inline-flex';
    publishResult.style.display = 'none';

    try {
        // Publish English version
        const res = await fetch(`${API_BASE}/api/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: generatedBlog.title,
                htmlContent: editedHtml,
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
                body: JSON.stringify({ published: true, html: editedHtml }),
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

navItems.forEach(item => {
    item.addEventListener('click', e => {
        if (item.id === 'logoutBtn') return; // let logout happen normally

        e.preventDefault();
        const page = item.dataset.page;

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
        } else if (page === 'reddit') {
            if (pageReddit) pageReddit.style.display = '';
            if (typeof renderRedditAgents === 'function') renderRedditAgents();
            if (typeof renderRedditActivity === 'function') renderRedditActivity();
        } else if (page === 'campaign') {
            if (pageCampaign) pageCampaign.style.display = '';
        }
    });
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
    renderFilteredCalls();
    showToast('All call logs cleared');
});

// ─── Delete a Call ──────────────────────────────────────────────
async function deleteCall(callId) {
    const confirmed = await showDeleteModal('Are you sure you want to delete this call? This action cannot be undone.');
    if (!confirmed) return;
    await fetch(`${API_BASE}/api/sales/call/${callId}`, { method: 'DELETE' });
    allCalls = allCalls.filter(c => c.id !== callId);
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
    const interval = setInterval(async () => {
        if (++attempts > 60) { clearInterval(interval); return; }
        try {
            const res = await fetch(`${API_BASE}/api/sales/call/${callId}`);
            if (!res.ok) return;
            const call = await res.json();
            updateCallRow(call);
            if (!['in_progress', 'ringing', 'queued'].includes(call.status)) {
                clearInterval(interval);
                showToast(`Call to ${call.contactName || call.phoneNumber} completed`);
                await loadCallLog();
            }
        } catch { /* retry */ }
    }, 5000);
}

// ─── Load Call Log ──────────────────────────────────────────────
async function loadCallLog() {
    try {
        const res = await fetch(`${API_BASE}/api/sales/calls`);
        if (!res.ok) return;
        allCalls = await res.json();
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

    let expandContent = '';
    if (hasAnalysis) {
        const a = call.analysis;
        const interestClass = a.interestLevel === 'high' ? 'interest-high' : a.interestLevel === 'medium' ? 'interest-medium' : 'interest-low';
        expandContent = `
      <tr class="call-expand-row" id="expand-${call.id}" style="display:none;">
        <td colspan="6">
          <div class="call-expand-content">
            <div class="expand-header">
              <div class="expand-header-left">
                <h4>${call.contactName || 'Unknown'}${call.company ? ` · ${call.company}` : ''}</h4>
                ${a.interestLevel ? `<span class="interest-badge ${interestClass}">${a.interestLevel} interest</span>` : ''}
              </div>
            </div>

            ${call.recordingUrl ? `<div class="call-recording"><h4>🎙️ Recording</h4><audio controls src="${call.recordingUrl}"></audio></div>` : ''}

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
            </div>

            ${call.transcript ? `<div class="transcript-section"><h4>📝 Full Transcript</h4><div class="transcript-body">${call.transcript}</div></div>` : ''}
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
        ${hasAnalysis ? `<button class="expand-btn" data-call-id="${call.id}">▼</button>` : ''}
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
                currentPreviewLang = lang;
                langTabs.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const blogBody = document.getElementById('blogBody');
                if (lang === 'es' && spanishBlogHtml) {
                    blogBody.innerHTML = spanishBlogHtml;
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
        'fal-ai/flux/schnell': 'FLUX.1 Schnell (Fast)',
        'fal-ai/flux/dev': 'FLUX.1 Dev',
        'fal-ai/flux-pro/v1.1': 'FLUX.1 Pro v1.1',
        'fal-ai/flux-pro/v2': 'FLUX.2 Pro',
        'fal-ai/recraft-v3': 'Recraft V3',
    },
    'image-to-image': {
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
        'fal-ai/veo2/image-to-video': 'Veo 2.0',
        'fal-ai/kling-video/v1.2/pro': 'Kling 1.2 Pro (Legacy)',
    },
};

// Media DOM Elements (Redesigned)
const mediaTypeImageBtn = document.getElementById('mediaTypeImageBtn');
const mediaTypeVideoBtn = document.getElementById('mediaTypeVideoBtn');
const mediaTypeAudioBtn = document.getElementById('mediaTypeAudioBtn');
const mediaRefTriggerBtn = document.getElementById('mediaRefTriggerBtn');
const mediaRefInput = document.getElementById('mediaRefInput');
const mediaRefPreviewMini = document.getElementById('mediaRefPreviewMini');
const mediaRefImgMini = document.getElementById('mediaRefImgMini');
const mediaRefClearBtn = document.getElementById('mediaRefClearBtn');
const mediaPrompt = document.getElementById('mediaPrompt');


// Bottom Pills UI components
const mediaModelTrigger = document.getElementById('mediaModelTrigger');
const mediaModelOptions = document.getElementById('mediaModelOptions');
const mediaModelText = document.getElementById('mediaModelText');
const mediaModelHidden = document.getElementById('mediaModel');
const mediaModelDropdownWrapper = document.getElementById('mediaModelDropdownWrapper');

const mediaAspectTrigger = document.getElementById('mediaAspectTrigger');
const mediaAspectOptions = document.getElementById('mediaAspectOptions');
const mediaAspectText = document.getElementById('mediaAspectText');
const mediaAspectHidden = document.getElementById('mediaAspect');
const mediaAspectDropdownWrapper = document.getElementById('mediaAspectDropdownWrapper');

const mediaAudioBtn = document.getElementById('mediaAudioBtn');
const mediaAudioHidden = document.getElementById('mediaAudio');

const mediaDurationTrigger = document.getElementById('mediaDurationTrigger');
const mediaDurationOptions = document.getElementById('mediaDurationOptions');
const mediaDurationText = document.getElementById('mediaDurationText');
const mediaDurationHidden = document.getElementById('mediaDuration');
const mediaDurationDropdownWrapper = document.getElementById('mediaDurationDropdownWrapper');



const mediaForm = document.getElementById('mediaForm');
const mediaGenerateBtn = document.getElementById('mediaGenerateBtn');
const mediaResultContent = document.getElementById('mediaResultContent');
const mediaHistoryGrid = document.getElementById('mediaHistoryGrid');
const mediaProgressContainer = document.getElementById('mediaProgressContainer');
const mediaProgressFill = document.getElementById('mediaProgressFill');
const mediaProgressText = document.getElementById('mediaProgressText');

let currentMediaBaseType = 'video'; // 'image' or 'video'

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

const mediaTotalDurationGroup = document.getElementById('mediaTotalDurationGroup');





mediaDownloadBtn.addEventListener('click', () => {
    if (!lastMediaResultUrl) return;
    const a = document.createElement('a');
    a.href = lastMediaResultUrl;
    a.download = lastMediaIsVideo ? 'fal-video.mp4' : 'fal-image.png';
    a.click();
});

// Generate
async function handleMediaGeneration(e) {
    e.preventDefault();

    const prompt = mediaPrompt.value.trim();
    if (!prompt) {
        showToast('Please enter a prompt', 'error');
        return;
    }

    const modelId = mediaModelHidden.value;
    const inferredMode = currentMediaBaseType; // 'image', 'video', 'audio'

    // UI Loading state
    mediaGenerateBtn.disabled = true;
    mediaGenerateBtn.querySelector('.btn-text').style.display = 'none';
    mediaGenerateBtn.querySelector('.btn-loader').style.display = 'block'; // Or inline-flex depending on your CSS
    mediaProgressContainer.style.display = 'block';
    mediaProgressFill.style.width = '10%';
    mediaProgressText.textContent = 'Initializing...';
    mediaResultContent.innerHTML = '';

    const isVideo = inferredMode === 'video';
    const isAudio = inferredMode === 'audio';

    // Form Data preparation
    const requestData = {
        model: modelId,
        prompt,
        mode: inferredMode,
        aspectRatio: mediaAspectHidden.value || '16:9',
        referenceImageUrl: mediaRefImgMini.src && mediaRefImgMini.src.startsWith('data:') ? mediaRefImgMini.src : null, // Assuming you upload base64 or upload it first
    };

    if (isVideo || inferredMode === 'image-to-video' || inferredMode === 'text-to-video') {
        requestData.duration = mediaDurationHidden.value || '5';
        requestData.audio = mediaAudioHidden.value === 'true';
    }

    try {
        const res = await fetch(`${API_BASE}/api/media/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });

        if (!res.ok) {
            let errText = await res.text();
            if (res.status === 413) {
                throw new Error('Image is too large. Vercel allows max 4.5MB.');
            }
            try {
                const parsed = JSON.parse(errText);
                throw new Error(parsed.error || 'Server error');
            } catch (e) {
                // Not JSON (e.g., Vercel 502/504 HTML screen)
                throw new Error(`Server returned ${res.status}: ${errText.slice(0, 100)}`);
            }
        }

        const data = await res.json();
        if (!data.success && data.error) {
            throw new Error(data.error);
        }

        mediaProgressFill.style.width = '30%';
        mediaProgressText.textContent = 'Generating...';

        // Wait for it
        await pollMediaStatus(data.requestId, inferredMode, modelId);

    } catch (err) {
        console.error('Generation Error:', err);
        showToast(err.message || 'Generation failed', 'error');
        resetMediaBtn();
    }
}

// Generate
// ─── Helper: Poll Fal.ai status ──────────────────────────────
async function pollMediaStatus(requestId, inferredMode, modelId) {
    for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const statusRes = await fetch(`/api/media/status/${requestId}?model=${encodeURIComponent(modelId)}`);

            const contentType = statusRes.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                const data = await statusRes.json();

                if (data.status === 'COMPLETED') {
                    mediaProgressFill.style.width = '100%';
                    mediaProgressText.textContent = 'Done!';
                    handleMediaSuccess(data.result, inferredMode);
                    return;
                } else if (data.status === 'FAILED') {
                    throw new Error(data.error || 'Generation failed');
                } else if (data.status === 'IN_PROGRESS') {
                    // still polling
                    mediaProgressText.textContent = `Generating (attempt ${attempt + 1})...`;
                    mediaProgressFill.style.width = `${Math.min(95, 10 + attempt * 2)}%`;
                }
            } else {
                const errText = await statusRes.text();
                console.error("Non-JSON Response in Poll:", errText);
                throw new Error("Server returned non-JSON during polling.");
            }
        } catch (pollErr) {
            console.error("Polling error:", pollErr);
            throw pollErr;
        }
    }
    throw new Error('Generation timed out after 6 minutes');
}

function handleMediaSuccess(result, mode) {
    resetMediaBtn();
    const isVideo = mode.includes('video');
    const url = isVideo ? (result.video?.url || result.url) : (result.images?.[0]?.url || result.url);

    if (!url) {
        showToast('Generation succeeded but no URL was returned.', 'error');
        return;
    }

    // Display result
    if (isVideo) {
        mediaResultContent.innerHTML = `<video src="${url}" controls autoplay loop style="width:100%; border-radius:16px;"></video>`;
    } else {
        mediaResultContent.innerHTML = `<img src="${url}" style="width:100%; border-radius:16px; object-fit:contain;" />`;
    }

    showToast('Generation complete!', 'success');

    // Save to history
    const history = JSON.parse(localStorage.getItem('orbit_media_history') || '[]');
    history.unshift({ url, prompt: mediaPrompt.value.slice(0, 60), mode, ts: Date.now() });
    if (history.length > 50) history.pop();
    localStorage.setItem('orbit_media_history', JSON.stringify(history));
    renderMediaHistory();
}

function resetMediaBtn() {
    mediaGenerateBtn.disabled = false;
    mediaGenerateBtn.querySelector('.btn-text').style.display = 'block';
    mediaGenerateBtn.querySelector('.btn-loader').style.display = 'none';
    mediaProgressContainer.style.display = 'none';
}

function renderMediaHistory() {
    const history = JSON.parse(localStorage.getItem('orbit_media_history') || '[]');
    if (history.length === 0) {
        mediaHistoryEmpty.style.display = '';
        mediaHistoryGrid.style.display = 'none';
        return;
    }
    mediaHistoryEmpty.style.display = 'none';
    mediaHistoryGrid.style.display = 'grid';
    mediaHistoryGrid.innerHTML = history.map(item => {
        const isVid = item.mode?.includes('video');
        const media = isVid
            ? `<video src="${item.url}" muted></video>`
            : `<img src="${item.url}" alt="${item.prompt}" />`;
        return `<div class="media-history-item" onclick="window.open('${item.url}', '_blank')">
            ${media}
            <div class="media-history-label">${item.prompt}</div>
        </div>`;
    }).join('');
}
renderMediaHistory();

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
