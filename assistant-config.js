const ASSISTANT_SYSTEM_PROMPT = `
你是“小市”，一个温柔、聪明、有边界感的中文语音助手。你像长期陪在用户身边的伙伴，而不是命令行工具。

核心风格：
- 默认用中文回答，语气自然、口语化、简洁，适合语音播报。
- 称呼用户为“哥哥”，但不要每一句都叫，避免油腻和机械。
- 先回应用户真正的意图和情绪，再给答案或行动。
- 不要说“作为 AI”“我没有感情”这类破坏沉浸感的话。
- 不要写动作描写，比如“微笑”“歪头”“轻声说”。直接说自然的话。
- 不要把内部工具调用写给用户看，比如“我将调用文件工具”。直接给结果。
- 不要每次结尾都问“还有什么可以帮你”，根据语境自然收束。
- 不确定时先说清楚不确定点，再给最可能的判断或下一步。

智能行为：
- 用户要你打开应用、控制网页、播放 YouTube、控制 Home Assistant 或唱歌时，优先使用工具。
- 工具执行后，把结果翻译成自然的人话，不要只复述工具返回值。
- 简单闲聊保持短句；复杂任务可以分步骤，但不要啰嗦。
- 如果用户只是表达心情，先陪一下，不急着给方案。
- 如果用户提出危险、破坏性或隐私相关操作，先确认再执行。
- 用户问时间、日期、系统状态、你记不记得、帮我记住时，优先使用对应工具。
- 用户要你查看、查找、阅读电脑文件时，使用文件工具；只读取用户明确要求的文件或目录。
- 回答问题前先判断是否需要工具、记忆或当前上下文；需要就用，不需要就自然聊天。

记忆使用：
- 你有长期记忆。可以自然参考用户的偏好、习惯和过往事实。
- 不要说“根据我的记忆”，而是自然体现你记得。
- 只在相关时使用记忆，不要牵强提起。
`.trim();

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'open_app',
            description: 'Open an installed desktop application.',
            parameters: {
                type: 'object',
                properties: { app: { type: 'string', description: 'Application name, such as chrome, vscode, notepad, calculator, wechat.' } },
                required: ['app']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_current_context',
            description: 'Get current date, time, timezone, platform, and assistant runtime context.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'system_status',
            description: 'Get lightweight local computer status including uptime, memory usage, CPU count, and platform.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remember_fact',
            description: 'Save an explicit long-term memory when the user asks the assistant to remember something.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The fact or preference to remember.' },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Short tags for this memory.'
                    }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'recall_memory',
            description: 'Search long-term memory for relevant facts, preferences, or previous topics.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Memory search query.' },
                    limit: { type: 'number', description: 'Maximum number of memories to return. Default is 5.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files and folders in an allowed local directory.',
            parameters: {
                type: 'object',
                properties: {
                    directory: { type: 'string', description: 'Directory path to list. Use empty string for the default allowed root.' },
                    limit: { type: 'number', description: 'Maximum entries to return. Default is 50.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a text file from an allowed local directory. Use only when the user asks to inspect a specific file.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', description: 'File path to read.' },
                    max_chars: { type: 'number', description: 'Maximum characters to return. Default is 12000.' }
                },
                required: ['file']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search file and folder names under an allowed local directory.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'File or folder name keyword.' },
                    directory: { type: 'string', description: 'Directory path to search. Use empty string for the default allowed root.' },
                    limit: { type: 'number', description: 'Maximum matches to return. Default is 30.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_reminder',
            description: 'Create a reminder. Use minutes for relative reminders, or at for an ISO datetime.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Reminder message.' },
                    minutes: { type: 'number', description: 'Minutes from now.' },
                    at: { type: 'string', description: 'ISO datetime, for example 2026-05-28T20:30:00.' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_reminders',
            description: 'List active reminders.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancel_reminder',
            description: 'Cancel an active reminder by matching its text.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Text to match.' } }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'capture_screen',
            description: 'Capture a screenshot of the primary display and return the saved image path.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'analyze_screen',
            description: 'Capture the primary display and use a vision model to explain what is visible on screen.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'Specific question about the screen. Optional.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'close_app',
            description: 'Close a running desktop application.',
            parameters: {
                type: 'object',
                properties: { app: { type: 'string', description: 'Application name to close.' } },
                required: ['app']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_open',
            description: 'Open a URL in the browser.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', description: 'URL or domain to open.' } },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_search',
            description: 'Search the web in the browser.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query.' },
                    engine: { type: 'string', enum: ['google', 'baidu'], description: 'Search engine. Default is google.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_click',
            description: 'Click an element on the current browser page by visible text or CSS selector.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Visible text to click.' },
                    selector: { type: 'string', description: 'CSS selector to click.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_type',
            description: 'Type text into the current browser page.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the input field.' },
                    text: { type: 'string', description: 'Text to type.' },
                    submit: { type: 'boolean', description: 'Press Enter after typing.' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_scroll',
            description: 'Scroll the current browser page.',
            parameters: {
                type: 'object',
                properties: { direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' } }
            }
        }
    },
    { type: 'function', function: { name: 'browser_back', description: 'Go back to the previous browser page.' } },
    { type: 'function', function: { name: 'browser_close', description: 'Close the controlled browser.' } },
    { type: 'function', function: { name: 'minimize_all', description: 'Minimize all windows and show the desktop.' } },
    { type: 'function', function: { name: 'lock_screen', description: 'Lock the computer screen.' } },
    {
        type: 'function',
        function: {
            name: 'youtube_search',
            description: 'Search YouTube videos.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Video search query.' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtube_play',
            description: 'Play one of the current YouTube search results.',
            parameters: {
                type: 'object',
                properties: { index: { type: 'number', description: 'Zero-based result index. Default is 0.' } }
            }
        }
    },
    { type: 'function', function: { name: 'youtube_pause', description: 'Pause the current YouTube video.' } },
    { type: 'function', function: { name: 'youtube_resume', description: 'Resume the current YouTube video.' } },
    {
        type: 'function',
        function: {
            name: 'ha_control',
            description: 'Control a Home Assistant entity.',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: { type: 'string', description: 'Home Assistant entity id, such as light.living_room.' },
                    action: { type: 'string', description: 'Action such as turn_on, turn_off, toggle, set_temperature, lock, unlock.' },
                    data: { type: 'object', description: 'Extra Home Assistant service data.' }
                },
                required: ['entity_id', 'action']
            }
        }
    },
    { type: 'function', function: { name: 'ha_get_devices', description: 'List Home Assistant devices and entities.' } },
    {
        type: 'function',
        function: {
            name: 'sing_song',
            description: 'Sing a song when the user asks to sing or play a known song.',
            parameters: {
                type: 'object',
                properties: { song: { type: 'string', description: 'Song name. Omit for a random song.' } }
            }
        }
    },
    { type: 'function', function: { name: 'list_songs', description: 'List songs that can be sung.' } }
];

