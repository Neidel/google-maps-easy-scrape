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
                
                // Add delay to ensure page loads
                await new Promise(resolve => setTimeout(resolve, 3000));
                return true;
            } catch (error) {
                console.error('Error updating existing tab:', error);
                if (!error.message.includes('No tab with id')) {
                    const newTab = await chrome.tabs.create({ url: url, active: true });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    return true;
                }
                return false;
            }
        } else {
            const newTab = await chrome.tabs.create({ url: url, active: true });
            await new Promise(resolve => setTimeout(resolve, 3000));
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
                const locationData = await findLocationData();
                if (locationData) {
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
            return result[0].result;
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
        if (!mainElement) return null;

        // Extract place name (without address)
        const nameElement = mainElement.querySelector('h1');
        const name = nameElement ? nameElement.textContent.trim() : '';

        // Extract place ID from URL
        const url = window.location.href;
        const placeIdMatch = url.match(/place\/([^\/]+)/);
        const placeId = placeIdMatch ? placeIdMatch[1] : '';

        // Extract address components and clean up the map pin emoji
        const addressElement = mainElement.querySelector('button[data-item-id="address"]');
        const fullAddress = addressElement ? 
            addressElement.textContent.trim().replace(/^📍\s*/, '') : '';
        
        // Extract coordinates
        const coords = { lat: null, lng: null };
        const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (coordsMatch) {
            coords.lat = parseFloat(coordsMatch[1]);
            coords.lng = parseFloat(coordsMatch[2]);
        }

        // Extract business type
        const businessTypeElement = mainElement.querySelector('button[jsaction="pane.rating.category"]');
        const businessType = businessTypeElement ? businessTypeElement.textContent.trim() : '';

        // Extract phone number
        const phoneElement = mainElement.querySelector('button[data-item-id="phone:tel"]');
        const phone = phoneElement ? phoneElement.textContent.trim() : '';

        // Extract website
        const websiteElement = mainElement.querySelector('a[data-item-id="authority"]');
        const website = websiteElement ? websiteElement.href : '';

        // Extract rating information
        const ratingElement = mainElement.querySelector('div[role="img"][aria-label*="stars"]');
        const rating = ratingElement ? parseFloat(ratingElement.getAttribute('aria-label')) : null;
        
        const reviewsElement = mainElement.querySelector('button[jsaction="pane.rating.moreReviews"]');
        const reviewCount = reviewsElement ? parseInt(reviewsElement.textContent.replace(/[^0-9]/g, '')) : 0;

        return {
            name,
            placeId,
            address: fullAddress,
            coordinates: coords,
            businessType,
            phone,
            website,
            rating,
            reviewCount,
            url: window.location.href
        };
    } catch (error) {
        console.error('Error parsing location data:', error);
        return null;
    }
}

// ... rest of existing code (parseLocationData, findLocationData, etc.) ...
  