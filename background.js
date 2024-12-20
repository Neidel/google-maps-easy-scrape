// Store captured data
let capturedResponses = [];
let currentUrl = null;
let isWaitingForXhr = false;
let hasProcessedXhr = false;
let processingQueue = [];
let isRetrying = false;
let retryCount = 0;
const MAX_RETRIES = 3;
let lastProcessedUrl = null;
let isProcessingLocked = false;
let isComplete = false;
let currentRequestId = null;

// Add state management
let appState = {
    collectedUrls: [],
    processedData: new Map(),
    urlToPlaceId: new Map(),
    isProcessing: false
};

// Function to safely send messages to popup
async function sendMessageToPopup(message) {
    try {
        // Add current state to message
        if (message.type === 'xhr_captured') {
            message.currentState = {
                collectedUrls: appState.collectedUrls,
                processedData: Array.from(appState.processedData.entries()),
                urlToPlaceId: Array.from(appState.urlToPlaceId.entries()),
                isProcessing: appState.isProcessing,
                currentUrl: currentUrl
            };
        }

        // Send message directly to all views
        chrome.runtime.sendMessage(message).catch(error => {
            console.log('Error sending message to popup:', error);
            // Store the data if sending fails
            if (message.type === 'xhr_captured' && message.data) {
                capturedResponses.push(message.data);
                // Update state when new data is captured
                if (message.data.placeId) {
                    appState.processedData.set(message.data.placeId, message.data);
                    // Find the corresponding URL
                    if (currentUrl) {
                        appState.urlToPlaceId.set(currentUrl, message.data.placeId);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error in sendMessageToPopup:', error);
        if (message.type === 'xhr_captured' && message.data) {
            capturedResponses.push(message.data);
            // Update state when new data is captured
            if (message.data.placeId) {
                appState.processedData.set(message.data.placeId, message.data);
                if (currentUrl) {
                    appState.urlToPlaceId.set(currentUrl, message.data.placeId);
                }
            }
        }
    }
}

// Function to generate unique request ID
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Listen for completed web requests
chrome.webRequest.onCompleted.addListener(
    function(details) {
        // Skip if we're complete
        if (isComplete) {
            return;
        }

        // Handle auth redirect
        if (details.url.includes('accounts.google.com')) {
            handleAuthRedirect(details);
            return;
        }

        // Reset retry count on successful request
        retryCount = 0;
        isRetrying = false;

        // Continue with normal processing...
        if (!isComplete && isWaitingForXhr && !hasProcessedXhr && 
            currentUrl === lastProcessedUrl && !isProcessingLocked &&
            (details.url.includes('passiveassist') || details.url.includes('preview/place'))) {
            processRequest(details);
        }
    },
    { urls: ["<all_urls>"] }
);

function resetState() {
    console.log('Resetting state');
    isWaitingForXhr = false;
    hasProcessedXhr = false;
    isRetrying = false;
    retryCount = 0;
    processingQueue = [];
    currentRequestId = null;
    isProcessingLocked = false;
    appState.isProcessing = false;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        if (message.type === 'get_state') {
            console.log('Sending state to popup:', appState);
            const serializedState = {
                collectedUrls: appState.collectedUrls,
                processedData: Array.from(appState.processedData.entries()),
                urlToPlaceId: Array.from(appState.urlToPlaceId.entries()),
                isProcessing: appState.isProcessing,
                currentUrl: currentUrl
            };
            sendResponse({ success: true, state: serializedState });
        } else if (message.type === 'set_collected_urls') {
            console.log('Setting collected URLs:', message.urls);
            appState.collectedUrls = message.urls;
            sendResponse({ success: true });
        } else if (message.type === 'process_url') {
            console.log('Processing URL request:', message.url);
            
            // Force reset state if we're locked
            if (isProcessingLocked) {
                console.log('Found locked state, forcing reset');
                resetState();
            }
            
            if (!isWaitingForXhr && !isComplete) {
                resetState();
                currentUrl = message.url;
                lastProcessedUrl = message.url;
                isWaitingForXhr = true;
                processingQueue = [message.url];
                appState.isProcessing = true;

                // Generate new request ID
                currentRequestId = generateRequestId();
                console.log('Generated new request ID:', currentRequestId);

                // Update state from popup if provided
                if (message.state) {
                    console.log('Updating state from popup:', message.state);
                    appState.collectedUrls = message.state.collectedUrls;
                    appState.processedData = new Map(message.state.processedData);
                    appState.urlToPlaceId = new Map(message.state.urlToPlaceId);
                    appState.isProcessing = message.state.isProcessing;
                }

                console.log('Starting to process URL:', currentUrl);
                
                // Initialize tab and load URL
                (async () => {
                    try {
                        const success = await updateTab(currentUrl);
                        if (!success) {
                            console.log('Failed to update tab, retrying...');
                            setTimeout(async () => {
                                const retrySuccess = await updateTab(currentUrl);
                                if (!retrySuccess) {
                                    console.log('Failed to update tab after retry');
                                    moveToNextUrl();
                                }
                            }, 2000);
                        }
                    } catch (error) {
                        console.error('Error initializing tab:', error);
                        moveToNextUrl();
                    }
                })();

                // Set a timeout to check for XHR
                setTimeout(() => {
                    if (isWaitingForXhr && currentUrl === lastProcessedUrl && !isComplete) {
                        console.log('No XHR detected, retrying URL:', currentUrl);
                        handleError();
                    }
                }, 10000);
            } else {
                console.log('Cannot process URL - waiting for XHR or complete');
                // If we're stuck, try to recover
                if (isProcessingLocked || isWaitingForXhr) {
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
        } else if (message.type === 'clear_captured_data') {
            resetState();
            currentUrl = null;
            lastProcessedUrl = null;
            isComplete = false;
            currentRequestId = null;
            appState = {
                collectedUrls: [],
                processedData: new Map(),
                urlToPlaceId: new Map(),
                isProcessing: false
            };
            sendResponse({ success: true });
        } else if (message.type === 'processing_complete') {
            console.log('Processing complete signal received');
            isComplete = true;
            resetState();
            currentUrl = null;
            lastProcessedUrl = null;
            currentRequestId = null;
            appState.isProcessing = false;
            sendResponse({ success: true });
        }
    } catch (err) {
        console.error('Error handling message:', err);
        sendResponse({ success: false, error: err.message });
    }
    return true;
});

// Helper functions remain the same...
// ... existing code ...

// Helper function to find location data in Google Maps response
function findLocationData(obj) {
    if (!obj) return null;

    // Add debug logging
    console.log('Searching for location data in:', typeof obj);

    // Look for array containing location details
    if (Array.isArray(obj)) {
        // Check if this array has the location structure we're looking for
        const hasLocationMarkers = obj.some(item => {
            try {
                // More permissive validation
                const isValid = item && 
                    Array.isArray(item) && 
                    typeof item[0] === 'string' &&
                    item[3] && 
                    Array.isArray(item[3]);

                if (isValid) {
                    console.log('Found potential location data:', {
                        identifier: item[0],
                        data: item[3]
                    });
                }

                return isValid;
            } catch (e) {
                console.log('Error checking location data:', e);
                return false;
            }
        });

        if (hasLocationMarkers) {
            // Find the item that matches our criteria
            const locationItem = obj.find(item => 
                item && 
                Array.isArray(item) && 
                typeof item[0] === 'string' &&
                item[3] && 
                Array.isArray(item[3])
            );

            if (locationItem && locationItem[3]) {
                console.log('Found location data structure:', locationItem[3]);
                return locationItem[3];
            }
        }

        // Search through array elements recursively
        for (let item of obj) {
            const result = findLocationData(item);
            if (result) return result;
        }
    }

    // If object, search through all values recursively
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (let key in obj) {
            const result = findLocationData(obj[key]);
            if (result) return result;
        }
    }

    return null;
}

// Update the place ID validation function
function validatePlaceIds(id1, id2) {
    if (!id1 || !id2) return false;
    return id1.trim() === id2.trim();
}

// Update the parseLocationData function
async function parseLocationData(tab) {
    try {
        if (!tab || !tab.id) {
            throw new Error('Invalid tab provided to parseLocationData');
        }

        console.log('Executing script in tab:', tab.id);
        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: () => {
                function cleanText(text) {
                    return text ? text.trim().replace(/\s+/g, ' ') : '';
                }
                
                // Get the main header element
                const header = document.querySelector('h1');
                const name = header ? cleanText(header.textContent) : '';
                
                // Get business type from category text
                const categoryElement = document.querySelector('button[jsaction*="pane.rating.category"]');
                const businessType = categoryElement ? cleanText(categoryElement.textContent) : '';
                
                // Get address components
                const addressElement = document.querySelector('button[data-item-id*="address"]');
                let address = {};
                
                if (addressElement) {
                    const fullAddress = cleanText(addressElement.textContent);
                    const parts = fullAddress.split(',').map(part => part.trim());
                    
                    if (parts.length >= 3) {
                        address = {
                            street: parts[0],
                            city: parts[parts.length - 3],
                            state: parts[parts.length - 2],
                            country: parts[parts.length - 1],
                            postalCode: parts[parts.length - 2].match(/\d+/) ? parts[parts.length - 2].match(/\d+/)[0] : ''
                        };
                    }
                }
                
                // Get rating
                const ratingElement = document.querySelector('div[role="img"][aria-label*="stars"]');
                const rating = ratingElement ? ratingElement.getAttribute('aria-label').match(/[\d.]+/)[0] : '';
                
                // Get website
                const websiteButton = document.querySelector('a[data-item-id*="authority"]');
                const website = websiteButton ? websiteButton.href : '';
                
                // Get coordinates from URL
                const url = window.location.href;
                const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
                const coordinates = coordsMatch ? {
                    lat: coordsMatch[1],
                    lng: coordsMatch[2]
                } : {};
                
                // Get place ID from URL
                const placeId = url.match(/place\/([^/]+)/)?.[1]?.split('?')[0] || '';
                
                return {
                    name,
                    businessType,
                    address,
                    rating,
                    website,
                    coordinates,
                    placeId
                };
            }
        });
        
        if (!result || !result[0] || !result[0].result) {
            throw new Error('Failed to parse location data - no result returned');
        }
        
        return result[0].result;
    } catch (error) {
        console.error('Error parsing location data:', error);
        // Return null instead of throwing to handle the error more gracefully
        return null;
    }
}

// Update the extractPlaceIdFromUrl function
function extractPlaceIdFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const placeIndex = pathParts.indexOf('place');
        
        if (placeIndex !== -1 && pathParts[placeIndex + 1]) {
            const placeId = pathParts[placeIndex + 1].split('?')[0];
            console.log('Extracted place ID:', placeId);
            return placeId;
        }
        
        console.warn('No place ID found in URL:', url);
        return null;
    } catch (error) {
        console.error('Error extracting place ID:', error);
        return null;
    }
}

