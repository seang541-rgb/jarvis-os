const MIMO_API_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
const MIMO_API_KEY = 'tp-srwcs27knljqs64edmc6s9k86msff36xpgrmujcsxy0c5kr6';

async function testMiMo() {
    console.log('Testing MiMo API...\n');
    
    // Get available models
    console.log('1. Getting available models...');
    try {
        const modelsResponse = await fetch(`${MIMO_API_URL}/models`, {
            headers: { 'Authorization': `Bearer ${MIMO_API_KEY}` }
        });
        const modelsData = await modelsResponse.json();
        console.log('Available models:', JSON.stringify(modelsData, null, 2));
    } catch (e) {
        console.log('Could not fetch models:', e.message);
    }
    
    // Try common model names
    const modelNames = ['mimo-v25-pro', 'MiMo-v25-Pro', 'mimo-pro', 'MiMo-Pro', 'mimo'];
    
    for (const model of modelNames) {
        console.log(`\n2. Testing model: ${model}`);
        try {
            const response = await fetch(`${MIMO_API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${MIMO_API_KEY}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'user', content: '你好' }
                    ],
                    max_tokens: 100
                })
            });

            if (response.ok) {
                const data = await response.json();
                console.log('SUCCESS! Model:', model);
                console.log('Response:', data.choices[0].message.content);
                return;
            } else {
                const error = await response.json();
                console.log('Failed:', error.error?.message || 'Unknown error');
            }
        } catch (error) {
            console.log('Error:', error.message);
        }
    }
}

testMiMo();