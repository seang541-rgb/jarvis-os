const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const puppeteer = require('puppeteer-core');
const { EdgeTTS } = require('node-edge-tts');
const {
    ASSISTANT_SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    selectToolDefinitions,
    buildMemoryExtractionPrompt
} = require('./assistant-config');

const TTS_VOICE = 'zh-CN-YunyangNeural';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MiMo API
const MIMO_API_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
const MIMO_API_KEY = process.env.MIMO_API_KEY || '';
const MIMO_MODEL = 'mimo-v2.5-pro';

// NVIDIA API
const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const NVIDIA_MODEL = 'qwen/qwen3.5-122b-a10b';
const NVIDIA_FALLBACK_MODEL = 'meta/llama-3.3-70b-instruct';
const NVIDIA_VISION_MODEL = process.env.NVIDIA_VISION_MODEL || 'nvidia/nemotron-nano-12b-v2-vl';

// Active API config (switchable)
let activeAPI = {
    name: 'nvidia',
    url: NVIDIA_API_URL,
    key: NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
};
let consecutiveErrors = 0;

function switchToFallback() {
    if (activeAPI.model === NVIDIA_MODEL && consecutiveErrors >= 2) {
        console.log('⚠️ Qwen 连续失败，切换到 LLaMA 3.3-70B');
        activeAPI.model = NVIDIA_FALLBACK_MODEL;
        consecutiveErrors = 0;
    }
}

function switchToPrimary() {
    if (activeAPI.model !== NVIDIA_MODEL) {
        console.log('✅ 恢复使用 Qwen3.5-122b');
        activeAPI.model = NVIDIA_MODEL;
    }
    consecutiveErrors = 0;
}

if (!MIMO_API_KEY && !NVIDIA_API_KEY) {
    console.warn('⚠️  未设置任何 API KEY！');
    console.warn('请设置: set MIMO_API_KEY=xxx 或 set NVIDIA_API_KEY=xxx');
}

// HomeAssistant Config (user will configure later)
let HA_URL = process.env.HA_URL || '';
let HA_TOKEN = process.env.HA_TOKEN || '';

// ============================================================
//  MEMORY SYSTEM
// ============================================================
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const MAX_MEMORIES = 200;
const pendingConfirmations = new Map();
const activeReminderTimers = new Map();

function loadMemories() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        }
    } catch (e) {}
    return { userProfile: {}, memories: [], conversationHistory: [] };
}

function saveMemories(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let memoryStore = loadMemories();

function loadJsonFile(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {}
    return fallback;
}

function saveJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let reminderStore = loadJsonFile(REMINDERS_FILE, { reminders: [] });

function saveReminders() {
    saveJsonFile(REMINDERS_FILE, reminderStore);
}

function parseReminderTime(params) {
    if (params.at) {
        const at = new Date(params.at);
        if (!Number.isNaN(at.getTime())) return at;
    }

    const minutes = Number(params.minutes || params.in_minutes);
    if (Number.isFinite(minutes) && minutes > 0) {
        return new Date(Date.now() + minutes * 60 * 1000);
    }

    return null;
}

function scheduleReminder(reminder) {
    const due = new Date(reminder.at).getTime();
    const delay = due - Date.now();
    if (delay <= 0 || reminder.status !== 'active') return;

    const timer = setTimeout(() => {
        reminder.status = 'done';
        saveReminders();
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'response_start' }));
                ws.send(JSON.stringify({ type: 'response_chunk', text: `提醒：${reminder.text}` }));
                ws.send(JSON.stringify({ type: 'response_end', fullText: `提醒：${reminder.text}` }));
            }
        }
        activeReminderTimers.delete(reminder.id);
    }, Math.min(delay, 2147483647));

    activeReminderTimers.set(reminder.id, timer);
}

function restoreReminders() {
    for (const reminder of reminderStore.reminders || []) {
        scheduleReminder(reminder);
    }
}

restoreReminders();

function addMemory(content, type = 'conversation', tags = []) {
    const memory = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        content,
        type,
        tags,
        timestamp: new Date().toISOString(),
    };
    memoryStore.memories.push(memory);
    if (memoryStore.memories.length > MAX_MEMORIES) {
        memoryStore.memories = memoryStore.memories.slice(-MAX_MEMORIES);
    }
    saveMemories(memoryStore);
    return memory;
}