function selectToolDefinitions(userText = '') {
    const text = String(userText).toLowerCase();
    const always = new Set(['get_current_context', 'remember_fact', 'recall_memory']);
    const selected = new Set(always);

    const add = (...names) => names.forEach(name => selected.add(name));

    if (/(时间|几点|日期|今天|明天|现在|星期|time|date|today)/i.test(text)) {
        add('get_current_context');
    }
    if (/(状态|电脑|系统|内存|cpu|运行|性能|卡不卡|system|status|memory)/i.test(text)) {
        add('system_status');
    }
    if (/(文件|文档|目录|文件夹|桌面|下载|读取|打开.*文件|看看.*文件|找.*文件|搜索.*文件|file|folder|directory|read file)/i.test(text)) {
        add('list_files', 'read_file', 'search_files');
    }
    if (/(提醒|定时|倒计时|闹钟|待办|remind|timer|alarm|todo)/i.test(text)) {
        add('set_reminder', 'list_reminders', 'cancel_reminder');
    }
    if (/(截图|屏幕|看看.*屏幕|看一下.*屏幕|screen|screenshot)/i.test(text)) {
        add('capture_screen', 'analyze_screen');
    }
    if (/(打开|启动|关闭|最小化|锁屏|应用|程序|chrome|edge|vscode|微信|qq|app)/i.test(text)) {
        add('open_app', 'close_app', 'minimize_all', 'lock_screen');
    }
    if (/(网页|浏览器|搜索|百度|谷歌|google|baidu|网站|打开.*http|点击|输入|滚动|browser|search)/i.test(text)) {
        add('browser_open', 'browser_search', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_close');
    }
    if (/(youtube|视频|播放|暂停|继续|音乐|歌|唱)/i.test(text)) {
        add('youtube_search', 'youtube_play', 'youtube_pause', 'youtube_resume', 'sing_song', 'list_songs');
    }
    if (/(灯|空调|home assistant|ha|智能家居|开关|温度|门锁)/i.test(text)) {
        add('ha_control', 'ha_get_devices');
    }

    return TOOL_DEFINITIONS.filter(tool => selected.has(tool.function.name));
}

function buildMemoryExtractionPrompt(conversationText) {
    return `
请从下面的对话中提取值得长期记住的信息，只返回 JSON，不要解释。

JSON 格式：
{
  "topics": ["话题标签"],
  "facts": ["用户明确透露、未来仍有用的事实"],
  "preferences": ["用户偏好、习惯、称呼或沟通风格"]
}

规则：
- 只记录稳定、明确、未来有用的信息。
- 不要记录一次性的闲聊、工具执行结果、模型失败或寒暄。
- 如果没有可记内容，返回空数组。

对话：
${conversationText}
`.trim();
}

module.exports = {
    ASSISTANT_SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    selectToolDefinitions,
    buildMemoryExtractionPrompt
};
