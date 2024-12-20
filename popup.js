// State management
const AppState = {
    collectedUrls: [],
    processedData: new Map(),
    urlToPlaceId: new Map(),
    isProcessing: false,
    currentUrl: null,
    stallTimeout: null,
    processingHistory: new Set(), // Track URLs that have been processed
    retryCount: new Map(), // Track retry counts per URL
    MAX_RETRIES: 3
};

// UI Elements
let resultsTable;
let collectButton, processButton, clearButton, downloadCsvButton;

// State management functions
function resetState() {
    AppState.collectedUrls = [];
    AppState.processedData.clear();
    AppState.urlToPlaceId.clear();
    AppState.isProcessing = false;
    AppState.currentUrl = null;
    AppState.processingHistory.clear();
    AppState.retryCount.clear();
    clearStallTimeout();
}

function updateState(newState) {
    if (newState.collectedUrls) AppState.collectedUrls = newState.collectedUrls;
    if (newState.processedData) AppState.processedData = new Map(newState.processedData);
    if (newState.urlToPlaceId) AppState.urlToPlaceId = new Map(newState.urlToPlaceId);
    if (typeof newState.isProcessing !== 'undefined') AppState.isProcessing = newState.isProcessing;
    if (typeof newState.currentUrl !== 'undefined') AppState.currentUrl = newState.currentUrl;
}

function getSerializableState() {
    return {
        collectedUrls: AppState.collectedUrls,
        processedData: Array.from(AppState.processedData.entries()),
        urlToPlaceId: Array.from(AppState.urlToPlaceId.entries()),
        isProcessing: AppState.isProcessing,
        currentUrl: AppState.currentUrl,
        processingHistory: Array.from(AppState.processingHistory),
        retryCount: Array.from(AppState.retryCount.entries())
    };
}

function markUrlAsProcessed(url, data) {
    if (!url || !data) return false;
    
    const placeId = data.placeId;
    if (!placeId) return false;

    AppState.processedData.set(placeId, data);
    AppState.urlToPlaceId.set(url, placeId);
    AppState.processingHistory.add(url);
    return true;
}

function isUrlProcessed(url) {
    return AppState.processingHistory.has(url) || 
           Array.from(AppState.urlToPlaceId.keys()).includes(url);
}

function canRetryUrl(url) {
    const retries = AppState.retryCount.get(url) || 0;
    return retries < AppState.MAX_RETRIES;
}

function incrementRetryCount(url) {
    const currentRetries = AppState.retryCount.get(url) || 0;
    AppState.retryCount.set(url, currentRetries + 1);
    return currentRetries + 1;
}

// Update processNextUrl to use new state management
function processNextUrl() {
    if (AppState.isProcessing) {
        console.log('Already processing a URL, skipping');
        return;
    }

    clearStallTimeout();

    // Filter out processed URLs and those that have exceeded retry limits
    const unprocessedUrls = AppState.collectedUrls.filter(url => {
        if (isUrlProcessed(url)) return false;
        if (!canRetryUrl(url)) {
            console.log(`URL exceeded retry limit: ${url}`);
            updateRowStatus(url, 'error', 'Max retries exceeded');
            return false;
        }
        return true;
    });

    console.log('Unprocessed URLs:', unprocessedUrls.length, unprocessedUrls);

    if (unprocessedUrls.length > 0) {
        const nextUrl = unprocessedUrls[0];
        
        console.log('Processing next URL:', nextUrl);
        updateRowStatus(nextUrl, 'processing');
        
        AppState.isProcessing = true;
        AppState.currentUrl = nextUrl;
        
        // Send message with complete state
        chrome.runtime.sendMessage({
            type: 'process_url',
            url: nextUrl,
            state: getSerializableState()
        });
        
        setStallTimeout(nextUrl);
    } else {
        console.log('All URLs processed');
        AppState.isProcessing = false;
        AppState.currentUrl = null;
        chrome.runtime.sendMessage({ type: 'processing_complete' });
        if (processButton) processButton.disabled = false;
    }
}

// Update handleXhrCaptured to use new state management
function handleXhrCaptured(message) {
    const data = message.data;
    console.log('Received XHR data:', data);
    
    if (data && data.placeId) {
        console.log('Processing data for place ID:', data.placeId);
        
        if (message.currentState) {
            updateState(message.currentState);
            
            const processedUrl = AppState.currentUrl || AppState.collectedUrls.find(url => {
                const urlPlaceId = extractPlaceIdFromUrl(url);
                return validatePlaceIds(urlPlaceId, data.placeId);
            });

            if (processedUrl) {
                console.log('Found processed URL:', processedUrl);
                if (markUrlAsProcessed(processedUrl, data)) {
                    updateTableRow(processedUrl, data);
                    updateRowStatus(processedUrl, 'completed');
                    clearStallTimeout();
                }
            }

            AppState.isProcessing = false;
            AppState.currentUrl = null;

            setTimeout(() => {
                if (!AppState.isProcessing) {
                    processNextUrl();
                }
            }, 2000);
        }
    } else {
        console.warn('Received XHR data without place ID');
        if (AppState.currentUrl) {
            const retryCount = incrementRetryCount(AppState.currentUrl);
            const errorMessage = `No place ID found (Attempt ${retryCount}/${AppState.MAX_RETRIES})`;
            updateRowStatus(AppState.currentUrl, 'error', errorMessage);
        }
    }
}

// Update message listener to use new state management
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Received message in popup:', message);
    
    switch (message.type) {
        case 'xhr_captured':
            handleXhrCaptured(message);
            break;
            
        case 'auth_failed':
            console.log('Auth failed for URL:', message.url);
            const retryCount = incrementRetryCount(message.url);
            updateRowStatus(message.url, 'error', `Auth failed (Attempt ${retryCount}/${AppState.MAX_RETRIES})`);
            AppState.isProcessing = false;
            AppState.currentUrl = null;
            
            setTimeout(() => {
                if (!AppState.isProcessing) {
                    processNextUrl();
                }
            }, 5000);
            break;
            
        case 'retry_processing':
            console.log('Retry processing:', message.url);
            AppState.isProcessing = false;
            AppState.currentUrl = null;
            
            if (message.url) {
                const retryCount = incrementRetryCount(message.url);
                updateRowStatus(message.url, 'error', `Retrying... (Attempt ${retryCount}/${AppState.MAX_RETRIES})`);
            }
            
            setTimeout(() => {
                if (!AppState.isProcessing) {
                    processNextUrl();
                }
            }, 2000);
            break;
    }
});

// ... rest of existing code ...
