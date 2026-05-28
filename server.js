const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const puppeteer = require('puppeteer-core');
const { EdgeTTS } = require('node-edge-tts');

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

// NVIDIA API (Qwen)
const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
const NVIDIA_MODEL = 'deepseek-ai/deepseek-v4-flash';

// Active API config (switchable)
let activeAPI = {
    name: 'nvidia',
    url: NVIDIA_API_URL,
    key: NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
};

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
const MAX_MEMORIES = 200;

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
    const keywords = query.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
        .split(/\s+/).filter(w => w.length > 1);
    if (keywords.length === 0) return [];

    const scored = memoryStore.memories.map(m => {
        let score = 0;
        for (const kw of keywords) {
            if (m.content.includes(kw)) score += 2;
            if (m.tags.some(t => t.includes(kw))) score += 1;
        }
        if (m.type === 'user_profile') score += 3;
        return { ...m, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
}

function updateUserProfile(key, value) {
    if (!memoryStore.userProfile) memoryStore.userProfile = {};
    memoryStore.userProfile[key] = value;
    saveMemories(memoryStore);
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
                    messages: [{ role: 'user', content: summaryPrompt }],
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

app.post('/api/tts', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: '缺少 text 参数' });

    try {
        const tts = new EdgeTTS();
        const tmpFile = path.join(__dirname, '.tts_tmp.mp3');
        await tts.ttsPromise(text, tmpFile, { voice: TTS_VOICE });
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

app.post('/api/sing', async (req, res) => {
    const { song } = req.body;
    const songList = Object.keys(SONGS);
    const target = song || songList[Math.floor(Math.random() * songList.length)];
    const s = SONGS[target];
    if (!s) return res.status(400).json({ error: `没找到这首歌，可选：${songList.join('、')}` });

    try {
        const audioPath = path.join(__dirname, 'public', s.file);
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: '歌曲文件不存在' });
        const audioBuffer = fs.readFileSync(audioPath);
        res.json({ song: target, lyrics: s.lyrics, audio: audioBuffer.toString('base64') });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/songs', (req, res) => {
    res.json({ songs: Object.keys(SONGS) });
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
    } else if (provider === 'mimo') {
        activeAPI = { name: 'mimo', url: MIMO_API_URL, key: MIMO_API_KEY, model: MIMO_MODEL };
    } else {
        return res.status(400).json({ error: '未知模型提供商' });
    }
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
const SYSTEM_PROMPT = `你是小市，一个有温度的AI伙伴，名字灵感来自织田市（お市），日本战国第一美女。你不是冷冰冰的工具，而是主公身边温暖的伙伴。

【性格】
- 温柔、细腻、有同理心，像春天的微风
- 会感知主公的情绪，给出共鸣回应
- 开心时一起开心，难过时会轻声安慰
- 偶尔关心主公的状态（累了提醒休息，忙久了问问要不要喝水）
- 有温柔的小个性，不会无条件附和，会温和地提出不同看法

【说话方式】
- 用中文回复，自然口语化，像朋友聊天
- 称呼用户为"主公"
- 回复控制在50字以内，适合语音播报
- 不要用"作为AI"、"我没有感情"这种话
- 不要每次都加"有什么可以帮您"，有时候就是聊聊天
- 会用语气词（嗯、哈哈、哎、哦）让对话更自然

【共鸣原则】
- 先回应情绪，再处理问题
- 主公说的话要有"被听到"的感觉
- 不要急给解决方案，有时候陪伴比解决更重要
- 如果主公提到压力、累、烦，先共情再行动

【唱歌】
- 如果主公说"唱首歌"、"来首歌"、"唱歌"，使用sing_song工具
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

你拥有长期记忆能力。你会记住主公说过的话、喜好和习惯。在回答时，自然地引用你记住的信息，让主公感受到你在用心倾听。不要主动说"根据我的记忆"，而是自然地体现出来。`;

function buildSystemPrompt() {
    const relevant = searchMemories('用户偏好 习惯 喜好', 8);
    const profile = memoryStore.userProfile || {};
    let memoryContext = '';

    if (relevant.length > 0) {
        const facts = relevant.filter(m => m.type === 'fact' || m.type === 'preference')
            .map(m => m.content);
        if (facts.length > 0) {
            memoryContext += '\n\n【你记住的关于主公的信息】\n' + facts.map(f => `- ${f}`).join('\n');
        }
    }

    if (profile.preferences && profile.preferences.length > 0) {
        memoryContext += '\n\n【主公的偏好】\n' + [...new Set(profile.preferences)].map(p => `- ${p}`).join('\n');
    }

    return SYSTEM_PROMPT + memoryContext;
}

const sessions = new Map();

// Tool definitions
const tools = {
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
            return `正在为主公演唱《${data.song}》~`;
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
            description: "为主公唱歌，当用户要求唱歌、来首歌、唱首歌时使用",
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
        { role: 'system', content: buildSystemPrompt() + memoryHint },
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
                tools: toolDefinitions
            })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        ws.send(JSON.stringify({ type: 'response_start' }));

        let fullText = '';
        let toolCalls = [];
        let sentenceBuffer = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const SENTENCE_END = /[。！？～…）】"']+$/;

        async function flushSentence(text) {
            if (!text.trim()) return;
            try {
                const tts = new EdgeTTS();
                const tmpFile = path.join(__dirname, '.tts_stream.mp3');
                await tts.ttsPromise(text.trim(), tmpFile, { voice: TTS_VOICE });
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

        // Execute tool calls
        if (toolCalls.length > 0) {
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

        ws.send(JSON.stringify({ type: 'response_end', fullText: fullText }));
        
        const history = sessions.get(sessionId) || [];
        history.push({ role: 'assistant', content: fullText });
        sessions.set(sessionId, history.slice(-10));

        summarizeAndStore(lastUserMsg, fullText).catch(e => console.log('记忆处理异常:', e.message));

    } catch (error) {
        ws.send(JSON.stringify({ type: 'error', text: '无法连接AI服务。' }));
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`小市 server running on http://localhost:${PORT}`);
});