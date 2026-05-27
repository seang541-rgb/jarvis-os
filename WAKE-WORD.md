# JARVIS 唤醒功能使用指南

## 快速开始

### 方式1：热键唤醒（最简单）

1. 双击 `start-jarvis.bat` 启动
2. 在浏览器中打开 http://localhost:3000
3. 按 `Ctrl+Space` 激活 JARVIS
4. 说出指令

### 方式2：语音唤醒（推荐）

1. 注册 Picovoice 账号：https://console.picovoice.ai/
2. 获取免费 Access Key
3. 设置环境变量：
   ```cmd
   set PORCUPINE_KEY=your_access_key
   ```
4. 双击 `start-jarvis.bat` 启动
5. 说 "Jarvis" 唤醒

---

## 唤醒词

| 唤醒词 | 说明 |
|--------|------|
| `Jarvis` | 默认唤醒词（英文） |
| `Hey Jarvis` | 可自定义 |

---

## 使用场景

### 场景1：电脑前工作
```
你：Jarvis
JARVIS：[激活动画] 请说...
你：打开Chrome浏览器
JARVIS：已打开 Chrome
```

### 场景2：控制智能家居
```
你：Ctrl+Space
JARVIS：[激活]
你：打开客厅灯
JARVIS：已打开 客厅灯
```

### 场景3：查天气
```
你：Jarvis
JARVIS：[激活]
你：今天天气怎么样
JARVIS：先生，今天晴，25°C，适合外出。
```

---

## 高级配置

### 自定义唤醒词

1. 访问 https://console.picovoice.ai/
2. 创建自定义唤醒词
3. 下载 `.ppn` 文件
4. 修改 `wake-word.js`：

```javascript
const CUSTOM_KEYWORD = './path/to/your-wake-word.ppn';

this.porcupine = new Porcupine(
    ACCESS_KEY,
    [CUSTOM_KEYWORD],
    [0.5]
);
```

### 调整灵敏度

在 `wake-word.js` 中修改灵敏度（0.0-1.0）：

```javascript
[0.7] // 更灵敏，但可能误触发
[0.3] // 不太灵敏，但更准确
```

---

## 故障排除

### Q: 说 "Jarvis" 没反应？
A: 
1. 检查 Access Key 是否正确
2. 检查麦克风权限
3. 尝试提高灵敏度

### Q: 热键不工作？
A: 
1. 确保浏览器窗口在前台
2. 检查是否有其他程序占用 Ctrl+Space

### Q: 语音识别不准确？
A: 
1. 使用高质量麦克风
2. 减少背景噪音
3. 靠近麦克风说话

---

## 技术说明

### 架构

```
┌─────────────────────────────────────────┐
│              你的电脑                     │
│                                         │
│  ┌─────────────┐    ┌─────────────┐    │
│  │   麦克风     │───▶│ Porcupine   │    │
│  │             │    │ 唤醒词检测   │    │
│  └─────────────┘    └──────┬──────┘    │
│                            │            │
│                            ▼            │
│  ┌─────────────┐    ┌─────────────┐    │
│  │   JARVIS    │◀───│  WebSocket  │    │
│  │   服务器     │    │   连接      │    │
│  └─────────────┘    └─────────────┘    │
│                                         │
└─────────────────────────────────────────┘
```

### 依赖

- `@picovoice/porcupine-node` - 唤醒词引擎
- `@picovoice/pvrecorder-node` - 音频录制
- `ws` - WebSocket 客户端

---

## 获取帮助

- Picovoice 文档：https://picovoice.ai/docs/
- JARVIS 问题反馈：创建 GitHub Issue
