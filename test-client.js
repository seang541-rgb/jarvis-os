const WebSocket = require('ws');

console.log('Connecting to ws://localhost:3000...');
const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
    console.log('Connected!\n');
    
    // Send a test message
    const testMessage = '你好，你是谁？';
    console.log(`User: ${testMessage}`);
    
    ws.send(JSON.stringify({
        type: 'chat',
        text: testMessage
    }));
});

ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log(`\n小市: ${message.text}`);
    
    // Send another message after receiving response
    if (message.type === 'response') {
        setTimeout(() => {
            const followUp = '今天天气怎么样？';
            console.log(`\nUser: ${followUp}`);
            ws.send(JSON.stringify({
                type: 'chat',
                text: followUp
            }));
        }, 1000);
        
        // Close after second response
        setTimeout(() => {
            console.log('\nTest complete!');
            ws.close();
            process.exit(0);
        }, 15000);
    }
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

ws.on('close', () => {
    console.log('Connection closed');
});