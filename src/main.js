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
        const res = await fetch('/api/health');
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
        const res = await fetch('/api/generate', {
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

                        showState('content');
                        publishPanel.style.display = 'block';
                        showToast(`Blog generated: "${data.title}"`);
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

    publishBtn.disabled = true;
    publishBtn.querySelector('.btn-text').style.display = 'none';
    publishBtn.querySelector('.btn-loader').style.display = 'inline-flex';
    publishResult.style.display = 'none';

    try {
        const res = await fetch('/api/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: generatedBlog.title,
                htmlContent: generatedBlog.htmlContent,
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
      <a href="${result.editUrl}" target="_blank">Edit in WordPress →</a>
    `;
        publishResult.style.display = 'block';

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