// Add helper function to handle errors and move to next URL
function handleError() {
    console.log('Handling error for URL:', currentUrl);
    
    if (!currentUrl) {
        console.log('No current URL to retry');
        return;
    }
    
    // Only retry if we haven't exceeded the limit
    if (retryCount < MAX_RETRIES) {
        console.log(`Scheduling retry ${retryCount + 1} of ${MAX_RETRIES}`);
        retryCount++;
        
        // Generate new request ID for retry
        const newRequestId = generateRequestId();
        currentRequestId = newRequestId;
        
        // Add delay between retries
        const retryDelay = Math.min(2000 * Math.pow(2, retryCount - 1), 10000);
        
        setTimeout(async () => {
            if (currentUrl && !isComplete) {
                console.log('Retrying URL:', currentUrl);
                // Reset processing flags
                isProcessingLocked = false;
                hasProcessedXhr = false;
                isWaitingForXhr = true;
                
                const success = await updateTab(currentUrl);
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

// Add new function to handle moving to next URL
function moveToNextUrl() {
    console.log('Moving to next URL');
    
    // Send auth_failed message to popup
    if (currentUrl) {
        chrome.runtime.sendMessage({
            type: 'auth_failed',
            url: currentUrl,
            error: 'Failed to process location data'
        }).catch(error => {
            console.log('Error sending auth_failed message:', error);
        });
    }
    
    // Reset all processing flags
    resetState();
    
    // Clear current URL
    currentUrl = null;
    lastProcessedUrl = null;
}

// Update error handling for tab updates
async function updateTab(url) {
    try {
        // Get all tabs
        const tabs = await chrome.tabs.query({});
        
        // First try to find an active Google Maps tab
        let targetTab = tabs.find(tab => 
            tab.url?.includes('google.com/maps') && 
            tab.active && 
            !tab.url?.includes('DevTools')
        );
        
        // If no active Maps tab, look for any Maps tab
        if (!targetTab) {
            targetTab = tabs.find(tab => 
                tab.url?.includes('google.com/maps') && 
                !tab.url?.includes('DevTools')
            );
        }
        
        if (targetTab) {
            try {
                // Update tab and wait for it to complete loading
                await chrome.tabs.update(targetTab.id, { 
                    url: url,
                    active: true 
                });
                
                // Add delay to ensure page loads
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                return true;
            } catch (error) {
                console.error('Error updating existing tab:', error);
                // If update fails, try to create new tab
                if (!error.message.includes('No tab with id')) {
                    const newTab = await chrome.tabs.create({ url: url, active: true });
                    // Add delay for new tab
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return true;
                }
                return false;
            }
        } else {
            // Create new tab if no suitable tab found
            const newTab = await chrome.tabs.create({ url: url, active: true });
            // Add delay for new tab
            await new Promise(resolve => setTimeout(resolve, 2000));
            return true;
        }
    } catch (error) {
        console.error('Error in updateTab:', error);
        return false;
    }
}

// Update the retry mechanism
async function handleAuthRedirect(details) {
    if (!isRetrying && currentUrl && retryCount < MAX_RETRIES && !isProcessingLocked) {
        console.log(`Auth redirect detected, retry attempt ${retryCount + 1} of ${MAX_RETRIES}`);
        isRetrying = true;
        
        // Add exponential backoff for auth retries
        const retryDelay = Math.min(2000 * Math.pow(2, retryCount), 10000);
        
        setTimeout(async () => {
            if (currentUrl === lastProcessedUrl && !isComplete) {
                const newRequestId = generateRequestId();
                console.log('Generated new request ID:', newRequestId);
                currentRequestId = newRequestId;
                
                // Reset processing flags
                isProcessingLocked = false;
                hasProcessedXhr = false;
                isWaitingForXhr = true;
                
                const success = await updateTab(currentUrl);
                if (!success) {
                    console.log('Failed to update tab, moving to next URL');
                    moveToNextUrl();
                }
            }
            isRetrying = false;
        }, retryDelay);
        
        retryCount++;
    } else if (retryCount >= MAX_RETRIES) {
        console.log('Max retries reached, moving to next URL');
        moveToNextUrl();
    }
}

// Add new function to handle request processing
async function processRequest(details) {
    console.log('Processing request for URL:', details.url);
    
    // Lock processing to prevent duplicates
    isProcessingLocked = true;
    hasProcessedXhr = true;
    
    // Store request ID for this fetch
    const requestId = currentRequestId;
    console.log('Processing with request ID:', requestId);
    
    try {
        let tab = null;
        let retryAttempts = 0;
        const maxTabRetries = 3;
        
        // Retry getting the active tab a few times
        while (!tab && retryAttempts < maxTabRetries) {
            try {
                // Get all tabs first
                const tabs = await chrome.tabs.query({});
                
                // Try to find the Google Maps tab that's being processed
                tab = tabs.find(t => 
                    t.url?.includes('google.com/maps') && 
                    !t.url?.includes('DevTools') &&
                    t.url?.includes(currentUrl?.split('?')[0] || '')
                );
                
                // If no specific tab found, try any active Maps tab
                if (!tab) {
                    tab = tabs.find(t => 
                        t.url?.includes('google.com/maps') && 
                        t.active && 
                        !t.url?.includes('DevTools')
                    );
                }
                
                // If still no tab, wait and retry
                if (!tab) {
                    console.log(`No suitable tab found, attempt ${retryAttempts + 1} of ${maxTabRetries}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    retryAttempts++;
                }
            } catch (error) {
                console.error('Error finding tab:', error);
                retryAttempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (!tab) {
            throw new Error('Could not find a suitable tab after retries');
        }

        const response = await fetch(details.url);
        const text = await response.text();
        
        // Verify this response belongs to current request
        if (requestId !== currentRequestId) {
            console.log('Skipping stale response for request:', requestId);
            isProcessingLocked = false;
            return;
        }
        
        if (currentUrl !== lastProcessedUrl || isComplete) {
            console.log('URL changed or processing complete, skipping');
            isProcessingLocked = false;
            return;
        }
        
        const jsonText = text.replace(/^\)\]\}'[\r\n]+/, '');
        const data = JSON.parse(jsonText);
        
        if (!data) {
            throw new Error('No data found in response');
        }
        
        const locationData = findLocationData(data);
        
        if (!locationData) {
            throw new Error('Could not find location data in response');
        }
        
        // Wait a bit for the page to settle before parsing
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Pass the tab to parseLocationData
        const parsedLocation = await parseLocationData(tab);
        
        if (parsedLocation) {
            console.log('Successfully parsed location:', parsedLocation.name);
            
            // Update appState
            if (parsedLocation.placeId) {
                appState.processedData.set(parsedLocation.placeId, parsedLocation);
                if (currentUrl) {
                    appState.urlToPlaceId.set(currentUrl, parsedLocation.placeId);
                }
            }
            
            // Send success message
            await sendMessageToPopup({
                type: 'xhr_captured',
                data: parsedLocation,
                currentState: {
                    collectedUrls: appState.collectedUrls,
                    processedData: Array.from(appState.processedData.entries()),
                    urlToPlaceId: Array.from(appState.urlToPlaceId.entries()),
                    isProcessing: appState.isProcessing,
                    currentUrl: currentUrl
                }
            });
            
            // Reset state for next URL
            setTimeout(() => {
                console.log('Resetting state for next URL');
                isProcessingLocked = false;
                hasProcessedXhr = false;
                isWaitingForXhr = false;
                currentUrl = null;
                lastProcessedUrl = null;
                currentRequestId = null;
            }, 1000);
        } else {
            throw new Error('Failed to parse location data');
        }
    } catch (error) {
        console.error('Error processing request:', error);
        handleError();
    }
}
  