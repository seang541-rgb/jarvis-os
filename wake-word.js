const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
const { PvRecorder } = require('@picovoice/pvrecorder-node');
const WebSocket = require('ws');
const { exec } = require('child_process');

// Porcupine Access Key (免费注册获取)
// https://console.picovoice.ai/
const ACCESS_KEY = process.env.PORCUPINE_KEY || '';

// Wake word configuration
const WAKE_WORDS = [
    BuiltinKeyword.JARVIS,  // Built-in "Jarvis" wake word
];

const JARVIS_SERVER = 'ws://localhost:3000';

class WakeWordDetector {
    constructor() {
        this.porcupine = null;
        this.recorder = null;
        this.isListening = false;
        this.ws = null;
    }

    async start() {
        console.log('🎤 JARVIS Wake Word Detector');
        console.log('============================');
        
        if (!ACCESS_KEY) {
            console.log('\n⚠️  Porcupine Access Key 未配置');
            console.log('请访问 https://console.picovoice.ai/ 免费获取');
            console.log('然后设置环境变量: set PORCUPINE_KEY=your_key\n');
            
            // Fallback to simple hotkey detection
            console.log('🔄 使用热键模式 (Ctrl+Space) ...\n');
            this.startHotkeyMode();
            return;
        }

        try {
            // Initialize Porcupine
            this.porcupine = new Porcupine(
                ACCESS_KEY,
                WAKE_WORDS,
                [0.5] // Sensitivity
            );

            console.log(`✅ 唤醒词: "Jarvis"`);
            console.log(`✅ 灵敏度: 0.5`);
            console.log(`✅ 采样率: ${this.porcupine.sampleRate}`);
            console.log(`✅ 帧长度: ${this.porcupine.frameLength}`);

            // Initialize recorder
            this.recorder = new PvRecorder(this.porcupine.frameLength);
            await this.recorder.start();

            console.log('\n🎧 正在监听唤醒词...');
            console.log('说 "Jarvis" 唤醒 JARVIS\n');

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
                    console.log('🎯 检测到唤醒词 "Jarvis"!');
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
        
        // Activate JARVIS
        this.activateJarvis();
    }

    activateJarvis() {
        // Send activation signal to JARVIS server
        try {
            const ws = new WebSocket(JARVIS_SERVER);
            
            ws.on('open', () => {
                console.log('✅ 已连接到 JARVIS 服务器');
                
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
                console.log(`JARVIS: ${message.text || ''}`);
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
        console.log('在浏览器中按 Ctrl+Space 激活 JARVIS\n');
        
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