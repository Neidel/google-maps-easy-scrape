// Import configuration
import config from './config.js';

// Background State Management
const BackgroundState = {
    capturedResponses: [],
    currentUrl: null,
    isWaitingForXhr: false,
    hasProcessedXhr: false,
    processingQueue: [],
    isRetrying: false,
    retryCount: new Map(),
    MAX_RETRIES: 3,
    lastProcessedUrl: null,
    isProcessingLocked: false,
    isComplete: false,
    currentRequestId: null,
    appState: {
        collectedUrls: [],
        processedData: new Map(),
        urlToPlaceId: new Map(),
        isProcessing: false
    }
};

// Function to process text with OpenAI
async function processAboutText(locationData) {
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

// State Management Functions
function resetState() {
    console.log('Resetting background state');
    BackgroundState.isWaitingForXhr = false;
    BackgroundState.hasProcessedXhr = false;
    BackgroundState.isRetrying = false;
    BackgroundState.processingQueue = [];
    BackgroundState.currentRequestId = null;
    BackgroundState.isProcessingLocked = false;
    BackgroundState.appState.isProcessing = false;
}

function updateState(newState) {
    if (!newState) return;
    
    console.log('Updating background state:', newState);
    if (newState.collectedUrls) BackgroundState.appState.collectedUrls = newState.collectedUrls;
    if (newState.processedData) BackgroundState.appState.processedData = new Map(newState.processedData);
    if (newState.urlToPlaceId) BackgroundState.appState.urlToPlaceId = new Map(newState.urlToPlaceId);
    if (typeof newState.isProcessing !== 'undefined') BackgroundState.appState.isProcessing = newState.isProcessing;
    if (typeof newState.currentUrl !== 'undefined') BackgroundState.currentUrl = newState.currentUrl;
}

function getSerializableState() {
    return {
        collectedUrls: BackgroundState.appState.collectedUrls,
        processedData: Array.from(BackgroundState.appState.processedData.entries()),
        urlToPlaceId: Array.from(BackgroundState.appState.urlToPlaceId.entries()),
        isProcessing: BackgroundState.appState.isProcessing,
        currentUrl: BackgroundState.currentUrl
    };
}

// Function to safely send messages to popup
async function sendMessageToPopup(message) {
    try {
        if (message.type === 'xhr_captured') {
            message.currentState = getSerializableState();
        }

        await chrome.runtime.sendMessage(message).catch(error => {
            console.log('Error sending message to popup:', error);
            if (message.type === 'xhr_captured' && message.data) {
                BackgroundState.capturedResponses.push(message.data);
                if (message.data.placeId) {
                    BackgroundState.appState.processedData.set(message.data.placeId, message.data);
                    if (BackgroundState.currentUrl) {
                        BackgroundState.appState.urlToPlaceId.set(BackgroundState.currentUrl, message.data.placeId);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error in sendMessageToPopup:', error);
    }
}

// Function to generate unique request ID
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Tab management
async function updateTab(url) {
    try {
        const tabs = await chrome.tabs.query({});
        let targetTab = tabs.find(tab => 
            tab.url?.includes('google.com/maps') && 
            tab.active && 
            !tab.url?.includes('DevTools')
        );
        
        if (!targetTab) {
            targetTab = tabs.find(tab => 
                tab.url?.includes('google.com/maps') && 
                !tab.url?.includes('DevTools')
            );
        }
        
        if (targetTab) {
            try {
                await chrome.tabs.update(targetTab.id, { 
                    url: url,
                    active: true 
                });
                
                // Initial delay to ensure navigation starts
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Additional delay to ensure page content is fully loaded
                await new Promise(resolve => setTimeout(resolve, 5000));
                return true;
            } catch (error) {
                console.error('Error updating existing tab:', error);
                if (!error.message.includes('No tab with id')) {
                    const newTab = await chrome.tabs.create({ url: url, active: true });
                    // Same delays for new tab
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    return true;
                }
                return false;
            }
        } else {
            const newTab = await chrome.tabs.create({ url: url, active: true });
            // Same delays for new tab creation
            await new Promise(resolve => setTimeout(resolve, 3000));
            await new Promise(resolve => setTimeout(resolve, 5000));
            return true;
        }
    } catch (error) {
        console.error('Error in updateTab:', error);
        return false;
    }
}

// Error handling and retry mechanism
async function handleError() {
    console.log('Handling error for URL:', BackgroundState.currentUrl);
    
    if (!BackgroundState.currentUrl) {
        console.log('No current URL to retry');
        return;
    }
    
    const currentRetries = BackgroundState.retryCount.get(BackgroundState.currentUrl) || 0;
    if (currentRetries < BackgroundState.MAX_RETRIES) {
        console.log(`Scheduling retry ${currentRetries + 1} of ${BackgroundState.MAX_RETRIES}`);
        BackgroundState.retryCount.set(BackgroundState.currentUrl, currentRetries + 1);
        
        const retryDelay = Math.min(2000 * Math.pow(2, currentRetries), 10000);
        
        setTimeout(async () => {
            if (BackgroundState.currentUrl && !BackgroundState.isComplete) {
                console.log('Retrying URL:', BackgroundState.currentUrl);
                BackgroundState.isProcessingLocked = false;
                BackgroundState.hasProcessedXhr = false;
                BackgroundState.isWaitingForXhr = true;
                
                const success = await updateTab(BackgroundState.currentUrl);
                if (!success) {
                    console.error('Failed to update tab during retry');
                    moveToNextUrl();
                }
            }
        }, retryDelay);
    } else {
        console.log('Max retries reached, moving to next URL');
        moveToNextUrl();
    }
}

// Function to handle moving to next URL
function moveToNextUrl() {
    console.log('Moving to next URL');
    
    if (BackgroundState.currentUrl) {
        chrome.runtime.sendMessage({
            type: 'auth_failed',
            url: BackgroundState.currentUrl,
            error: 'Failed to process location data'
        });
    }
    
    resetState();
    BackgroundState.currentUrl = null;
    BackgroundState.lastProcessedUrl = null;
}

// Update message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        switch (message.type) {
            case 'get_state':
                console.log('Sending state to popup:', BackgroundState.appState);
                sendResponse({ 
                    success: true, 
                    state: getSerializableState() 
                });
                break;

            case 'set_collected_urls':
                console.log('Setting collected URLs:', message.urls);
                BackgroundState.appState.collectedUrls = message.urls;
                sendResponse({ success: true });
                break;

            case 'process_url':
                console.log('Processing URL request:', message.url);
                
                if (BackgroundState.isProcessingLocked) {
                    console.log('Found locked state, forcing reset');
                    resetState();
                }
                
                if (!BackgroundState.isWaitingForXhr && !BackgroundState.isComplete) {
                    resetState();
                    BackgroundState.currentUrl = message.url;
                    BackgroundState.lastProcessedUrl = message.url;
                    BackgroundState.isWaitingForXhr = true;
                    BackgroundState.processingQueue = [message.url];
                    BackgroundState.appState.isProcessing = true;
                    BackgroundState.currentRequestId = Date.now().toString();
                    
                    if (message.state) {
                        updateState(message.state);
                    }

                    updateTab(message.url).then(success => {
                        if (!success) {
                            console.log('Failed to update tab, retrying...');
                            setTimeout(() => {
                                updateTab(message.url).catch(() => {
                                    console.log('Failed to update tab after retry');
                                    moveToNextUrl();
                                });
                            }, 2000);
                        }
                    }).catch(error => {
                        console.error('Error initializing tab:', error);
                        moveToNextUrl();
                    });

                    setTimeout(() => {
                        if (BackgroundState.isWaitingForXhr && 
                            BackgroundState.currentUrl === BackgroundState.lastProcessedUrl && 
                            !BackgroundState.isComplete) {
                            console.log('No XHR detected, retrying URL:', BackgroundState.currentUrl);
                            handleError();
                        }
                    }, 10000);
                } else {
                    console.log('Cannot process URL - waiting for XHR or complete');
                    if (BackgroundState.isProcessingLocked || BackgroundState.isWaitingForXhr) {
                        console.log('Detected stuck state, attempting to recover');
                        setTimeout(() => {
                            resetState();
                            chrome.runtime.sendMessage({ 
                                type: 'retry_processing',
                                url: message.url
                            });
                        }, 2000);
                    }
                }
                
                sendResponse({ success: true });
                break;

            case 'clear_captured_data':
                resetState();
                BackgroundState.currentUrl = null;
                BackgroundState.lastProcessedUrl = null;
                BackgroundState.isComplete = false;
                BackgroundState.currentRequestId = null;
                BackgroundState.appState = {
                    collectedUrls: [],
                    processedData: new Map(),
                    urlToPlaceId: new Map(),
                    isProcessing: false
                };
                sendResponse({ success: true });
                break;

            case 'processing_complete':
                console.log('Processing complete signal received');
                BackgroundState.isComplete = true;
                resetState();
                BackgroundState.currentUrl = null;
                BackgroundState.lastProcessedUrl = null;
                BackgroundState.currentRequestId = null;
                BackgroundState.appState.isProcessing = false;
                sendResponse({ success: true });
                break;
        }
    } catch (err) {
        console.error('Error handling message:', err);
        sendResponse({ success: false, error: err.message });
    }
    return true;
});

// XHR Response Handler
chrome.webRequest.onCompleted.addListener(
    async (details) => {
        if (!BackgroundState.isWaitingForXhr || BackgroundState.hasProcessedXhr || !details.url) {
            return;
        }

        if (details.url.includes('google.com/maps/preview/place') || 
            details.url.includes('google.com/maps/place')) {
            
            console.log('Detected place data XHR:', details.url);
            BackgroundState.hasProcessedXhr = true;
            BackgroundState.isWaitingForXhr = false;

            try {
                // Add delay before attempting to parse the data
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                const locationData = await findLocationData();
                if (locationData) {
                    // Process location data with OpenAI
                    if (locationData) {
                        try {
                            console.log('Processing location data with OpenAI');
                            const processedAbout = await processAboutText(locationData);
                            console.log('OpenAI processing result:', processedAbout);
                            if (processedAbout.processed) {
                                locationData.summary = processedAbout.summary;
                            } else {
                                console.error('Failed to process location data:', processedAbout.error);
                            }
                        } catch (error) {
                            console.error('Error processing location data with OpenAI:', error);
                        }
                    }

                    console.log('Successfully parsed location data:', locationData);
                    chrome.runtime.sendMessage({
                        type: 'xhr_captured',
                        data: locationData,
                        currentState: getSerializableState()
                    });
                } else {
                    console.log('No location data found, handling error');
                    handleError();
                }
            } catch (error) {
                console.error('Error processing location data:', error);
                handleError();
            }
        }
    },
    { urls: ["*://*.google.com/*"] }
);

// Location data parsing
async function findLocationData() {
    try {
        const tabs = await chrome.tabs.query({ active: true });
        const tab = tabs.find(t => t.url?.includes('google.com/maps'));
        
        if (!tab?.id) {
            console.error('No active Google Maps tab found');
            return null;
        }

        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: parseLocationData
        });

        if (result && result[0]?.result) {
            // Since parseLocationData now returns a promise, we need to await its resolution
            return await result[0].result;
        }
        
        return null;
    } catch (error) {
        console.error('Error in findLocationData:', error);
        return null;
    }
}

