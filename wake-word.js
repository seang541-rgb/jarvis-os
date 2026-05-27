const { Porcupine } = require('@picovoice/porcupine-node');
const { PvRecorder } = require('@picovoice/pvrecorder-node');
const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Porcupine Access Key (免费注册获取)
// https://console.picovoice.ai/
const ACCESS_KEY = process.env.PORCUPINE_KEY || '';

// Custom wake word - 在 https://console.picovoice.ai/ 创建 "Mimo" 唤醒词并下载 .ppn 文件
const CUSTOM_KEYWORD_PATH = process.env.ZF_WAKEWORD_PATH || path.join(__dirname, 'oichi_wake_word.ppn');

const MIMO_SERVER = 'ws://localhost:3000';

class WakeWordDetector {
    constructor() {
        this.porcupine = null;
        this.recorder = null;
        this.isListening = false;
        this.ws = null;
    }

    async start() {
        console.log('🎤 小市 唤醒词检测器');
        console.log('============================');
        
        if (!ACCESS_KEY) {
            console.log('\n⚠️  Porcupine Access Key 未配置');
            console.log('请访问 https://console.picovoice.ai/ 免费获取');
            console.log('然后设置环境变量: set PORCUPINE_KEY=your_key\n');
            
            console.log('🔄 使用热键模式 (Ctrl+Space) ...\n');
            this.startHotkeyMode();
            return;
        }

        if (!fs.existsSync(CUSTOM_KEYWORD_PATH)) {
            console.log('\n⚠️  唤醒词文件不存在: ' + CUSTOM_KEYWORD_PATH);
            console.log('请到 https://console.picovoice.ai/ 创建 "小市" 唤醒词');
            console.log('下载 .ppn 文件并放到项目目录，命名为 oichi_wake_word.ppn\n');
            
            console.log('🔄 使用热键模式 (Ctrl+Space) ...\n');
            this.startHotkeyMode();
            return;
        }

        try {
            this.porcupine = new Porcupine(
                ACCESS_KEY,
                [CUSTOM_KEYWORD_PATH],
                [0.5]
            );

            console.log(`✅ 唤醒词: "小市"`);
            console.log(`✅ 灵敏度: 0.5`);
            console.log(`✅ 采样率: ${this.porcupine.sampleRate}`);
            console.log(`✅ 帧长度: ${this.porcupine.frameLength}`);

            this.recorder = new PvRecorder(this.porcupine.frameLength);
            await this.recorder.start();

            console.log('\n🎧 正在监听唤醒词...');
            console.log('说 "小市" 唤醒助手\n');

            this.isListening = true;
            this.processAudio();

        } catch (error) {
            console.error('❌ 启动失败:', error.message);
            console.log('\n🔄 回退到热键模式...\n');
            this.startHotkeyMode();
        }
    }

    async processAudio() {
        while (this.isListening) {
            try {
                const pcm = await this.recorder.read();
                const keywordIndex = this.porcupine.process(pcm);

                if (keywordIndex >= 0) {
                    console.log('🎯 检测到唤醒词 "小市"!');
                    this.onWakeWordDetected();
                }
            } catch (error) {
                console.error('音频处理错误:', error);
                break;
            }
        }
    }

    onWakeWordDetected() {
        // Play activation sound
        this.playSound('activate');
        
        // Activate 小市
        this.activateMimo();
    }

    activateMimo() {
        // Send activation signal to 小市 server
        try {
            const ws = new WebSocket(MIMO_SERVER);
            
            ws.on('open', () => {
                console.log('✅ 已连接到 小市 服务器');
                
                // Send activation signal
                ws.send(JSON.stringify({
                    type: 'activate',
                    source: 'wake_word'
                }));

                // Start listening for voice input
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        type: 'listen',
                        state: 'start'
                    }));
                }, 500);

                // Close after timeout
                setTimeout(() => {
                    ws.close();
                }, 30000);
            });

            ws.on('message', (data) => {
                const message = JSON.parse(data.toString());
                console.log(`小市: ${message.text || ''}`);
            });

            ws.on('error', (error) => {
                console.error('连接错误:', error.message);
            });

        } catch (error) {
            console.error('激活失败:', error.message);
        }
    }

    playSound(type) {
        // Play system sound
        if (process.platform === 'win32') {
            exec('powershell -c "[System.Media.SystemSounds]::Asterisk.Play()"');
        }
    }

    startHotkeyMode() {
            console.log('热键模式已启动');
            console.log('在浏览器中按 Ctrl+Space 激活 小市\n');
        
        // Keep process running
        setInterval(() => {}, 1000);
    }

    stop() {
        this.isListening = false;
        
        if (this.recorder) {
            this.recorder.stop();
        }
        
        if (this.porcupine) {
            this.porcupine.release();
        }

        console.log('\n🛑 唤醒词检测已停止');
    }
}

// Handle process exit
process.on('SIGINT', () => {
    console.log('\n正在停止...');
    if (detector) detector.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (detector) detector.stop();
    process.exit(0);
});

// Start detector
const detector = new WakeWordDetector();
detector.start().catch(console.error);