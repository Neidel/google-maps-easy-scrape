import config from './config.js';

export async function processAboutText(locationData) {
    if (!locationData) {
        console.log('No location data provided for processing');
        return { processed: false, error: 'No location data provided' };
    }
    
    if (!config.OPENAI_API_KEY) {
        console.error('OpenAI API key not configured');
        return { processed: false, error: 'OpenAI API key not configured' };
    }

    try {
        // Create a clean version of the data without URLs
        const cleanData = {
            name: locationData.name || '',
            businessType: locationData.businessType || '',
            address: locationData.address || '',
            rating: locationData.rating || '',
            details: locationData.details || '',
            about: locationData.about || '',
            lat: locationData.lat || '',
            lon: locationData.lon || ''
        };

        console.log('Processing location data with OpenAI:', cleanData);
        
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
                        content: `You are a skilled writer crafting engaging RV park descriptions. Create a natural, flowing narrative that highlights the key features and surroundings of the location. Focus on:
1. Available amenities and services
2. Nearby attractions and activities
3. Location advantages and accessibility
4. Unique selling points

Write in a conversational, informative style that helps potential visitors envision their stay. Keep the summary under 200 words and avoid bullet points or technical language. Use natural paragraph breaks for readability.`
                    },
                    {
                        role: "user",
                        content: `Please create an engaging summary for this RV park using all available information:
Name: ${cleanData.name}
Type: ${cleanData.businessType}
Location: ${cleanData.address}
Rating: ${cleanData.rating}
Features: ${cleanData.details}
Description: ${cleanData.about}`
                    }
                ],
                max_tokens: config.MAX_TOKENS,
                temperature: 0.7
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

        // Clean up the summary
        let summary = data.choices[0].message.content.trim();
        // Remove any markdown formatting
        summary = summary.replace(/[#*_~`]/g, '');
        // Remove extra newlines
        summary = summary.replace(/\n{3,}/g, '\n\n');
        // Remove extra spaces
        summary = summary.replace(/\s+/g, ' ').trim();

        return {
            processed: true,
            summary: summary,
            originalData: cleanData
        };
    } catch (error) {
        console.error('Error processing text with OpenAI:', error);
        return {
            processed: false,
            error: error.message,
            originalData: locationData
        };
    }
} 