function parseLocationData() {
    try {
        // Find the main element containing place information
        const mainElement = document.querySelector('div[role="main"]');
        if (!mainElement) {
            console.error('Main element not found');
            return null;
        }

        // Extract place name (without address)
        const nameElement = mainElement.querySelector('h1');
        const name = nameElement ? nameElement.textContent.trim() : '';

        // Extract place ID from URL
        const placeIdMatch = window.location.href.match(/place\/([^\/]+)/);
        const placeId = placeIdMatch ? placeIdMatch[1] : '';

        // Function to extract about section
        function extractAboutSection() {
            return new Promise((resolve) => {
                // Click the About tab if it exists
                const aboutTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                    .find(tab => tab.textContent.includes('About'));
                
                if (aboutTab) {
                    aboutTab.click();
                    // Wait for the about section to load
                    setTimeout(() => {
                        const aboutSection = document.querySelector('div[role="region"][aria-label*="About"]');
                        if (aboutSection) {
                            // Extract all text content from the about section
                            const aboutText = [];
                            
                            // Get the main description
                            const description = aboutSection.querySelector('.HlvSq');
                            if (description) {
                                aboutText.push(description.textContent.trim());
                            }
                            
                            // Get amenities from WKLD0c container
                            const amenitiesContainer = aboutSection.querySelector('.WKLD0c');
                            if (amenitiesContainer) {
                                const amenities = Array.from(amenitiesContainer.querySelectorAll('.CK16pd'))
                                    .map(item => {
                                        const label = item.getAttribute('aria-label');
                                        if (label) {
                                            // Convert "X available/unavailable" to "X: Yes/No"
                                            const [amenity, status] = label.split(' ');
                                            return `${amenity}: ${status === 'available' ? 'Yes' : 'No'}`;
                                        }
                                        return null;
                                    })
                                    .filter(item => item); // Remove null values
                                
                                if (amenities.length > 0) {
                                    aboutText.push('Amenities:');
                                    aboutText.push(amenities.join(', '));
                                }
                            }
                            
                            // Get all other sections
                            const sections = aboutSection.querySelectorAll('.iP2t7d');
                            sections.forEach(section => {
                                const title = section.querySelector('.iL3Qke');
                                const items = Array.from(section.querySelectorAll('.iNvpkb span[aria-label]'))
                                    .map(item => item.getAttribute('aria-label'));
                                
                                if (title && items.length > 0) {
                                    aboutText.push(`${title.textContent}:`);
                                    aboutText.push(items.join(', '));
                                }
                            });
                            
                            // Click back to Overview tab
                            const overviewTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                                .find(tab => tab.textContent.includes('Overview'));
                            if (overviewTab) {
                                overviewTab.click();
                                setTimeout(() => {
                                    resolve(aboutText.join('\n'));
                                }, 1000);
                            } else {
                                resolve(aboutText.join('\n'));
                            }
                        } else {
                            // If no about section found, try to get amenities from overview
                            const overviewAmenities = document.querySelector('.WKLD0c');
                            if (overviewAmenities) {
                                const amenities = Array.from(overviewAmenities.querySelectorAll('.CK16pd'))
                                    .map(item => {
                                        const label = item.getAttribute('aria-label');
                                        if (label) {
                                            const [amenity, status] = label.split(' ');
                                            return `${amenity}: ${status === 'available' ? 'Yes' : 'No'}`;
                                        }
                                        return null;
                                    })
                                    .filter(item => item);
                                
                                if (amenities.length > 0) {
                                    resolve('Amenities:\n' + amenities.join(', '));
                                } else {
                                    resolve('');
                                }
                            } else {
                                resolve('');
                            }
                        }
                    }, 1000);
                } else {
                    // If no About tab, try to get amenities from overview
                    const overviewAmenities = document.querySelector('.WKLD0c');
                    if (overviewAmenities) {
                        const amenities = Array.from(overviewAmenities.querySelectorAll('.CK16pd'))
                            .map(item => {
                                const label = item.getAttribute('aria-label');
                                if (label) {
                                    const [amenity, status] = label.split(' ');
                                    return `${amenity}: ${status === 'available' ? 'Yes' : 'No'}`;
                                }
                                return null;
                            })
                            .filter(item => item);
                        
                        if (amenities.length > 0) {
                            resolve('Amenities:\n' + amenities.join(', '));
                        } else {
                            resolve('');
                        }
                    } else {
                        resolve('');
                    }
                }
            });
        }

        // Function to collect image URLs
        function collectImageUrls() {
            console.log('Collecting image URLs...');
            const imageUrls = [];
            const photoElements = document.querySelectorAll('.m6QErb.XiKgde a.OKAoZd');
            console.log(`Found ${photoElements.length} photo elements`);
            
            photoElements.forEach(photoElement => {
                const backgroundDiv = photoElement.querySelector('.U39Pmb');
                if (backgroundDiv) {
                    const style = backgroundDiv.style.backgroundImage;
                    if (style) {
                        const urlMatch = style.match(/url\("([^"]+)"\)/);
                        if (urlMatch && urlMatch[1] && !urlMatch[1].includes('//:0')) {
                            // Get the highest quality version by removing size parameters
                            const highQualityUrl = urlMatch[1].replace(/=w\d+-h\d+-k-no/, '=s2048-k-no');
                            imageUrls.push(highQualityUrl);
                            console.log('Added image URL:', highQualityUrl);
                        }
                    }
                }
            });
            return imageUrls;
        }

        // Function to wait for images to load
        function waitForImages(maxAttempts = 10) {
            return new Promise((resolve) => {
                let attempts = 0;
                
                function checkImages() {
                    attempts++;
                    const imageUrls = collectImageUrls();
                    console.log(`Attempt ${attempts}: Found ${imageUrls.length} images`);
                    
                    if (imageUrls.length > 0 || attempts >= maxAttempts) {
                        resolve(imageUrls);
                    } else {
                        setTimeout(checkImages, 1000); // Check every second
                    }
                }
                
                checkImages();
            });
        }

        // Return a promise that resolves with the location data
        return new Promise(async (resolve) => {
            // First extract the about section
            const aboutText = await extractAboutSection();
            
            // Ensure we're back on the overview tab for images
            const overviewTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                .find(tab => tab.textContent.includes('Overview'));
            if (overviewTab) {
                overviewTab.click();
                // Wait a bit for the overview to load
                await new Promise(r => setTimeout(r, 1000));
            }
            
            // Then handle photos
            const seePhotosButton = mainElement.querySelector('button.Dx2nRe');
            if (seePhotosButton) {
                seePhotosButton.click();
                setTimeout(async () => {
                    const imageUrls = await waitForImages();
                    finishCollection(imageUrls, aboutText);
                }, 2000); // Increased delay to ensure photo gallery loads
            } else {
                const imageUrls = await waitForImages();
                finishCollection(imageUrls, aboutText);
            }

            async function finishCollection(imageUrls, aboutText) {
                // Extract address components and clean up all special characters
                const addressElement = mainElement.querySelector('button[data-item-id^="address"]');
                let fullAddress = '';
                if (addressElement) {
                    fullAddress = addressElement.textContent
                        .trim()
                        .replace(/^[^\w\d]*/, '')
                        .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                        .replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                // Extract business type
                const businessTypeElement = mainElement.querySelector('button[jsaction*="pane.rating.category"]');
                const businessType = businessTypeElement ? businessTypeElement.textContent.trim() : '';

                // Enhanced phone number extraction
                let phone = '';
                const phoneElement = mainElement.querySelector('button[data-item-id^="phone:tel"]');
                if (phoneElement) {
                    phone = phoneElement.textContent
                        .trim()
                        .replace(/^[^\w\d+]*/, '')
                        .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                        .replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                // Enhanced website extraction
                let website = '';
                const websiteElement = mainElement.querySelector('a[data-item-id="authority"], button[data-item-id="authority"]');
                if (websiteElement) {
                    const href = websiteElement.href || websiteElement.getAttribute('data-url') || websiteElement.textContent.trim();
                    try {
                        website = href.startsWith('http') ? href : `http://${href}`;
                        new URL(website); // Validate the URL
                    } catch {
                        website = '';
                    }
                }

                // Extract rating information
                const ratingElement = mainElement.querySelector('div[role="img"][aria-label*="stars"], span[aria-label*="stars"]');
                const rating = ratingElement ? parseFloat(ratingElement.getAttribute('aria-label')) : null;

                // Extract coordinates from URL
                const coordsMatch = window.location.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
                const lat = coordsMatch ? parseFloat(coordsMatch[1]) : null;
                const lon = coordsMatch ? parseFloat(coordsMatch[2]) : null;

                // Extract amenity details
                const details = [];
                const amenityElements = mainElement.querySelectorAll('.WKLD0c .CK16pd, div[aria-label*="Amenities"]');
                amenityElements.forEach(element => {
                    const ariaLabel = element.getAttribute('aria-label');
                    if (ariaLabel) {
                        const amenityName = ariaLabel.replace(/ (available|unavailable)$/, '').trim();
                        details.push(amenityName);
                    } else {
                        const text = element.textContent.trim();
                        if (text) details.push(text);
                    }
                });

                const result = {
                    name,
                    placeId,
                    address: fullAddress,
                    businessType,
                    phone,
                    website,
                    rating,
                    lat,
                    lon,
                    details: details.join(', '),
                    about: aboutText,
                    url: window.location.href,
                    imageUrls: imageUrls
                };

                console.log('Parsed location data:', result);
                resolve(result);
            }
        });
    } catch (error) {
        console.error('Error in parseLocationData:', error);
        return null;
    }
}

// ... rest of existing code (parseLocationData, findLocationData, etc.) ...
  