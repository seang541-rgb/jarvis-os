const WebSocket = require('ws');

console.log('Connecting to ws://localhost:3000...\n');
const ws = new WebSocket('ws://localhost:3000');

let testIndex = 0;
const tests = [
    '帮我打开Chrome浏览器',
    '显示桌面',
    '打开百度网站'
];

ws.on('open', () => {
    console.log('Connected!\n');
    runNextTest();
});

ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    
    if (message.type === 'response_start') {
        process.stdout.write('丞相: ');
    }
    else if (message.type === 'response_chunk') {
        process.stdout.write(message.text);
    }
    else if (message.type === 'response_end') {
        console.log('\n' + '='.repeat(50) + '\n');
        
        // Run next test after delay
        setTimeout(runNextTest, 2000);
    }
});

function runNextTest() {
    if (testIndex >= tests.length) {
        console.log('All tests complete!');
        ws.close();
        process.exit(0);
        return;
    }
    
    const test = tests[testIndex];
    console.log(`User: ${test}`);
    ws.send(JSON.stringify({ type: 'chat', text: test }));
    testIndex++;
}

ws.on('error', (error) => {
    console.error('Error:', error.message);
});