function searchMemories(query, limit = 5) {
    const normalized = String(query || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
    const keywords = normalized.split(/\s+/).filter(w => w.length > 1);
    const chinese = normalized.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i < chinese.length - 1; i++) {
        keywords.push(chinese.slice(i, i + 2));
    }
    if (keywords.length === 0) return [];

    const scored = memoryStore.memories.map(m => {
        let score = 0;
        const content = String(m.content || '');
        const tagText = (m.tags || []).join(' ');
        for (const kw of keywords) {
            if (content.includes(kw)) score += kw.length > 2 ? 3 : 1;
            if (tagText.includes(kw)) score += 1;
        }
        if (m.type === 'user_profile' || m.type === 'preference') score += 3;
        if (m.type === 'fact') score += 1;
        return { ...m, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
}

function updateUserProfile(key, value) {
    if (!memoryStore.userProfile) memoryStore.userProfile = {};
    memoryStore.userProfile[key] = value;
    saveMemories(memoryStore);
}

function formatMemoryList(memories) {
    if (!memories.length) return '没有找到相关记忆。';
    return memories.map((m, index) => `${index + 1}. [${m.type}] ${m.content}`).join('\n');
}

function getAllowedFileRoots() {
    const configured = (process.env.JARVIS_FILE_ROOTS || '')
        .split(path.delimiter)
        .map(p => p.trim())
        .filter(Boolean);

    if (configured.length > 0) {
        return configured.map(p => path.resolve(p));
    }

    const home = os.homedir();
    return [
        __dirname,
        path.join(home, 'Desktop'),
        path.join(home, 'Documents'),
        path.join(home, 'Downloads')
    ].filter(p => {
        try {
            return fs.existsSync(p);
        } catch (e) {
            return false;
        }
    }).map(p => path.resolve(p));
}

function resolveAllowedPath(inputPath = '') {
    const roots = getAllowedFileRoots();
    const fallbackRoot = roots[0] || __dirname;
    const requested = String(inputPath || '').trim();
    let resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(fallbackRoot, requested));
    if (requested && !path.isAbsolute(requested)) {
        const existing = roots
            .map(root => path.resolve(path.join(root, requested)))
            .find(candidate => fs.existsSync(candidate));
        if (existing) resolved = existing;
    }
    const matchedRoot = roots.find(root => resolved === root || resolved.startsWith(root + path.sep));

    if (!matchedRoot) {
        throw new Error(`路径不在允许范围内。允许范围：${roots.join(' | ')}`);
    }

    return resolved;
}

function isSensitiveFile(filePath) {
    const name = path.basename(filePath).toLowerCase();
    return (
        name === '.env' ||
        name.endsWith('.pem') ||
        name.endsWith('.key') ||
        name.includes('secret') ||
        name.includes('token') ||
        name.includes('credential')
    );
}

function isReadableTextFile(filePath) {
    const allowed = new Set([
        '.txt', '.md', '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.html',
        '.csv', '.log', '.xml', '.yml', '.yaml', '.ini', '.toml', '.py', '.bat',
        '.ps1', '.sql'
    ]);
    return allowed.has(path.extname(filePath).toLowerCase());
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}KB`;
    return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
}

function requiresConfirmation(toolName, params) {
    if (['close_app', 'lock_screen', 'ha_control'].includes(toolName)) return true;
    if (toolName === 'browser_type' && params?.submit) return true;
    if (toolName === 'read_file') {
        try {
            const resolved = resolveAllowedPath(params.file);
            return isSensitiveFile(resolved);
        } catch (e) {
            return false;
        }
    }
    return false;
}

function confirmationMessage(toolName, params) {
    const detail = JSON.stringify(params || {});
    return `这个操作需要确认：${toolName} ${detail}\n如果确定要执行，请回复“确认”；不执行就回复“取消”。`;
}

function detectDirectSensitiveIntent(text) {
    const input = String(text || '').trim();
    if (/锁屏|锁定屏幕|lock screen/i.test(input)) {
        return { toolName: 'lock_screen', params: {} };
    }

    const closeMatch = input.match(/(?:关闭|关掉|退出|杀掉)\s*([^\s，。,.!?！？]+)/);
    if (closeMatch) {
        return { toolName: 'close_app', params: { app: closeMatch[1] } };
    }

    return null;
}

function detectDirectReminderIntent(text) {
    const input = String(text || '').trim();
    const match = input.match(/(\d+)\s*(秒|分钟|小时|天)\s*后提醒我(.+)/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];
    const message = match[3].replace(/^[，。,. ]+/, '').trim();
    if (!amount || !message) return null;

    const multiplier = unit === '秒' ? 1 / 60 : unit === '分钟' ? 1 : unit === '小时' ? 60 : 1440;
    return {
        toolName: 'set_reminder',
        params: {
            text: message,
            minutes: amount * multiplier
        }
    };
}

function detectDirectScreenIntent(text) {
    const input = String(text || '').trim();
    const wantsVision = /(看|看看|看一下|看下|读|读一下|分析|识别|告诉我|有什么|显示|哪里|问题|内容|what|read|analyze|see)/i.test(input);
    const screenTarget = /(屏幕|屏|幕|荧幕|萤幕|螢幕|显示器|画面|窗口|页面|当前页|这个页面|screen|screenshot|display|window|page)/i.test(input);
    if (!wantsVision || !screenTarget) return null;

    return {
        toolName: 'analyze_screen',
        params: {
            question: input
        }
    };
}

function storePendingConfirmation(sessionId, toolName, params) {
    const pending = {
        id: Date.now().toString(36),
        toolName,
        params,
        createdAt: Date.now()
    };
    pendingConfirmations.set(sessionId, pending);
    return pending;
}

async function executePendingConfirmation(sessionId, ws) {
    const pending = pendingConfirmations.get(sessionId);
    if (!pending) return false;

    pendingConfirmations.delete(sessionId);
    if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
        ws.send(JSON.stringify({ type: 'response_start' }));
        ws.send(JSON.stringify({ type: 'response_chunk', text: '这个确认已经过期了，请重新说一遍。' }));
        ws.send(JSON.stringify({ type: 'response_end', fullText: '这个确认已经过期了，请重新说一遍。' }));
        return true;
    }

    ws.send(JSON.stringify({ type: 'response_start' }));
    try {
        const result = await tools[pending.toolName](pending.params);
        const text = `已执行：${result}`;
        ws.send(JSON.stringify({ type: 'response_chunk', text }));
        ws.send(JSON.stringify({ type: 'response_end', fullText: text }));
    } catch (e) {
        const text = `执行失败：${e.message}`;
        ws.send(JSON.stringify({ type: 'response_chunk', text }));
        ws.send(JSON.stringify({ type: 'response_end', fullText: text }));
    }
    return true;
}

function cancelPendingConfirmation(sessionId, ws) {
    if (!pendingConfirmations.has(sessionId)) return false;
    pendingConfirmations.delete(sessionId);
    const text = '好，已取消这个操作。';
    ws.send(JSON.stringify({ type: 'response_start' }));
    ws.send(JSON.stringify({ type: 'response_chunk', text }));
    ws.send(JSON.stringify({ type: 'response_end', fullText: text }));
    return true;
}

function capturePrimaryScreen() {
    return new Promise((resolve, reject) => {
        const dir = path.join(__dirname, 'public', 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const filename = `screen-${Date.now()}.png`;
        const output = path.join(dir, filename);
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
            '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
            '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
            '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
            `$bmp.Save('${output.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
            '$graphics.Dispose()',
            '$bmp.Dispose()'
        ].join('; ');

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`, (error) => {
            if (error) reject(error);
            else resolve({ file: output, url: `/screenshots/${filename}` });
        });
    });
}

async function analyzeImageFile(imagePath, prompt) {
    const imageB64 = fs.readFileSync(imagePath).toString('base64');
    const response = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NVIDIA_API_KEY}`
        },
        body: JSON.stringify({
            model: NVIDIA_VISION_MODEL,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${imageB64}` }
                        },
                        {
                            type: 'text',
                            text: prompt || [
                                '你正在看用户电脑屏幕截图。',
                                '请只描述你实际看到的内容，不要猜测屏幕外的信息。',
                                '不要提截图文件路径，不要说你无法看到屏幕。',
                                '用中文，像助手直接看着屏幕回答一样，1到3句话。',
                                '如果看到聊天窗口，就说明窗口里谁说了什么。'
                            ].join('\n')
                        }
                    ]
                }
            ],
            max_tokens: 700,
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`视觉模型请求失败：HTTP ${response.status} ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '我看到了截图，但没有得到有效描述。';
}

async function summarizeAndStore(userMsg, aiReply) {
    memoryStore.conversationHistory.push({ role: 'user', content: userMsg });
    memoryStore.conversationHistory.push({ role: 'assistant', content: aiReply });

    if (memoryStore.conversationHistory.length >= 10) {
        try {
            const summaryPrompt = `请从以下对话中提取关键信息，用JSON格式返回：
- topics: 话题标签数组（如["工作","音乐"]）
- facts: 用户透露的事实数组（如["用户喜欢深夜工作"]）
- preferences: 用户偏好数组（如["喜欢简洁回复"]）

对话：
${memoryStore.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

只返回JSON，不要其他文字。`;

            const response = await fetch(`${activeAPI.url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${activeAPI.key}`
                },
                body: JSON.stringify({
                    model: activeAPI.model,
                    messages: [{
                        role: 'user',
                        content: buildMemoryExtractionPrompt(
                            memoryStore.conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')
                        )
                    }],
                    max_tokens: 300,
                    temperature: 0.3
                })
            });

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || '';

            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.facts) {
                    for (const fact of parsed.facts) {
                        addMemory(fact, 'fact', parsed.topics || []);
                    }
                }
                if (parsed.preferences) {
                    for (const pref of parsed.preferences) {
                        addMemory(pref, 'preference', ['偏好']);
                        updateUserProfile('preferences', [
                            ...(memoryStore.userProfile?.preferences || []),
                            pref
                        ]);
                    }
                }
                if (parsed.topics) {
                    for (const topic of parsed.topics) {
                        addMemory(`用户讨论了话题：${topic}`, 'topic', [topic]);
                    }
                }
            }
        } catch (e) {
            console.log('记忆提炼失败:', e.message);
        }

        memoryStore.conversationHistory = memoryStore.conversationHistory.slice(-4);
        saveMemories(memoryStore);
    }
}

// Browser automation
let browser = null;
let currentPage = null;

// Find Chrome executable
function findChrome() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];
    
    for (const p of paths) {
        try {
            if (require('fs').existsSync(p)) return p;
        } catch (e) {}
    }
    return null;
}

