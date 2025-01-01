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
            
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            if (!tab?.id) {
                alert('Error: Could not find active tab');
                collectButton.disabled = false;
                return;
            }

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
            <th class="name-col">Name</th>
            <th class="street-col">Street</th>
            <th class="city-col">City</th>
            <th class="state-col">State/Province</th>
            <th class="postal-col">Postal Code</th>
            <th class="country-col">Country</th>
            <th class="rating-col">Rating</th>
            <th class="lat-col">Latitude</th>
            <th class="lon-col">Longitude</th>
            <th class="park-url-col">Park URL</th>
            <th class="phone-col">Phone</th>
            <th class="maps-col">Maps URL</th>
            <th class="details-col">Details</th>
            <th class="about-col">About</th>
            <th class="summary-col">Summary</th>
            <th class="images-col">Images</th>
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
            <td colspan="7" class="url-cell">
                <a href="${url}" target="_blank" class="url-link">[Page Link]</a>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Function to update table row with data
function updateTableRow(url, data) {
    const row = resultsTable.querySelector(`tr[data-url="${url}"]`);
    if (!row) return;

    // Split address into components
    const addressParts = parseAddress(data.address || '');

    row.innerHTML = `
        <td class="status-col">Completed</td>
        <td class="name-col">${data.name || ''}</td>
        <td class="street-col">${addressParts.street || ''}</td>
        <td class="city-col">${addressParts.city || ''}</td>
        <td class="state-col">${addressParts.state || ''}</td>
        <td class="postal-col">${addressParts.postalCode || ''}</td>
        <td class="country-col">${addressParts.country || ''}</td>
        <td class="rating-col">${data.rating || ''}</td>
        <td class="lat-col">${data.lat || ''}</td>
        <td class="lon-col">${data.lon || ''}</td>
        <td class="park-url-col">
            ${data.parkUrl ? `<a href="${data.parkUrl}" target="_blank" class="url-link">[View]</a>` : ''}
        </td>
        <td class="phone-col">${data.phone || ''}</td>
        <td class="maps-col">
            <a href="${url}" target="_blank" class="url-link">[View]</a>
        </td>
        <td class="details-col">${data.details ? 'Extracted' : ''}</td>
        <td class="about-col">${data.about ? 'Extracted' : ''}</td>
        <td class="summary-col">${data.summary ? 'Extracted' : ''}</td>
        <td class="images-col">${data.imageUrls ? data.imageUrls.length : '0'}</td>
    `;
}

// Function to parse address into components
function parseAddress(fullAddress) {
    const parts = {
        street: '',
        city: '',
        state: '',
        postalCode: '',
        country: ''
    };

    if (!fullAddress) return parts;

    // Split address by commas
    const components = fullAddress.split(',').map(part => part.trim());

    if (components.length >= 1) {
        parts.street = components[0];
    }
    
    if (components.length >= 2) {
        parts.city = components[1];
    }
    
    if (components.length >= 3) {
        // Check for Canadian postal code format (A1A 1A1) or US format (12345 or 12345-1234)
        const statePostalMatch = components[2].match(/([A-Z]{2})\s*((?:[A-Z]\d[A-Z]\s*\d[A-Z]\d)|(?:\d{5}(?:-\d{4})?))/) ||
                                components[2].match(/([A-Z]{2})\s*([A-Z]\d[A-Z]\s*\d[A-Z]\d)/);
        if (statePostalMatch) {
            parts.state = statePostalMatch[1];
            parts.postalCode = statePostalMatch[2].replace(/\s+/g, ' ').trim();
        } else {
            parts.state = components[2];
        }
    }
    
    if (components.length >= 4) {
        // If postal code wasn't in state component, check the next component
        if (!parts.postalCode) {
            const postalMatch = components[3].match(/(?:[A-Z]\d[A-Z]\s*\d[A-Z]\d)|(?:\d{5}(?:-\d{4})?)/);
            if (postalMatch) {
                parts.postalCode = postalMatch[0].replace(/\s+/g, ' ').trim();
                parts.country = components[3].replace(postalMatch[0], '').trim();
            } else {
                parts.country = components[3];
            }
        } else {
            parts.country = components[3];
        }
    }

    return parts;
}

// Function to download CSV
function downloadCsv() {
    const headers = [
        'Name',
        'Park URL',
        'Phone',
        'Street Address',
        'City',
        'State/Province',
        'Postal Code',
        'Country',
        'Rating',
        'Latitude',
        'Longitude',
        'Place ID',
        'Maps URL',
        'Details',
        'About',
        'Summary',
        'post_images' // Single column for all images
    ];

    const rows = Array.from(AppState.processedData.values()).map(data => {
        const addressParts = parseAddress(data.address || '');
        const imageUrls = data.imageUrls || [];
        
        // Format images in the required format: URL|ID|TITLE|DESCRIPTION::
        const formattedImages = imageUrls
            .map(url => `${url}|||`) // Empty ID, TITLE, and DESCRIPTION
            .join('::');
        
        return [
            data.name || '',
            data.parkUrl || '',
            data.phone || '',
            addressParts.street || '',
            addressParts.city || '',
            addressParts.state || '',
            addressParts.postalCode || '',
            addressParts.country || '',
            data.rating || '',
            data.lat || '',
            data.lon || '',
            data.placeId || '',
            data.url || '',
            data.details || '',
            data.about || '',
            data.summary || '',
            formattedImages // All images in a single column
        ];
    });

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Create timestamp for filename
    const now = new Date();
    const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '.',
        String(now.getHours()).padStart(2, '0'),
        '-',
        String(now.getMinutes()).padStart(2, '0'),
        '-',
        String(now.getSeconds()).padStart(2, '0')
    ].join('');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `google_maps_data.${timestamp}.csv`;
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

// ... rest of existing code ...
