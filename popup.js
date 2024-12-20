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
                    if (downloadCsvButton) downloadCsvButton.disabled = false;
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

// Initialize UI
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize UI elements
    resultsTable = document.getElementById('resultsTable');
    collectButton = document.getElementById('collectButton');
    processButton = document.getElementById('processButton');
    clearButton = document.getElementById('clearButton');
    downloadCsvButton = document.getElementById('downloadCsvButton');

    // Initialize table headers
    initializeTableHeaders();

    // Enable collect button
    collectButton.disabled = false;

    // Add event listeners
    collectButton.addEventListener('click', async () => {
        try {
            collectButton.disabled = true;
            
            // Navigate to the specific URL
            const targetUrl = "https://www.google.com/maps/search/rv+park+canada/@54.6606182,-121.0448918,6.14z/data=!4m2!2m1!6e1?entry=ttu&g_ep=EgoyMDI0MTIxMS4wIKXMDSoASAFQAw%3D%3D";
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (!tab?.id) {
                alert('Error: Could not find active tab');
                collectButton.disabled = false;
                return;
            }

            // Update the tab URL and wait for navigation
            await chrome.tabs.update(tab.id, { url: targetUrl });
            
            // Wait for 3 seconds before collecting URLs
            await new Promise(resolve => setTimeout(resolve, 3000));

            const urls = await collectUrlsFromPage();
            if (urls && urls.length > 0) {
                AppState.collectedUrls = urls;
                updateTable(urls);
                processButton.disabled = false;
                clearButton.disabled = false;
            } else {
                alert('No URLs found. Please try again or scroll through the search results.');
                collectButton.disabled = false;
            }
        } catch (error) {
            console.error('Error collecting URLs:', error);
            alert('Error collecting URLs. Please try again.');
            collectButton.disabled = false;
        }
    });

    processButton.addEventListener('click', () => {
        processButton.disabled = true;
        processNextUrl();
    });

    clearButton.addEventListener('click', () => {
        resetState();
        clearTable();
        chrome.runtime.sendMessage({ type: 'clear_captured_data' });
        processButton.disabled = true;
        clearButton.disabled = true;
        downloadCsvButton.disabled = true;
        collectButton.disabled = false;
    });

    downloadCsvButton.addEventListener('click', () => {
        downloadCsv();
    });
});

// Function to collect URLs from the page
async function collectUrlsFromPage() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return null;

        const result = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const links = Array.from(document.querySelectorAll('a[href*="maps/place"]'));
                return links.map(link => link.href)
                    .filter(url => url.includes('/maps/place/'))
                    .filter((url, index, self) => self.indexOf(url) === index);
            }
        });

        return result[0]?.result || [];
    } catch (error) {
        console.error('Error executing script:', error);
        return null;
    }
}

// Function to initialize table headers
function initializeTableHeaders() {
    const thead = resultsTable.querySelector('thead');
    thead.innerHTML = `
        <tr>
            <th class="status-col">Status</th>
            <th>Name</th>
            <th>Address</th>
            <th>Phone</th>
            <th>Rating</th>
            <th class="url-col">URL</th>
        </tr>
    `;
}

// Function to update table with URLs
function updateTable(urls) {
    const tbody = resultsTable.querySelector('tbody');
    tbody.innerHTML = '';

    urls.forEach(url => {
        const row = document.createElement('tr');
        row.dataset.url = url;
        row.innerHTML = `
            <td class="status-col">Pending</td>
            <td colspan="7">
                <a href="${url}" target="_blank" class="url-link">${url}</a>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Function to update table row with data
function updateTableRow(url, data) {
    const row = resultsTable.querySelector(`tr[data-url="${url}"]`);
    if (!row) return;

    row.innerHTML = `
        <td class="status-col">Completed</td>
        <td>${data.name || ''}</td>
        <td>${data.address || ''}</td>
        <td>${data.phone || ''}</td>
        <td>${data.rating || ''}</td>
        <td class="url-col">
            <a href="${url}" target="_blank" class="url-link">View</a>
        </td>
    `;
}

// Function to update row status
function updateRowStatus(url, status, message = '') {
    const row = resultsTable.querySelector(`tr[data-url="${url}"]`);
    if (!row) return;

    const statusCell = row.querySelector('.status-col');
    if (!statusCell) return;

    statusCell.textContent = message || status;
    statusCell.className = `status-col ${status}`;
}

// Function to clear table
function clearTable() {
    const tbody = resultsTable.querySelector('tbody');
    tbody.innerHTML = '';
}

// Function to download CSV
function downloadCsv() {
    const headers = ['Name', 'Address', 'Phone', 'Rating', 'URL'];
    const rows = Array.from(AppState.processedData.values()).map(data => [
        data.name || '',
        data.address || '',
        data.phone || '',
        data.rating || '',
        data.url || ''
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'google_maps_data.csv';
    a.click();
    window.URL.revokeObjectURL(url);
}

// Function to handle stall detection
function setStallTimeout(url) {
    clearStallTimeout();
    AppState.stallTimeout = setTimeout(() => {
        if (AppState.isProcessing && AppState.currentUrl === url) {
            console.log('Processing stalled, retrying...');
            const retryCount = incrementRetryCount(url);
            updateRowStatus(url, 'error', `Stalled (Attempt ${retryCount}/${AppState.MAX_RETRIES})`);
            AppState.isProcessing = false;
            AppState.currentUrl = null;
            processNextUrl();
        }
    }, 15000);
}

function clearStallTimeout() {
    if (AppState.stallTimeout) {
        clearTimeout(AppState.stallTimeout);
        AppState.stallTimeout = null;
    }
}

// Helper function to extract place ID from URL
function extractPlaceIdFromUrl(url) {
    const match = url.match(/place\/([^\/]+)/);
    return match ? match[1] : null;
}

// Helper function to validate place IDs
function validatePlaceIds(urlPlaceId, dataPlaceId) {
    if (!urlPlaceId || !dataPlaceId) return false;
    return urlPlaceId === dataPlaceId;
}

// ... rest of existing code ...
