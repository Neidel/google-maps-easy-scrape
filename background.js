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
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
        if (message.type === 'get_state') {
            console.log('Sending state to popup:', appState);
            // Convert Maps to arrays for serialization
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
            // Only process if we're not locked or waiting and not complete
            if (!isProcessingLocked && !isWaitingForXhr && !isComplete) {
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
                
                // Set a timeout to retry if no XHR is detected
                setTimeout(() => {
                    if (isWaitingForXhr && currentUrl === lastProcessedUrl && !isProcessingLocked && !isComplete) {
                        console.log('No XHR detected, retrying URL:', currentUrl);
                        const newRequestId = generateRequestId();
                        console.log('Generated new request ID:', newRequestId);
                        currentRequestId = newRequestId;
                        chrome.tabs.update({ url: currentUrl });
                    }
                }, 5000);
            } else {
                console.log('Skipping URL processing - already processing, locked, or complete');
            }
            
            sendResponse({ success: true });
        } else if (message.type === 'clear_captured_data') {
            currentUrl = null;
            lastProcessedUrl = null;
            isProcessingLocked = false;
            isComplete = false;
            currentRequestId = null;
            appState = {
                collectedUrls: [],
                processedData: new Map(),
                urlToPlaceId: new Map(),
                isProcessing: false
            };
            resetState();
            sendResponse({ success: true });
        } else if (message.type === 'processing_complete') {
            console.log('Processing complete signal received');
            isComplete = true;
            isProcessingLocked = false;
            currentUrl = null;
            lastProcessedUrl = null;
            currentRequestId = null;
            appState.isProcessing = false;
            resetState();
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
function validatePlaceIds(urlPlaceId, responsePlaceId) {
    if (!urlPlaceId || !responsePlaceId) {
        console.log('Skipping validation - missing place ID:', { urlPlaceId, responsePlaceId });
        return true; // Skip validation if either ID is missing
    }

    // Log original values
    console.log('Validating place IDs:', { urlPlaceId, responsePlaceId });

    // If response ID matches the new format (contains underscore and no hex), accept it
    if (responsePlaceId.includes('_') && responsePlaceId.includes('RkZ')) {
        console.log('Found new format response ID, accepting as valid');
        return true;
    }

    // Normalize both IDs by removing common prefixes and converting to lowercase
    const normalizeId = (id) => {
        return id.toString()
            .replace(/^0x/, '')
            .replace(/^ChIJ/, '')
            .replace(/:/g, '')  // Remove colons
            .replace(/\s+/g, '') // Remove spaces
            .toLowerCase();
    };

    // Extract hex ID from URL if present
    const extractHexId = (str) => {
        const hexMatch = str.match(/0x[0-9a-fA-F]+/);
        return hexMatch ? hexMatch[0].replace(/^0x/, '') : str;
    };

    let normalizedUrlId = normalizeId(urlPlaceId);
    let normalizedResponseId = normalizeId(responsePlaceId);

    // Try to extract hex format if available
    const urlHexId = extractHexId(normalizedUrlId);
    const responseHexId = extractHexId(normalizedResponseId);

    // Compare both normalized and hex versions
    const isMatch = normalizedUrlId === normalizedResponseId || 
                   urlHexId === responseHexId ||
                   normalizedUrlId.includes(responseHexId) ||
                   responseHexId.includes(normalizedUrlId);

    console.log('Place ID comparison:', {
        original: { urlPlaceId, responsePlaceId },
        normalized: { normalizedUrlId, normalizedResponseId },
        hex: { urlHexId, responseHexId },
        isMatch
    });

    return isMatch;
}

// Update the parseLocationData function
function parseLocationData(locationData) {
    if (!locationData) {
        console.log('No location data provided');
        return null;
    }

    console.log('Parsing location data:', locationData);

    // Extract place ID first to validate against URL
    const placeId = locationData[3] || locationData[0] || ''; // Try both positions for place ID
    const urlPlaceId = currentUrl ? extractPlaceIdFromUrl(currentUrl) : null;
    
    // Log place IDs for debugging
    console.log('Place IDs before validation:', { 
        urlPlaceId, 
        responsePlaceId: placeId, 
        url: currentUrl,
        locationData: JSON.stringify(locationData).substring(0, 200) + '...' 
    });

    // Skip place ID validation if we can't find a place ID in the URL
    // or if the response has the new format
    if (!urlPlaceId || (placeId && placeId.includes('_') && placeId.includes('RkZ'))) {
        console.log('Skipping validation - special case');
    } else if (!validatePlaceIds(urlPlaceId, placeId)) {
        console.log('Place ID validation failed:', { 
            urlPlaceId, 
            responsePlaceId: placeId,
            locationData: locationData[3]
        });
        return null;
    }

    // Extract name from multiple possible locations
    const name = locationData[0] || 
                 locationData[1] || 
                 locationData[16]?.[0]?.[0] || 
                 locationData[16]?.[11]?.[0] || 
                 '';

    // Create the parsed location object with more flexible data extraction
    const parsedLocation = {
        name: name,
        placeId: placeId,
        coordinates: {
            lat: locationData[4]?.[2] || locationData[16]?.[0]?.[2] || 0,
            lng: locationData[4]?.[3] || locationData[16]?.[0]?.[3] || 0
        },
        address: {
            full: '',
            street: '',
            city: '',
            state: '',
            postalCode: '',
            country: ''
        },
        rating: locationData[16]?.[0]?.[8] || locationData[16]?.[4]?.[8] || 0,
        businessType: locationData[16]?.[0]?.[9]?.[0]?.[0] || locationData[16]?.[13]?.[0] || '',
        timezone: locationData[10] || locationData[16]?.[0]?.[10] || '',
        website: locationData[16]?.[0]?.[7]?.[0] || locationData[16]?.[7]?.[0] || '',
        timestamp: new Date().toISOString()
    };

    // Try multiple paths for address data
    const addressPaths = [
        locationData[16]?.[0]?.[5],
        locationData[16]?.[5],
        locationData[16]?.[0]?.[15]?.[1],
        locationData[16]?.[15]?.[1]
    ];

    // Try to find a valid address from any path
    for (const fullAddress of addressPaths) {
        if (fullAddress) {
            if (typeof fullAddress === 'string') {
                // Parse the full address string
                const parts = fullAddress.split(', ');
                if (parts.length >= 3) {
                    parsedLocation.address = {
                        full: fullAddress,
                        street: parts[0] || '',
                        city: parts[1] || '',
                        state: (parts[2].split(' ')[0] || '').trim(),
                        postalCode: (parts[2].split(' ')[1] || '').trim(),
                        country: parts[3] || 'Canada'
                    };
                    break;
                }
            } else if (Array.isArray(fullAddress)) {
                // Handle structured address data
                parsedLocation.address = {
                    full: fullAddress.join(', '),
                    street: fullAddress[1] || '',
                    city: fullAddress[3] || '',
                    state: fullAddress[5] || '',
                    postalCode: fullAddress[4] || '',
                    country: fullAddress[6] === 'CA' ? 'Canada' : fullAddress[6] || ''
                };
                break;
            }
        }
    }

    // Log the final parsed location
    console.log('Parsed location result:', {
        name: parsedLocation.name,
        placeId: parsedLocation.placeId,
        coordinates: parsedLocation.coordinates,
        hasAddress: !!parsedLocation.address.street
    });

    return parsedLocation;
}

// Update the extractPlaceIdFromUrl function
function extractPlaceIdFromUrl(url) {
    try {
        // Try multiple patterns to extract place ID
        const patterns = [
            /!1s([^!]+)!/,                     // Standard format
            /place\/[^/]+\/([^/]+)/,           // Alternative format
            /data=.*?!1s([^!]+)!/,             // Data parameter format
            /[?&]pb=.*?!1s([^!]+)!/,           // Preview format
            /0x[0-9a-fA-F]+:[0-9a-fA-F]+/,     // Direct hex format
            /ChIJ[a-zA-Z0-9_-]+/               // ChIJ format
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        // If no pattern matches but URL contains a place ID in hex format
        const hexMatch = url.match(/0x[0-9a-fA-F]+:[0-9a-fA-F]+/);
        if (hexMatch) {
            return hexMatch[0];
        }

        return null;
    } catch (e) {
        console.error('Error extracting place ID:', e);
        return null;
    }
}

// Add helper function to handle errors and move to next URL
function handleError() {
    console.log('Handling error for URL:', currentUrl);
    
    // Only retry if we haven't exceeded the limit
    if (retryCount < MAX_RETRIES) {
        console.log(`Scheduling retry ${retryCount + 1} of ${MAX_RETRIES}`);
        retryCount++;
        
        // Generate new request ID for retry
        const newRequestId = generateRequestId();
        currentRequestId = newRequestId;
        
        // Add delay between retries
        const retryDelay = Math.min(2000 * Math.pow(2, retryCount - 1), 10000);
        
        setTimeout(() => {
            if (currentUrl && !isComplete) {
                console.log('Retrying URL:', currentUrl);
                // Reset processing flags
                isProcessingLocked = false;
                hasProcessedXhr = false;
                isWaitingForXhr = true;
                
                chrome.tabs.update({ url: currentUrl }).catch(error => {
                    console.error('Error updating tab:', error);
                    moveToNextUrl();
                });
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
    
    // Reset all processing flags
    isProcessingLocked = false;
    hasProcessedXhr = false;
    isWaitingForXhr = false;
    retryCount = 0;
    
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
    
    // Clear current URL
    currentUrl = null;
    lastProcessedUrl = null;
    currentRequestId = null;
}

// Update error handling for tab updates
async function updateTab(url) {
    try {
        // Get all tabs and find one that's on Google Maps
        const tabs = await chrome.tabs.query({});
        let targetTab = tabs.find(tab => tab.url.includes('google.com/maps'));
        
        if (targetTab) {
            // Try to update existing tab
            try {
                await chrome.tabs.update(targetTab.id, { url });
                return true;
            } catch (error) {
                // If DevTools error, try to create new tab
                if (error.message.includes('DevTools')) {
                    const newTab = await chrome.tabs.create({ url });
                    return true;
                }
                throw error;
            }
        } else {
            // If no Maps tab found, create new one
            const newTab = await chrome.tabs.create({ url });
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
        
        const parsedLocation = parseLocationData(locationData);
        
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
  