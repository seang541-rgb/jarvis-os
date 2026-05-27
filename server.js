const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { exec } = require('child_process');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MiMo API
const MIMO_API_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
const MIMO_API_KEY = process.env.MIMO_API_KEY || '';
const MIMO_MODEL = 'mimo-v2.5-pro';

if (!MIMO_API_KEY) {
    console.warn('⚠️  未设置 MIMO_API_KEY 环境变量！');
    console.warn('请设置: set MIMO_API_KEY=your_key_here');
}

// HomeAssistant Config (user will configure later)
let HA_URL = process.env.HA_URL || '';
let HA_TOKEN = process.env.HA_TOKEN || '';

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
const SYSTEM_PROMPT = `你是Mimo，一个智能AI助手。你的特点是：
- 说话简洁、专业
- 用中文回复
- 称呼用户为"先生"或"Boss"
- 回复控制在50字以内，适合语音播报

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

当用户要求看YouTube、搜索视频时，使用youtube_search工具。`;

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
    const formattedMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
    ];

    try {
        const response = await fetch(`${MIMO_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MIMO_API_KEY}`
            },
            body: JSON.stringify({
                model: MIMO_MODEL,
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
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

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
                        ws.send(JSON.stringify({ type: 'response_chunk', text: delta.content }));
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

    } catch (error) {
        ws.send(JSON.stringify({ type: 'error', text: '无法连接AI服务。' }));
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Mimo server running on http://localhost:${PORT}`);
});