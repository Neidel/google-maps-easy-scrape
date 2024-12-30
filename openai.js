import config from './config.js';

export async function processAboutText(aboutText) {
    if (!aboutText) {
        console.log('No about text provided for processing');
        return { processed: false, error: 'No about text provided' };
    }
    
    if (!config.OPENAI_API_KEY) {
        console.error('OpenAI API key not configured');
        return { processed: false, error: 'OpenAI API key not configured' };
    }

    try {
        console.log('Processing about text with OpenAI:', aboutText.substring(0, 100) + '...');
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: config.OPENAI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant that analyzes RV park descriptions. Extract key information about amenities, features, and unique selling points in a concise format."
                    },
                    {
                        role: "user",
                        content: `Please analyze this RV park description and provide a concise summary of key features and amenities: ${aboutText}`
                    }
                ],
                max_tokens: config.MAX_TOKENS,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            console.error('OpenAI API error:', {
                status: response.status,
                statusText: response.statusText,
                error: errorData
            });
            throw new Error(`OpenAI API error: ${response.status} - ${errorData?.error?.message || response.statusText}`);
        }

        const data = await response.json();
        console.log('OpenAI API response:', data);
        
        if (!data.choices?.[0]?.message?.content) {
            throw new Error('Invalid response format from OpenAI API');
        }

        return {
            processed: true,
            summary: data.choices[0].message.content,
            originalText: aboutText
        };
    } catch (error) {
        console.error('Error processing text with OpenAI:', error);
        return {
            processed: false,
            error: error.message,
            originalText: aboutText
        };
    }
} 