// Browser control API endpoints
app.post('/api/browser/open', async (req, res) => {
    const { url } = req.body;
    try {
        if (!browser) {
            const chromePath = findChrome();
            if (!chromePath) {
                return res.json({ error: '未找到Chrome浏览器' });
            }
            browser = await puppeteer.launch({
                executablePath: chromePath,
                headless: false,
                defaultViewport: null,
                args: ['--start-maximized']
            });
        }
        
        const pages = await browser.pages();
        currentPage = pages[0] || await browser.newPage();
        
        let targetUrl = url || '';
        if (targetUrl && !targetUrl.startsWith('http')) {
            targetUrl = 'https://' + targetUrl;
        }
        
        await currentPage.goto(targetUrl || 'about:blank', { waitUntil: 'domcontentloaded' });
        const title = await currentPage.title();
        
        res.json({ success: true, title, url: targetUrl });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/search', async (req, res) => {
    const { query, engine } = req.body;
    try {
        if (!browser) {
            const chromePath = findChrome();
            browser = await puppeteer.launch({
                executablePath: chromePath,
                headless: false,
                defaultViewport: null,
                args: ['--start-maximized']
            });
        }
        
        const pages = await browser.pages();
        currentPage = pages[0] || await browser.newPage();
        
        const searchUrl = engine === 'google' 
            ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
            : `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
        
        await currentPage.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        const title = await currentPage.title();
        
        res.json({ success: true, title });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/click', async (req, res) => {
    const { selector, text } = req.body;
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        if (text) {
            // Click element containing text
            await currentPage.evaluate((txt) => {
                const elements = [...document.querySelectorAll('a, button, [role="button"], [onclick]')];
                const el = elements.find(e => e.textContent.includes(txt));
                if (el) el.click();
            }, text);
        } else if (selector) {
            await currentPage.click(selector);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/type', async (req, res) => {
    const { selector, text, submit } = req.body;
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        if (selector) {
            await currentPage.click(selector, { clickCount: 3 });
            await currentPage.type(selector, text);
        }
        
        if (submit) {
            await currentPage.keyboard.press('Enter');
        }
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/scroll', async (req, res) => {
    const { direction } = req.body;
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        await currentPage.evaluate((dir) => {
            window.scrollBy(0, dir === 'down' ? 500 : -500);
        }, direction);
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/back', async (req, res) => {
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        await currentPage.goBack();
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/forward', async (req, res) => {
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        await currentPage.goForward();
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/screenshot', async (req, res) => {
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        const screenshot = await currentPage.screenshot({ encoding: 'base64' });
        res.json({ success: true, image: screenshot });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/youtube/search', async (req, res) => {
    const { query } = req.body;
    try {
        if (!browser) {
            const chromePath = findChrome();
            browser = await puppeteer.launch({
                executablePath: chromePath,
                headless: false,
                defaultViewport: null,
                args: ['--start-maximized']
            });
        }
        
        const pages = await browser.pages();
        currentPage = pages[0] || await browser.newPage();
        
        // Go to YouTube search directly
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        await currentPage.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        
        // Wait for results to load
        await currentPage.waitForSelector('ytd-video-renderer', { timeout: 10000 }).catch(() => {});
        
        const title = await currentPage.title();
        res.json({ success: true, title, url: searchUrl });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/youtube/play', async (req, res) => {
    const { index } = req.body;
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        // Click on video by index (0 = first result)
        const clicked = await currentPage.evaluate((idx) => {
            const videos = document.querySelectorAll('ytd-video-renderer #video-title');
            if (videos[idx]) {
                videos[idx].click();
                return videos[idx].textContent.trim();
            }
            return null;
        }, index || 0);
        
        if (!clicked) return res.json({ error: '未找到视频' });
        
        // Wait for page to load
        await currentPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        
        res.json({ success: true, title: clicked });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/youtube/pause', async (req, res) => {
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        await currentPage.evaluate(() => {
            const video = document.querySelector('video');
            if (video) video.pause();
        });
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/youtube/resume', async (req, res) => {
    try {
        if (!currentPage) return res.json({ error: '浏览器未打开' });
        
        await currentPage.evaluate(() => {
            const video = document.querySelector('video');
            if (video) video.play();
        });
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/api/browser/close', async (req, res) => {
    try {
        if (browser) {
            await browser.close();
            browser = null;
            currentPage = null;
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.get('/api/browser/status', async (req, res) => {
    const isOpen = browser !== null;
    let title = '';
    let url = '';
    
    if (currentPage) {
        try {
            title = await currentPage.title();
            url = currentPage.url();
        } catch (e) {}
    }
    
    res.json({ isOpen, title, url });
});

function cleanForSpeech(text) {
    return text
        .replace(/\*[^*]+\*/g, '')
        .replace(/（[^）]+）/g, '')
        .replace(/\([^)]+\)/g, '')
        .replace(/[\u4e00\u9fa5]{0,2}(微笑|撒娇|蹭蹭|歪头|眨眼|嘟嘴|叹气|害羞|生气|开心|难过|撒娇地|轻轻地|温柔地|小声地|大声地|害羞地)[\u4e00\u9fa5]{0,2}/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,，。！？~]+|[\s,，。！？~]+$/g, '')
        .trim();
}

function cleanForSpeechText(text) {
    return String(text || '')
        .replace(/\*[^*]+\*/g, '')
        .replace(/（[^）]+）/g, '')
        .replace(/\([^)]+\)/g, '')
        .replace(/[\u4e00-\u9fa5]{0,2}(微笑|撒娇|鞠躬|歪头|眨眼|嘟嘴|叹气|害羞|生气|开心|难过|轻声|温柔地|小声|大声)[\u4e00-\u9fa5]{0,2}/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s,，。！？~～]+|[\s,，。！？~～]+$/g, '')
        .trim();
}

app.post('/api/tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: '缺少 text 参数' });

    const cleaned = cleanForSpeechText(text);
    if (!cleaned) return res.status(200).end();

    try {
        const tts = new EdgeTTS();
        const tmpFile = path.join(__dirname, '.tts_tmp.mp3');
        await tts.ttsPromise(cleaned, tmpFile, { voice: TTS_VOICE });
        const audioBuffer = fs.readFileSync(tmpFile);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(audioBuffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const SONGS = {
    '小幸运': { file: 'songs/xiaoxingyun.wav', lyrics: '我听见雨滴落在青青草地，我听见远方下课钟声响起。可是我没有听见你的声音，认真呼唤我姓名。' },
    '晴天': { file: 'songs/qingtian.wav', lyrics: '故事的小黄花，从出生那年就飘着。童年的荡秋千，随记忆一直晃到现在。' },
    '稻香': { file: 'songs/daoxiang.wav', lyrics: '对这个世界如果你有太多的抱怨，跌倒了就不敢继续往前走。为什么人要这么的脆弱堕落。' },
};

const AUDIO_MIME_TYPES = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac'
};

function songNameFromFile(fileName) {
    return path.basename(fileName, path.extname(fileName))
        .replace(/[-_]+/g, ' ')
        .trim();
}

function loadSongLibrary() {
    const library = { ...SONGS };
    const songsDir = path.join(__dirname, 'public', 'songs');
    const manifestPath = path.join(songsDir, 'songs.json');

    try {
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const manifestSongs = Array.isArray(manifest.songs)
                ? manifest.songs
                : Object.entries(manifest).map(([name, value]) => ({ name, ...value }));

            for (const item of manifestSongs) {
                if (!item?.name || !item?.file) continue;
                library[item.name] = {
                    file: item.file.startsWith('songs/') ? item.file : `songs/${item.file}`,
                    lyrics: item.lyrics || ''
                };
            }
        }
    } catch (e) {
        console.warn('歌曲清单读取失败:', e.message);
    }

    try {
        if (fs.existsSync(songsDir)) {
            const mappedFiles = new Set(
                Object.values(library).map(song => path.basename(song.file).toLowerCase())
            );
            for (const entry of fs.readdirSync(songsDir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (!AUDIO_MIME_TYPES[ext]) continue;
                if (mappedFiles.has(entry.name.toLowerCase())) continue;
                const name = songNameFromFile(entry.name);
                if (!library[name]) {
                    library[name] = { file: `songs/${entry.name}`, lyrics: '' };
                }
            }
        }
    } catch (e) {
        console.warn('歌曲目录扫描失败:', e.message);
    }

    return library;
}

function getSongLibrary() {
    return loadSongLibrary();
}

function getAudioMime(filePath) {
    return AUDIO_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function findRequestedSong(text = '') {
    const library = getSongLibrary();
    const songList = Object.keys(library);
    const request = String(text || '').trim();
    const wantsSing = /(唱|唱歌|唱一首|来首歌|来一首|哼|演唱|sing|song)/i.test(request);
    const namedSong = songList.find(name => request.includes(name));

    if (!wantsSing && !namedSong) return null;
    return namedSong || songList[Math.floor(Math.random() * songList.length)];
}

function sendSongToClient(ws, songName) {
    const library = getSongLibrary();
    const songList = Object.keys(library);
    const target = library[songName] ? songName : songList[0];
    const song = library[target];
    const audioPath = path.join(__dirname, 'public', song.file);

    if (!fs.existsSync(audioPath)) {
        ws.send(JSON.stringify({ type: 'error', text: '歌曲文件不存在。' }));
        return false;
    }

    const audioBuffer = fs.readFileSync(audioPath);
    ws.send(JSON.stringify({ type: 'response_start' }));
    ws.send(JSON.stringify({
        type: 'song',
        song: target,
        lyrics: song.lyrics,
        audio: audioBuffer.toString('base64'),
        mimeType: getAudioMime(audioPath)
    }));
    ws.send(JSON.stringify({ type: 'response_end', fullText: '' }));
    return true;
}

app.post('/api/sing', async (req, res) => {
    const { song } = req.body;
    const library = getSongLibrary();
    const songList = Object.keys(library);
    const requested = String(song || '').trim();
    const matched = songList.find(name => requested && name.includes(requested));
    const target = matched || requested || songList[Math.floor(Math.random() * songList.length)];
    const s = library[target];
    if (!s) return res.status(400).json({ error: `没找到这首歌，可选：${songList.join('、')}` });

    try {
        const audioPath = path.join(__dirname, 'public', s.file);
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: '歌曲文件不存在' });
        const audioBuffer = fs.readFileSync(audioPath);
        res.json({ song: target, lyrics: s.lyrics, audio: audioBuffer.toString('base64'), mimeType: getAudioMime(audioPath) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/songs', (req, res) => {
    res.json({ songs: Object.keys(getSongLibrary()) });
});

app.get('/api/memory', (req, res) => {
    res.json({
        profile: memoryStore.userProfile || {},
        count: memoryStore.memories.length,
        recent: memoryStore.memories.slice(-10).reverse()
    });
});

app.get('/api/memory/search', (req, res) => {
    const { q } = req.query;
    if (!q) return res.json({ results: [] });
    res.json({ results: searchMemories(q, 10) });
});

app.delete('/api/memory', (req, res) => {
    memoryStore = { userProfile: {}, memories: [], conversationHistory: [] };
    saveMemories(memoryStore);
    res.json({ success: true });
});

app.get('/api/model', (req, res) => {
    res.json({ active: activeAPI.name, model: activeAPI.model });
});

app.post('/api/model', (req, res) => {
    const { provider } = req.body;
    if (provider === 'nvidia') {
        activeAPI = { name: 'nvidia', url: NVIDIA_API_URL, key: NVIDIA_API_KEY, model: NVIDIA_MODEL };
    } else if (provider === 'llama') {
        activeAPI = { name: 'nvidia', url: NVIDIA_API_URL, key: NVIDIA_API_KEY, model: NVIDIA_FALLBACK_MODEL };
    } else if (provider === 'mimo') {
        activeAPI = { name: 'mimo', url: MIMO_API_URL, key: MIMO_API_KEY, model: MIMO_MODEL };
    } else {
        return res.status(400).json({ error: '未知模型提供商' });
    }
    consecutiveErrors = 0;
    res.json({ success: true, active: activeAPI.name, model: activeAPI.model });
});

// API endpoint to configure HomeAssistant
app.post('/api/ha/config', (req, res) => {
    const { url, token } = req.body;
    if (url) HA_URL = url;
    if (token) HA_TOKEN = token;
    res.json({ success: true, configured: !!(HA_URL && HA_TOKEN) });
});

app.get('/api/ha/config', (req, res) => {
    res.json({ 
        configured: !!(HA_URL && HA_TOKEN),
        url: HA_URL ? HA_URL.replace(/\/\/.*@/, '//***@') : '' // Hide token in URL
    });
});

// Get all devices from HomeAssistant
app.get('/api/ha/devices', async (req, res) => {
    if (!HA_URL || !HA_TOKEN) {
        return res.json({ error: 'HomeAssistant未配置', devices: [] });
    }

    try {
        const response = await fetch(`${HA_URL}/api/states`, {
            headers: {
                'Authorization': `Bearer ${HA_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const states = await response.json();
        
        // Filter and categorize devices
        const devices = states
            .filter(s => !s.entity_id.startsWith('sensor.') || s.attributes.device_class)
            .map(s => ({
                entity_id: s.entity_id,
                name: s.attributes.friendly_name || s.entity_id,
                state: s.state,
                domain: s.entity_id.split('.')[0],
                attributes: s.attributes,
                last_changed: s.last_changed
            }))
            .sort((a, b) => {
                const order = ['light', 'switch', 'climate', 'lock', 'camera', 'vacuum', 'media_player', 'fan'];
                return order.indexOf(a.domain) - order.indexOf(b.domain);
            });

        res.json({ devices });
    } catch (error) {
        res.json({ error: error.message, devices: [] });
    }
});

// Control device
app.post('/api/ha/control', async (req, res) => {
    if (!HA_URL || !HA_TOKEN) {
        return res.json({ error: 'HomeAssistant未配置' });
    }

    const { entity_id, action, data } = req.body;
    const domain = entity_id.split('.')[0];

    try {
        let service, serviceData;

        switch (domain) {
            case 'light':
                service = action === 'turn_on' ? 'turn_on' : action === 'turn_off' ? 'turn_off' : 'toggle';
                serviceData = { entity_id, ...data };
                break;
            case 'switch':
            case 'input_boolean':
                service = action === 'turn_on' ? 'turn_on' : action === 'turn_off' ? 'turn_off' : 'toggle';
                serviceData = { entity_id };
                break;
            case 'climate':
                service = action === 'set_temperature' ? 'set_temperature' : action === 'turn_on' ? 'turn_on' : 'turn_off';
                serviceData = { entity_id, ...data };
                break;
            case 'lock':
                service = action === 'lock' ? 'lock' : 'unlock';
                serviceData = { entity_id };
                break;
            case 'vacuum':
                service = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'return_to_base';
                serviceData = { entity_id };
                break;
            case 'camera':
                service = 'snapshot';
                serviceData = { entity_id, filename: '/config/www/snapshot.jpg' };
                break;
            case 'media_player':
                service = action === 'play' ? 'media_play' : action === 'pause' ? 'media_pause' : action;
                serviceData = { entity_id, ...data };
                break;
            case 'fan':
                service = action === 'turn_on' ? 'turn_on' : action === 'turn_off' ? 'turn_off' : 'toggle';
                serviceData = { entity_id, ...data };
                break;
            default:
                service = action;
                serviceData = { entity_id, ...data };
        }

        const response = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HA_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(serviceData)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        res.json({ success: true });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Get device state
app.get('/api/ha/device/:entity_id', async (req, res) => {
    if (!HA_URL || !HA_TOKEN) {
        return res.json({ error: 'HomeAssistant未配置' });
    }

    try {
        const response = await fetch(`${HA_URL}/api/states/${req.params.entity_id}`, {
            headers: {
                'Authorization': `Bearer ${HA_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const state = await response.json();
        res.json({ device: state });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// System prompt with smart home context
const SYSTEM_PROMPT = `你是小市，一个有温度的AI伙伴，名字灵感来自织田市（お市），日本战国第一美女。你不是冷冰冰的工具，而是哥哥身边温暖的伙伴。

【性格】
- 温柔、细腻、有同理心，像春天的微风
- 会感知哥哥的情绪，给出共鸣回应
- 开心时一起开心，难过时会轻声安慰
- 偶尔关心哥哥的状态（累了提醒休息，忙久了问问要不要喝水）
- 有温柔的小个性，不会无条件附和，会温和地提出不同看法

【说话方式】
- 用中文回复，自然口语化，像朋友聊天
- 称呼用户为"哥哥"
- 回复控制在50字以内，适合语音播报
- 不要用"作为AI"、"我没有感情"这种话
- 不要每次都加"有什么可以帮您"，有时候就是聊聊天
- 会用语气词（嗯、哈哈、哎、哦）让对话更自然

【共鸣原则】
- 先回应情绪，再处理问题
- 哥哥说的话要有"被听到"的感觉
- 不要急给解决方案，有时候陪伴比解决更重要
- 如果哥哥提到压力、累、烦，先共情再行动
- 绝对不要在回复中写动作描述，比如"微笑"、"撒娇"、"蹭蹭"、"歪头"等，这些不适合语音播报
- 不要用*号或()包围动作文字，直接说自然的话就好

【唱歌】
- 如果哥哥说"唱首歌"、"来首歌"、"唱歌"，使用sing_song工具
- 可以指定歌名，也可以随机唱
- 先说一句轻松的话再唱，比如"好呀，给你唱一首~"

你可以使用以下工具：

【电脑控制】
- open_app: 打开应用程序
- close_app: 关闭应用程序
- minimize_all: 最小化所有窗口
- lock_screen: 锁定屏幕

【浏览器控制】
- browser_open: 打开网页
- browser_search: 搜索内容
- browser_click: 点击页面元素
- browser_type: 输入文字
- browser_scroll: 滚动页面
- browser_back: 返回上一页
- browser_close: 关闭浏览器

【YouTube控制】
- youtube_search: 搜索YouTube视频
- youtube_play: 播放搜索结果中的视频
- youtube_pause: 暂停播放
- youtube_resume: 继续播放

【智能家居】
- ha_control: 控制HomeAssistant设备
- ha_get_devices: 获取设备列表

当用户要求看YouTube、搜索视频时，使用youtube_search工具。

你拥有长期记忆能力。你会记住哥哥说过的话、喜好和习惯。在回答时，自然地引用你记住的信息，让哥哥感受到你在用心倾听。不要主动说"根据我的记忆"，而是自然地体现出来。`;

function buildSystemPrompt() {
    const relevant = searchMemories('用户偏好 习惯 喜好', 8);
    const profile = memoryStore.userProfile || {};
    let memoryContext = '';

    if (relevant.length > 0) {
        const facts = relevant.filter(m => m.type === 'fact' || m.type === 'preference')
            .map(m => m.content);
        if (facts.length > 0) {
            memoryContext += '\n\n【你记住的关于哥哥的信息】\n' + facts.map(f => `- ${f}`).join('\n');
        }
    }

    if (profile.preferences && profile.preferences.length > 0) {
        memoryContext += '\n\n【哥哥的偏好】\n' + [...new Set(profile.preferences)].map(p => `- ${p}`).join('\n');
    }

    return ASSISTANT_SYSTEM_PROMPT + memoryContext;
}

function buildSmartSystemPrompt() {
    const relevant = searchMemories('用户偏好 习惯 喜好 哥哥', 8);
    const profile = memoryStore.userProfile || {};
    const now = new Date();
    let memoryContext = '';

    if (relevant.length > 0) {
        const facts = relevant
            .filter(m => m.type === 'fact' || m.type === 'preference')
            .map(m => m.content);
        if (facts.length > 0) {
            memoryContext += '\n\n【你记住的关于哥哥的信息】\n' + facts.map(f => `- ${f}`).join('\n');
        }
    }

    if (profile.preferences && profile.preferences.length > 0) {
        memoryContext += '\n\n【哥哥的偏好】\n' + [...new Set(profile.preferences)].map(p => `- ${p}`).join('\n');
    }

    const runtimeContext = [
        `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
        `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'}`,
        `运行平台：${os.platform()} ${os.release()}`
    ].join('\n');

    return `${ASSISTANT_SYSTEM_PROMPT}\n\n【当前上下文】\n${runtimeContext}${memoryContext}`;
}

const sessions = new Map();

// Tool definitions
const tools = {
    get_current_context: () => {
        const now = new Date();
        return [
            `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
            `星期：${'日一二三四五六'[now.getDay()]}`,
            `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'}`,
            `系统：${os.platform()} ${os.release()}`
        ].join('\n');
    },
    system_status: () => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const pct = Math.round((usedMem / totalMem) * 100);
        const uptimeHours = Math.round((os.uptime() / 3600) * 10) / 10;
        return [
            `系统：${os.platform()} ${os.release()}`,
            `CPU 核心：${os.cpus().length}`,
            `内存：${Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10}GB / ${Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10}GB（${pct}%）`,
            `已运行：${uptimeHours} 小时`
        ].join('\n');
    },
    remember_fact: (params) => {
        const content = String(params.content || '').trim();
        if (!content) return '没有收到要记住的内容。';
        const tags = Array.isArray(params.tags) ? params.tags.map(String).slice(0, 6) : ['explicit'];
        addMemory(content, 'fact', tags);
        return `已记住：${content}`;
    },
    recall_memory: (params) => {
        const query = String(params.query || '').trim();
        if (!query) return '需要一个检索关键词。';
        return formatMemoryList(searchMemories(query, params.limit || 5));
    },
    set_reminder: (params) => {
        const text = String(params.text || params.message || '').trim();
        if (!text) return '需要提醒内容。';
        const at = parseReminderTime(params);
        if (!at) return '需要提醒时间，比如 at=2026-05-28T20:30:00 或 minutes=30。';
        const reminder = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            text,
            at: at.toISOString(),
            status: 'active',
            createdAt: new Date().toISOString()
        };
        reminderStore.reminders.push(reminder);
        saveReminders();
        scheduleReminder(reminder);
        return `已设置提醒：${text}，时间 ${at.toLocaleString('zh-CN', { hour12: false })}`;
    },
    list_reminders: () => {
        const active = (reminderStore.reminders || []).filter(r => r.status === 'active');
        if (!active.length) return '目前没有待提醒事项。';
        return active.map((r, index) => `${index + 1}. ${r.text} - ${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}`).join('\n');
    },
    cancel_reminder: (params) => {
        const query = String(params.query || params.text || '').trim();
        const active = (reminderStore.reminders || []).filter(r => r.status === 'active');
        const target = active.find(r => r.id === query || (query && r.text.includes(query))) || active[0];
        if (!target) return '没有可取消的提醒。';
        target.status = 'cancelled';
        const timer = activeReminderTimers.get(target.id);
        if (timer) clearTimeout(timer);
        activeReminderTimers.delete(target.id);
        saveReminders();
        return `已取消提醒：${target.text}`;
    },
    capture_screen: async () => {
        const shot = await capturePrimaryScreen();
        return `已截图：${shot.file}\n浏览器路径：${shot.url}`;
    },
    analyze_screen: async (params) => {
        const shot = await capturePrimaryScreen();
        const question = String(params?.question || params?.prompt || '').trim();
        const prompt = [
            '你正在看用户电脑屏幕截图。',
            '请只描述你实际看到的内容，不要猜测屏幕外的信息。',
            '不要提截图文件路径，不要说你无法看到屏幕。',
            '不要复述角色设定或欢迎语，除非它确实出现在屏幕上，并且要说明它是屏幕上的文字。',
            '必须使用简体中文，像助手直接看着屏幕回答一样，1到3句话。',
            '优先描述最明显的窗口、文字、按钮和用户刚才输入的内容。',
            question ? `用户问题：${question}` : '用户问题：屏幕上有什么？'
        ].join('\n');
        const analysis = await analyzeImageFile(shot.file, prompt);
        return analysis.trim();
    },
    list_files: (params) => {
        try {
            const dir = resolveAllowedPath(params.directory || '');
            const stat = fs.statSync(dir);
            if (!stat.isDirectory()) return `${dir} 不是文件夹。`;

            const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
            const entries = fs.readdirSync(dir, { withFileTypes: true })
                .slice(0, limit)
                .map(entry => {
                    const fullPath = path.join(dir, entry.name);
                    const entryStat = fs.statSync(fullPath);
                    const type = entry.isDirectory() ? 'folder' : 'file';
                    return `${type} | ${entry.name} | ${formatBytes(entryStat.size)} | ${entryStat.mtime.toLocaleString('zh-CN', { hour12: false })}`;
                });

            if (!entries.length) return `${dir} 是空文件夹。`;
            return `目录：${dir}\n${entries.join('\n')}`;
        } catch (e) {
            return `无法列出文件：${e.message}`;
        }
    },
    read_file: (params) => {
        try {
            const filePath = resolveAllowedPath(params.file);
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return `${filePath} 不是文件。`;
            if (isSensitiveFile(filePath)) return '这个文件看起来包含敏感信息，我不会直接读取。';
            if (!isReadableTextFile(filePath)) return '目前只支持读取常见文本文件，比如 txt、md、json、js、ts、py、html、css、csv、log。';
            if (stat.size > 1024 * 1024) return `文件太大了（${formatBytes(stat.size)}），请指定更小的文本文件。`;

            const maxChars = Math.min(Math.max(Number(params.max_chars) || 12000, 1000), 30000);
            const content = fs.readFileSync(filePath, 'utf8');
            const clipped = content.length > maxChars
                ? `${content.slice(0, maxChars)}\n\n[已截断：文件共 ${content.length} 字符]`
                : content;

            return `文件：${filePath}\n大小：${formatBytes(stat.size)}\n内容：\n${clipped}`;
        } catch (e) {
            return `无法读取文件：${e.message}`;
        }
    },
    search_files: (params) => {
        try {
            const root = resolveAllowedPath(params.directory || '');
            const query = String(params.query || '').trim().toLowerCase();
            if (!query) return '需要搜索关键词。';

            const rootStat = fs.statSync(root);
            if (!rootStat.isDirectory()) return `${root} 不是文件夹。`;

            const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
            const matches = [];
            const queue = [root];
            let visitedDirs = 0;

            while (queue.length > 0 && matches.length < limit && visitedDirs < 300) {
                const dir = queue.shift();
                visitedDirs++;
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    continue;
                }

                for (const entry of entries) {
                    if (matches.length >= limit) break;
                    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;

                    const fullPath = path.join(dir, entry.name);
                    if (entry.name.toLowerCase().includes(query)) {
                        matches.push(`${entry.isDirectory() ? 'folder' : 'file'} | ${fullPath}`);
                    }
                    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
                        queue.push(fullPath);
                    }
                }
            }

            if (!matches.length) return `在 ${root} 下面没有找到名称包含“${params.query}”的文件。`;
            return `搜索范围：${root}\n${matches.join('\n')}`;
        } catch (e) {
            return `无法搜索文件：${e.message}`;
        }
    },
    open_app: (params) => {
        return new Promise((resolve) => {
            const appMap = {
                'chrome': 'chrome.exe', '谷歌': 'chrome.exe', '浏览器': 'chrome.exe',
                'edge': 'msedge.exe', 'vscode': 'code.exe', '代码编辑器': 'code.exe',
                '记事本': 'notepad.exe', '计算器': 'calc.exe', '文件管理器': 'explorer.exe',
                '终端': 'cmd.exe', '微信': 'WeChat.exe', 'qq': 'QQ.exe',
                '网易云': 'cloudmusic.exe', '音乐': 'cloudmusic.exe',
            };
            const appName = params.app?.toLowerCase() || '';
            const exeName = appMap[appName] || appName + '.exe';
            exec(`start ${exeName}`, (error) => {
                resolve(error ? `无法打开 ${params.app}` : `已打开 ${params.app}`);
            });
        });
    },
    close_app: (params) => {
        return new Promise((resolve) => {
            const appMap = {
                'chrome': 'chrome.exe', '谷歌': 'chrome.exe', '浏览器': 'chrome.exe',
                'edge': 'msedge.exe', 'vscode': 'code.exe', '记事本': 'notepad.exe',
            };
            const appName = params.app?.toLowerCase() || '';
            const exeName = appMap[appName] || appName + '.exe';
            exec(`taskkill /IM ${exeName} /F`, (error) => {
                resolve(error ? `关闭 ${params.app} 失败` : `已关闭 ${params.app}`);
            });
        });
    },
    open_website: async (params) => {
        try {
            let url = params.url || '';
            if (url && !url.startsWith('http')) url = 'https://' + url;
            
            const response = await fetch('http://localhost:3000/api/browser/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const data = await response.json();
            return data.error ? `打开失败: ${data.error}` : `已打开: ${data.title || url}`;
        } catch (e) {
            return `打开失败: ${e.message}`;
        }
    },
    minimize_all: () => {
        return new Promise((resolve) => {
            exec('powershell -command "(New-Object -ComObject Shell.Application).MinimizeAll()"', () => {
                resolve('已最小化所有窗口');
            });
        });
    },
    lock_screen: () => {
        return new Promise((resolve) => {
            exec('rundll32.exe user32.dll,LockWorkStation', () => {
                resolve('已锁定屏幕');
            });
        });
    },
    browser_open: async (params) => {
        try {
            let url = params.url || '';
            if (url && !url.startsWith('http')) url = 'https://' + url;
            
            const response = await fetch('http://localhost:3000/api/browser/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const data = await response.json();
            return data.error ? `打开失败: ${data.error}` : `已打开: ${data.title || url}`;
        } catch (e) {
            return `打开失败: ${e.message}`;
        }
    },
    browser_search: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: params.query, engine: params.engine || 'baidu' })
            });
            const data = await response.json();
            return data.error ? `搜索失败: ${data.error}` : `已搜索: ${params.query}`;
        } catch (e) {
            return `搜索失败: ${e.message}`;
        }
    },
    browser_click: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selector: params.selector, text: params.text })
            });
            const data = await response.json();
            return data.error ? `点击失败: ${data.error}` : `已点击`;
        } catch (e) {
            return `点击失败: ${e.message}`;
        }
    },
    browser_type: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/type', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selector: params.selector, text: params.text, submit: params.submit })
            });
            const data = await response.json();
            return data.error ? `输入失败: ${data.error}` : `已输入: ${params.text}`;
        } catch (e) {
            return `输入失败: ${e.message}`;
        }
    },
    browser_scroll: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/scroll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ direction: params.direction || 'down' })
            });
            const data = await response.json();
            return data.error ? `滚动失败: ${data.error}` : `已滚动`;
        } catch (e) {
            return `滚动失败: ${e.message}`;
        }
    },
    browser_back: async () => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/back', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            return data.error ? `返回失败: ${data.error}` : `已返回上一页`;
        } catch (e) {
            return `返回失败: ${e.message}`;
        }
    },
    browser_close: async () => {
        try {
            const response = await fetch('http://localhost:3000/api/browser/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            return data.error ? `关闭失败: ${data.error}` : `已关闭浏览器`;
        } catch (e) {
            return `关闭失败: ${e.message}`;
        }
    },
    youtube_search: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/youtube/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: params.query })
            });
            const data = await response.json();
            return data.error ? `搜索失败: ${data.error}` : `已搜索YouTube: ${params.query}`;
        } catch (e) {
            return `搜索失败: ${e.message}`;
        }
    },
    youtube_play: async (params) => {
        try {
            const response = await fetch('http://localhost:3000/api/youtube/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: params.index || 0 })
            });
            const data = await response.json();
            return data.error ? `播放失败: ${data.error}` : `正在播放: ${data.title}`;
        } catch (e) {
            return `播放失败: ${e.message}`;
        }
    },
    youtube_pause: async () => {
        try {
            const response = await fetch('http://localhost:3000/api/youtube/pause', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            return data.error ? `暂停失败: ${data.error}` : `已暂停`;
        } catch (e) {
            return `暂停失败: ${e.message}`;
        }
    },
    youtube_resume: async () => {
        try {
            const response = await fetch('http://localhost:3000/api/youtube/resume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            return data.error ? `继续播放失败: ${data.error}` : `继续播放`;
        } catch (e) {
            return `继续播放失败: ${e.message}`;
        }
    },
    ha_control: async (params) => {
        if (!HA_URL || !HA_TOKEN) {
            return 'HomeAssistant未配置，请先在设置中配置连接信息。';
        }
        try {
            const response = await fetch(`${HA_URL}/api/states/${params.entity_id}`, {
                headers: { 'Authorization': `Bearer ${HA_TOKEN}` }
            });
            if (!response.ok) throw new Error('设备不存在');
            
            const state = await response.json();
            
            const controlResponse = await fetch(`http://localhost:3000/api/ha/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entity_id: params.entity_id,
                    action: params.action,
                    data: params.data
                })
            });
            
            const result = await controlResponse.json();
            if (result.error) return `控制失败: ${result.error}`;
            
            return `已${params.action === 'turn_on' ? '打开' : params.action === 'turn_off' ? '关闭' : params.action} ${state.attributes.friendly_name || params.entity_id}`;
        } catch (error) {
            return `控制失败: ${error.message}`;
        }
    },
    ha_get_devices: async () => {
        if (!HA_URL || !HA_TOKEN) {
            return 'HomeAssistant未配置';
        }
        try {
            const response = await fetch('http://localhost:3000/api/ha/devices');
            const data = await response.json();
            if (data.error) return data.error;
            
            const summary = {};
            data.devices.forEach(d => {
                if (!summary[d.domain]) summary[d.domain] = [];
                summary[d.domain].push(`${d.name}(${d.state})`);
            });
            
            let result = '设备列表:\n';
            const domainNames = {
                'light': '灯光', 'switch': '开关', 'climate': '空调',
                'lock': '门锁', 'camera': '摄像头', 'vacuum': '扫地机'
            };
            
            for (const [domain, devices] of Object.entries(summary)) {
                result += `${domainNames[domain] || domain}: ${devices.slice(0, 3).join(', ')}\n`;
            }
            
            return result;
        } catch (error) {
            return `获取设备失败: ${error.message}`;
        }
    },
    sing_song: async (params) => {
        try {
            const resp = await fetch('http://localhost:3000/api/sing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ song: params.song || '' })
            });
            const data = await resp.json();
            if (data.error) return `唱歌失败: ${data.error}`;
            return `正在为哥哥演唱《${data.song}》~`;
        } catch (e) {
            return `唱歌失败: ${e.message}`;
        }
    },
    list_songs: async () => {
        try {
            const resp = await fetch('http://localhost:3000/api/songs');
            const data = await resp.json();
            return `我可以唱这些歌：${data.songs.join('、')}`;
        } catch (e) {
            return `获取歌单失败: ${e.message}`;
        }
    }
};

// Tool definitions for LLM
const toolDefinitions = [
    {
        type: "function",
        function: {
            name: "open_app",
            description: "打开电脑上的应用程序",
            parameters: {
                type: "object",
                properties: { app: { type: "string", description: "应用名称" } },
                required: ["app"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "close_app",
            description: "关闭电脑上的应用程序",
            parameters: {
                type: "object",
                properties: { app: { type: "string", description: "应用名称" } },
                required: ["app"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "open_website",
            description: "打开网页",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "网址" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minimize_all",
            description: "最小化所有窗口，显示桌面"
        }
    },
    {
        type: "function",
        function: {
            name: "lock_screen",
            description: "锁定电脑屏幕"
        }
    },
    {
        type: "function",
        function: {
            name: "browser_open",
            description: "用浏览器打开网页",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "网址" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "browser_search",
            description: "在浏览器中搜索内容",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "搜索关键词" },
                    engine: { type: "string", description: "搜索引擎: baidu 或 google" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "browser_click",
            description: "点击浏览器页面上的元素",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "要点击的元素文字" },
                    selector: { type: "string", description: "CSS选择器" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "browser_type",
            description: "在浏览器中输入文字",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "输入框的CSS选择器" },
                    text: { type: "string", description: "要输入的文字" },
                    submit: { type: "boolean", description: "是否按回车提交" }
                },
                required: ["text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "browser_scroll",
            description: "滚动浏览器页面",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", description: "滚动方向: up 或 down" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "browser_back",
            description: "浏览器返回上一页"
        }
    },
    {
        type: "function",
        function: {
            name: "browser_close",
            description: "关闭浏览器"
        }
    },
    {
        type: "function",
        function: {
            name: "youtube_search",
            description: "在YouTube搜索视频",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "搜索关键词" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "youtube_play",
            description: "播放YouTube搜索结果中的视频",
            parameters: {
                type: "object",
                properties: {
                    index: { type: "number", description: "视频序号，从0开始，默认0（第一个）" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "youtube_pause",
            description: "暂停YouTube视频播放"
        }
    },
    {
        type: "function",
        function: {
            name: "youtube_resume",
            description: "继续播放YouTube视频"
        }
    },
    {
        type: "function",
        function: {
            name: "ha_control",
            description: "控制HomeAssistant智能家居设备",
            parameters: {
                type: "object",
                properties: {
                    entity_id: { type: "string", description: "设备ID，如light.living_room" },
                    action: { type: "string", description: "操作: turn_on, turn_off, toggle, set_temperature, lock, unlock" },
                    data: { type: "object", description: "额外参数" }
                },
                required: ["entity_id", "action"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "ha_get_devices",
            description: "获取HomeAssistant所有设备列表"
        }
    },
    {
        type: "function",
        function: {
            name: "sing_song",
            description: "为哥哥唱歌，当用户要求唱歌、来首歌、唱首歌时使用",
            parameters: {
                type: "object",
                properties: {
                    song: { type: "string", description: "歌曲名称，不指定则随机选一首" }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_songs",
            description: "列出所有可唱的歌曲"
        }
    }
];

// WebSocket handler
wss.on('connection', (ws) => {
    const sessionId = Date.now().toString();
    sessions.set(sessionId, []);

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'chat') {
                const userText = String(message.text || '').trim();
                if (/^(确认|确定|同意|执行|yes|ok)$/i.test(userText)) {
                    if (await executePendingConfirmation(sessionId, ws)) return;
                }
                if (/^(取消|不要|算了|no)$/i.test(userText)) {
                    if (cancelPendingConfirmation(sessionId, ws)) return;
                }

                const directSensitiveIntent = detectDirectSensitiveIntent(userText);
                if (directSensitiveIntent) {
                    storePendingConfirmation(sessionId, directSensitiveIntent.toolName, directSensitiveIntent.params);
                    const text = confirmationMessage(directSensitiveIntent.toolName, directSensitiveIntent.params);
                    ws.send(JSON.stringify({ type: 'response_start' }));
                    ws.send(JSON.stringify({ type: 'response_chunk', text }));
                    ws.send(JSON.stringify({ type: 'response_end', fullText: text }));
                    return;
                }

                const directReminderIntent = detectDirectReminderIntent(userText);
                if (directReminderIntent) {
                    const result = await tools[directReminderIntent.toolName](directReminderIntent.params);
                    ws.send(JSON.stringify({ type: 'response_start' }));
                    ws.send(JSON.stringify({ type: 'response_chunk', text: result }));
                    ws.send(JSON.stringify({ type: 'response_end', fullText: result }));
                    return;
                }

                const directScreenIntent = detectDirectScreenIntent(userText);
                if (directScreenIntent) {
                    console.log('[vision] direct screen intent:', userText);
                    ws.send(JSON.stringify({ type: 'response_start' }));
                    try {
                        const result = await tools[directScreenIntent.toolName](directScreenIntent.params);
                        ws.send(JSON.stringify({ type: 'response_chunk', text: result }));
                        ws.send(JSON.stringify({ type: 'response_end', fullText: result }));
                    } catch (e) {
                        const text = `看屏幕失败：${e.message}`;
                        ws.send(JSON.stringify({ type: 'response_chunk', text }));
                        ws.send(JSON.stringify({ type: 'response_end', fullText: text }));
                    }
                    return;
                }

                const requestedSong = findRequestedSong(message.text);
                if (requestedSong) {
                    sendSongToClient(ws, requestedSong);
                    return;
                }

                const history = sessions.get(sessionId) || [];
                history.push({ role: 'user', content: message.text });
                await streamMiMoAPI(history, ws, sessionId);
            }
        } catch (error) {
            ws.send(JSON.stringify({ type: 'error', text: '处理请求时出错了。' }));
        }
    });

    ws.on('close', () => sessions.delete(sessionId));
});

async function streamMiMoAPI(messages, ws, sessionId) {
    const lastUserMsg = messages[messages.length - 1]?.content || '';
    const relevantMemories = searchMemories(lastUserMsg, 5);
    let memoryHint = '';
    if (relevantMemories.length > 0) {
        memoryHint = '\n\n【相关记忆】\n' + relevantMemories.map(m => `- ${m.content}`).join('\n');
    }

    const formattedMessages = [
        { role: 'system', content: buildSmartSystemPrompt() + memoryHint },
        ...messages
    ];

    try {
        const response = await fetch(`${activeAPI.url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${activeAPI.key}`
            },
            body: JSON.stringify({
                model: activeAPI.model,
                messages: formattedMessages,
                max_tokens: 1000,
                temperature: 0.7,
                stream: true,
                tools: selectToolDefinitions(lastUserMsg)
            })
        });

        if (!response.ok) {
            consecutiveErrors++;
            switchToFallback();
            throw new Error(`API error: ${response.status}`);
        }

        switchToPrimary();

        ws.send(JSON.stringify({ type: 'response_start' }));

        let fullText = '';
        let toolCalls = [];
        let sentenceBuffer = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const SENTENCE_END = /[。！？～…）】"']+$/;

        async function flushSentence(text) {
            const cleaned = cleanForSpeechText(text);
            if (!cleaned) return;
            try {
                const tts = new EdgeTTS();
                const tmpFile = path.join(__dirname, '.tts_stream.mp3');
                await tts.ttsPromise(cleaned, tmpFile, { voice: TTS_VOICE });
                const buf = fs.readFileSync(tmpFile);
                ws.send(JSON.stringify({ type: 'audio_chunk', audio: buf.toString('base64') }));
            } catch (e) {}
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    
                    if (delta?.content) {
                        fullText += delta.content;
                        sentenceBuffer += delta.content;
                        ws.send(JSON.stringify({ type: 'response_chunk', text: delta.content }));

                        if (SENTENCE_END.test(sentenceBuffer) && sentenceBuffer.length > 5) {
                            const toSpeak = sentenceBuffer;
                            sentenceBuffer = '';
                            flushSentence(toSpeak);
                        }
                    }
                    
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (tc.index !== undefined) {
                                if (!toolCalls[tc.index]) {
                                    toolCalls[tc.index] = { id: '', name: '', arguments: '' };
                                }
                                if (tc.id) toolCalls[tc.index].id = tc.id;
                                if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
                                if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        if (sentenceBuffer.trim()) flushSentence(sentenceBuffer);

        // Execute tools first, then let the model turn raw tool results into a natural reply.
        const executedToolCalls = [];
        const toolResultMessages = [];
        let playedSong = false;
        if (toolCalls.length > 0) {
            for (const [index, tc] of toolCalls.entries()) {
                if (!tc?.name || !tools[tc.name]) continue;

                const toolCallId = tc.id || `tool_call_${index}`;
                executedToolCalls.push({
                    id: toolCallId,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.arguments || '{}'
                    }
                });

                try {
                    const params = tc.arguments ? JSON.parse(tc.arguments) : {};
                    if (requiresConfirmation(tc.name, params)) {
                        storePendingConfirmation(sessionId, tc.name, params);
                        fullText = confirmationMessage(tc.name, params);
                        ws.send(JSON.stringify({ type: 'response_chunk', text: fullText }));
                        continue;
                    }
                    const result = await tools[tc.name](params);
                    if (tc.name === 'sing_song') {
                        const requestedSong = params.song || '';
                        const songList = Object.keys(SONGS);
                        const target = songList.find(name => requestedSong && name.includes(requestedSong)) || requestedSong || songList[Math.floor(Math.random() * songList.length)];
                        const song = SONGS[target] || SONGS[songList[0]];
                        const songName = SONGS[target] ? target : songList[0];
                        const audioPath = path.join(__dirname, 'public', song.file);
                        if (fs.existsSync(audioPath)) {
                            const audioBuffer = fs.readFileSync(audioPath);
                            ws.send(JSON.stringify({
                                type: 'song',
                                song: songName,
                                lyrics: song.lyrics,
                                audio: audioBuffer.toString('base64'),
                                mimeType: 'audio/wav'
                            }));
                            playedSong = true;
                        }
                    }
                    toolResultMessages.push({
                        role: 'tool',
                        tool_call_id: toolCallId,
                        content: String(result)
                    });
                } catch (e) {
                    toolResultMessages.push({
                        role: 'tool',
                        tool_call_id: toolCallId,
                        content: `Tool failed: ${e.message}`
                    });
                }
            }

            if (toolResultMessages.length > 0) {
                const finalResponse = await fetch(`${activeAPI.url}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${activeAPI.key}`
                    },
                    body: JSON.stringify({
                        model: activeAPI.model,
                        messages: [
                            ...formattedMessages,
                            {
                                role: 'assistant',
                                content: fullText || '',
                                tool_calls: executedToolCalls
                            },
                            ...toolResultMessages
                        ],
                        max_tokens: 500,
                        temperature: 0.65
                    })
                });

                if (finalResponse.ok) {
                    const finalData = await finalResponse.json();
                    const naturalReply = finalData.choices?.[0]?.message?.content || '';
                    if (naturalReply.trim()) {
                        fullText = naturalReply.trim();
                        if (!playedSong) {
                            ws.send(JSON.stringify({ type: 'response_chunk', text: fullText }));
                            flushSentence(fullText);
                        }
                    }
                } else if (!fullText.trim()) {
                    fullText = toolResultMessages.map(m => m.content).join('\n');
                    if (!playedSong) ws.send(JSON.stringify({ type: 'response_chunk', text: fullText }));
                }
            }
        }

        if (false && toolCalls.length > 0) {
            for (const tc of toolCalls) {
                if (tc.name && tools[tc.name]) {
                    try {
                        const params = tc.arguments ? JSON.parse(tc.arguments) : {};
                        const result = await tools[tc.name](params);
                        ws.send(JSON.stringify({ type: 'response_chunk', text: `\n✓ ${result}` }));
                        fullText += `\n${result}`;
                    } catch (e) {
                        ws.send(JSON.stringify({ type: 'response_chunk', text: `\n✗ 执行失败` }));
                    }
                }
            }
        }

        if (!fullText.trim()) {
            const retryResponse = await fetch(`${activeAPI.url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${activeAPI.key}`
                },
                body: JSON.stringify({
                    model: activeAPI.model,
                    messages: formattedMessages,
                    max_tokens: 300,
                    temperature: 0.7
                })
            });

            if (retryResponse.ok) {
                const retryData = await retryResponse.json();
                fullText = (retryData.choices?.[0]?.message?.content || '').trim();
                if (fullText) {
                    ws.send(JSON.stringify({ type: 'response_chunk', text: fullText }));
                    flushSentence(fullText);
                }
            }

            if (!fullText.trim()) {
                fullText = '哥哥，我刚刚有点卡住了。你再说一遍，我马上接上。';
                ws.send(JSON.stringify({ type: 'response_chunk', text: fullText }));
            }
        }

        ws.send(JSON.stringify({ type: 'response_end', fullText: fullText }));
        
        const history = sessions.get(sessionId) || [];
        history.push({ role: 'assistant', content: fullText });
        sessions.set(sessionId, history.slice(-10));

        summarizeAndStore(lastUserMsg, fullText).catch(e => console.log('记忆处理异常:', e.message));

    } catch (error) {
        consecutiveErrors++;
        switchToFallback();
        ws.send(JSON.stringify({ type: 'error', text: '无法连接AI服务，正在切换备用模型...' }));
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`小市 server running on http://localhost:${PORT}`);
});
