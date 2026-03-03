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
const API_BASE = 'http://localhost:3001';

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

// ─── Keyword Tags ────────────────────────────────────────────────
keywordsInput.addEventListener('input', () => {
    const keywords = keywordsInput.value.split(',').map(k => k.trim()).filter(Boolean);
    keywordTags.innerHTML = keywords
        .map(k => `<span class="keyword-tag">${k}</span>`)
        .join('');
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

    const keywords = keywordsInput.value.trim();
    const description = descriptionInput.value.trim();
    const wordCount = parseInt(wordCountInput.value);

    if (!keywords || !description) {
        showToast('Please fill in all fields', 'error');
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
            body: JSON.stringify({ keywords, description, wordCount }),
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

                        // Auto-save to blog history
                        try {
                            const saveRes = await fetch(`${API_BASE}/api/blogs`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    title: data.title,
                                    html: data.htmlContent || cleanContent,
                                    markdown: data.content,
                                    seoTitle: data.metaTitle,
                                    seoDescription: data.metaDescription,
                                    seoKeywords: data.seoKeywords,
                                    keywords, description, wordCount,
                                }),
                            });
                            const saved = await saveRes.json();
                            currentBlogId = saved.id;
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

        publishResult.className = 'publish-result success';
        publishResult.innerHTML = `
      ✓ Draft created successfully!<br/>
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

navItems.forEach(item => {
    item.addEventListener('click', e => {
        e.preventDefault();
        const page = item.dataset.page;

        // Update active nav
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Hide all pages
        pageBlog.style.display = 'none';
        pageSales.style.display = 'none';
        pagePosts.style.display = 'none';

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

// ─── Load Blog History ──────────────────────────────────────────
async function loadBlogHistory() {
    try {
        const res = await fetch(`${API_BASE}/api/blogs`);
        if (!res.ok) return;
        const blogs = await res.json();

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
        const res = await fetch(`${API_BASE}/api/blogs/${blogId}`);
        if (!res.ok) return;
        const blog = await res.json();

        currentBlogId = blog.id;
        generatedBlog = {
            title: blog.title,
            content: blog.markdown,
            htmlContent: blog.html,
            metaTitle: blog.seoTitle,
            metaDescription: blog.seoDescription,
            seoKeywords: blog.seoKeywords,
        };

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

        // Highlight active history item
        document.querySelectorAll('.blog-history-item').forEach(i => {
            i.classList.toggle('active', i.dataset.blogId === blogId);
        });

        showToast(`Loaded: "${blog.title}"`);
    } catch (err) {
        showToast('Failed to load blog', 'error');
    }
}

// ─── Delete a Blog ──────────────────────────────────────────────
async function deleteBlog(blogId) {
    const confirmed = await showDeleteModal('Are you sure you want to delete this blog? This action cannot be undone.');
    if (!confirmed) return;
    await fetch(`${API_BASE}/api/blogs/${blogId}`, { method: 'DELETE' });
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

    adEmailBtn.disabled = true;
    adEmailBtn.textContent = '📧 Sending…';

    try {
        const product = document.getElementById('adProduct').value.trim();
        const res = await fetch(`${API_BASE}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject: `Ad Creative: ${product}`,
                textContent: adFullContent,
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
    const postCount = parseInt(document.getElementById('adPostCount').value) || 3;
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

    try {
        const res = await fetch(`${API_BASE}/api/ads/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product, description, platforms, videoDuration, postCount, ctaGoal }),
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
                        adProgressFill.style.width = data.pct + '%';
                        adProgressPct.textContent = data.pct + '%';
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
        const ads = await res.json();

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
