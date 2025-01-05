// Define scan regions
const SCAN_REGIONS = [
    // British Columbia
    {
        minLat: 48.0,
        maxLat: 60.0,
        minLon: -139.0,
        maxLon: -114.0,
        name: 'BC'
    },
    // Prairie Provinces (AB, SK, MB)
    {
        minLat: 49.0,
        maxLat: 60.0,
        minLon: -114.0,
        maxLon: -89.0,
        name: 'Prairies'
    },
    // Ontario
    {
        minLat: 42.0,
        maxLat: 57.0,
        minLon: -89.0,
        maxLon: -74.0,
        name: 'ON'
    },
    // Quebec & Atlantic
    {
        minLat: 45.0,
        maxLat: 62.0,
        minLon: -74.0,
        maxLon: -52.0,
        name: 'East'
    }
];

// Define CSV headers
const CSV_HEADERS = [
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
    MAX_RETRIES: 3,
    gridScanState: {
        isScanning: false,
        currentLat: null,
        currentLon: null,
        currentRegionIndex: 0,
        zoom: 8.69,
        lonStep: 6.28,    // Calculated from example
        latStep: 5.0,     // Adjustable based on testing
        urlsCollected: 0,
        processedLocations: new Set(),
        uniqueUrls: new Set(),
        currentRegion: null
    }
};

// Export Logger for use in other modules
export const Logger = {
    levels: {
        INFO: 'INFO',
        WARN: 'WARN',
        ERROR: 'ERROR',
        SUCCESS: 'SUCCESS'
    },

    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            data
        };

        const logStyle = {
            INFO: 'color: #0066cc',
            WARN: 'color: #ff9900',
            ERROR: 'color: #cc0000',
            SUCCESS: 'color: #00cc00'
        };

        console.log(
            `%c[${timestamp}] [${level}] ${message}`,
            logStyle[level],
            data ? data : ''
        );

        return logEntry;
    },

    info(message, data = null) {
        return this.log(this.levels.INFO, message, data);
    },

    warn(message, data = null) {
        return this.log(this.levels.WARN, message, data);
    },

    error(message, data = null) {
        return this.log(this.levels.ERROR, message, data);
    },

    success(message, data = null) {
        return this.log(this.levels.SUCCESS, message, data);
    }
};

// Import WordPress uploader
import WordPressImageUploader from './wordpress.js';

// Grid Scanning Functions
async function startGridScan() {
    console.log('Starting grid scan');
    AppState.gridScanState.isScanning = true;
    AppState.gridScanState.currentRegionIndex = 0;
    const firstRegion = SCAN_REGIONS[0];
    AppState.gridScanState.currentLat = firstRegion.minLat;
    AppState.gridScanState.currentLon = firstRegion.minLon;
    AppState.gridScanState.currentRegion = firstRegion.name;
    AppState.gridScanState.urlsCollected = 0;
    AppState.gridScanState.processedLocations.clear();
    AppState.gridScanState.uniqueUrls.clear();
    
    updateScanProgress();
    await navigateAndCollect();
}

function isLocationInCanada(lat, lon) {
    // Basic boundary check
    if (lat < 41.0) return false;  // South of Canada
    if (lat > 70.0) return false;  // North of populated Canada
    if (lon < -141.0) return false; // West of Canada
    if (lon > -52.0) return false;  // East of Canada
    
    // Rough checks for obvious water/US areas
    // Pacific Ocean
    if (lat < 48.0 && lon < -123.0) return false;
    // Atlantic Ocean
    if (lat < 43.0 && lon > -65.0) return false;
    
    return true;
}

async function navigateAndCollect() {
    if (!AppState.gridScanState.isScanning) return;
    
    if (!isLocationInCanada(AppState.gridScanState.currentLat, AppState.gridScanState.currentLon)) {
        console.log('Location outside Canada, moving to next position');
        moveToNextGridPosition();
        return;
    }

    const currentUrl = generateMapUrl();
    console.log('Navigating to:', currentUrl);
    
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
            console.error('No active tab found');
            return;
        }

        await chrome.tabs.update(tab.id, { url: currentUrl });
        
        // Wait for initial page load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Execute scrolling script
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrollResults,
        });
        
        // Wait for scrolling to complete and content to load
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await collectAndProcessLocation();
    } catch (error) {
        console.error('Navigation error:', error);
        moveToNextGridPosition();
    }
}

function generateMapUrl() {
    const baseUrl = 'https://www.google.com/maps/search/rv+park+canada';
    const params = `@${AppState.gridScanState.currentLat},${AppState.gridScanState.currentLon},${AppState.gridScanState.zoom}z/data=!4m2!2m1!6e1?entry=ttu`;
    return `${baseUrl}/${params}`;
}

function moveToNextGridPosition() {
    if (!AppState.gridScanState.isScanning) return;

    const region = SCAN_REGIONS[AppState.gridScanState.currentRegionIndex];
    
    // Move right
    AppState.gridScanState.currentLon += AppState.gridScanState.lonStep;

    // If we've reached the eastern boundary of current region
    if (AppState.gridScanState.currentLon > region.maxLon) {
        AppState.gridScanState.currentLon = region.minLon;
        AppState.gridScanState.currentLat += AppState.gridScanState.latStep;

        // If we've reached the northern boundary of current region
        if (AppState.gridScanState.currentLat > region.maxLat) {
            // Move to next region
            AppState.gridScanState.currentRegionIndex++;
            
            // If we have another region to scan
            if (AppState.gridScanState.currentRegionIndex < SCAN_REGIONS.length) {
                const nextRegion = SCAN_REGIONS[AppState.gridScanState.currentRegionIndex];
                AppState.gridScanState.currentLat = nextRegion.minLat;
                AppState.gridScanState.currentLon = nextRegion.minLon;
                AppState.gridScanState.currentRegion = nextRegion.name;
                console.log('Moving to next region:', nextRegion.name);
            } else {
                handleGridScanComplete();
                return;
            }
        }
    }

    navigateAndCollect();
}

async function collectAndProcessLocation() {
    try {
        const locationKey = `${AppState.gridScanState.currentLat},${AppState.gridScanState.currentLon}`;
        if (AppState.gridScanState.processedLocations.has(locationKey)) {
            console.log('Location already processed:', locationKey);
            moveToNextGridPosition();
            return;
        }

        const urls = await collectUrlsFromPage();
        if (urls && urls.length > 0) {
            // Filter out duplicates
            const newUrls = urls.filter(url => !AppState.gridScanState.uniqueUrls.has(url));
            newUrls.forEach(url => AppState.gridScanState.uniqueUrls.add(url));
            
            AppState.gridScanState.urlsCollected += newUrls.length;
            AppState.collectedUrls.push(...newUrls);
            
            updateTable(AppState.collectedUrls);
            updateScanProgress();
        }

        AppState.gridScanState.processedLocations.add(locationKey);
        moveToNextGridPosition();
    } catch (error) {
        console.error('Error collecting URLs:', error);
        moveToNextGridPosition();
    }
}

function handleGridScanComplete() {
    console.log('Grid scan complete');
    AppState.gridScanState.isScanning = false;
    AppState.gridScanState.currentRegion = null;
    
    // Enable processing button if we have URLs
    if (AppState.collectedUrls.length > 0) {
        processButton.disabled = false;
        clearButton.disabled = false;
    }
    
    updateScanProgress();
}

function updateScanProgress(message) {
    const progressElement = document.getElementById('scanProgress');
    if (!progressElement) return;

    if (AppState.gridScanState.isScanning) {
        const region = SCAN_REGIONS[AppState.gridScanState.currentRegionIndex];
        const position = `${AppState.gridScanState.currentLat.toFixed(4)}, ${AppState.gridScanState.currentLon.toFixed(4)}`;
        const progress = `${region.name} | ${position} | URLs: ${AppState.gridScanState.urlsCollected}`;
        progressElement.textContent = progress;
    } else if (AppState.isProcessing) {
        // Show processing status even when not scanning
        progressElement.textContent = message;
    } else {
        progressElement.textContent = AppState.gridScanState.urlsCollected > 0 ? 
            `Scan complete. Total URLs: ${AppState.gridScanState.urlsCollected}` : 
            message || 'Ready to scan';
    }
    
    // Log the update for debugging
    console.log('Updating scan progress:', message);
}

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
    
    // Reset grid scan state
    AppState.gridScanState.isScanning = false;
    AppState.gridScanState.currentLat = null;
    AppState.gridScanState.currentLon = null;
    AppState.gridScanState.currentRegionIndex = 0;
    AppState.gridScanState.currentRegion = null;
    AppState.gridScanState.urlsCollected = 0;
    AppState.gridScanState.processedLocations.clear();
    AppState.gridScanState.uniqueUrls.clear();
    
    const progressElement = document.getElementById('scanProgress');
    if (progressElement) {
        progressElement.textContent = 'Ready to scan';
    }
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
async function handleXhrCaptured(message) {
    const data = message.data;
    console.log('Received XHR data:', data);
    
    if (data && data.placeId) {
        console.log('Processing data for place ID:', data.placeId);
        AppState.isProcessing = true;  // Set processing state to true
        updateScanProgress(`Processing: ${data.name || 'Location'}`);
        
        if (message.currentState) {
            updateState(message.currentState);
            
            const processedUrl = AppState.currentUrl || AppState.collectedUrls.find(url => {
                const urlPlaceId = extractPlaceIdFromUrl(url);
                return validatePlaceIds(urlPlaceId, data.placeId);
            });

            if (processedUrl) {
                console.log('Found processed URL:', processedUrl);
                try {
                    clearStallTimeout();
                    
                    const wpUploader = new WordPressImageUploader(
                        'L1la4.thedev.ca',
                        'justin@umbric.com',
                        'c!wPWhD4VcIrrTj^U$9$&zeg'
                    );

                    const imageUrls = data.imageUrls || [];
                    let successfulUploads = 0;
                    let failedUploads = 0;
                    const uploadedImages = [];

                    if (imageUrls.length > 0) {
                        updateScanProgress(`Processing ${data.name}: Found ${imageUrls.length} images to upload`);
                        setStallTimeout(processedUrl, imageUrls.length * 30000);
                    }

                    for (const [index, imageUrl] of imageUrls.entries()) {
                        clearStallTimeout();
                        setStallTimeout(processedUrl, 30000);
                        
                        updateScanProgress(`Processing ${data.name}: Uploading image ${index + 1}/${imageUrls.length}`);
                        
                        const imageFile = await processGoogleImage(imageUrl, index, imageUrls.length);
                        if (imageFile) {
                            const result = await wpUploader.uploadImage(imageFile);
                            if (result && result.url) {
                                successfulUploads++;
                                uploadedImages.push(`${result.url}|||`);
                                clearStallTimeout();
                                updateScanProgress(`Processing ${data.name}: Successfully uploaded ${successfulUploads}/${imageUrls.length} images`);
                            } else {
                                failedUploads++;
                                updateScanProgress(`Processing ${data.name}: Failed to upload image ${index + 1}/${imageUrls.length}`);
                            }
                        } else {
                            failedUploads++;
                            updateScanProgress(`Processing ${data.name}: Failed to process image ${index + 1}/${imageUrls.length}`);
                        }
                    }

                    data.uploadedImages = uploadedImages.join('::');
                    
                    if (imageUrls.length > 0) {
                        updateScanProgress(`Processing ${data.name}: Completed with ${successfulUploads} successful and ${failedUploads} failed uploads`);
                    }
                    
                    clearStallTimeout();
                } catch (error) {
                    Logger.error('Error during image processing and upload:', error);
                    updateScanProgress(`Error processing ${data.name}: ${error.message}`);
                }

                if (markUrlAsProcessed(processedUrl, data)) {
                    updateTableRow(processedUrl, data);
                    updateRowStatus(processedUrl, 'completed');
                    clearStallTimeout();
                    if (downloadCsvButton) downloadCsvButton.disabled = false;
                    updateScanProgress(`Completed processing: ${data.name}`);
                }
            }

            AppState.isProcessing = false;  // Set processing state to false when done
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
            updateScanProgress(`Error: ${errorMessage}`);
            AppState.isProcessing = false;  // Set processing state to false on error
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
    const gridScanButton = document.getElementById('gridScanButton');

    // Initialize table headers
    initializeTableHeaders();

    // Enable buttons
    collectButton.disabled = false;
    gridScanButton.disabled = false;

    // Add event listeners
    gridScanButton.addEventListener('click', async () => {
        try {
            gridScanButton.disabled = true;
            collectButton.disabled = true;
            clearButton.disabled = true;
            processButton.disabled = true;
            
            // Clear existing data before starting new scan
            resetState();
            clearTable();
            
            await startGridScan();
        } catch (error) {
            Logger.error('Error starting grid scan:', error);
        } finally {
            // Re-enable buttons if scan is not in progress
            if (!AppState.gridScanState.isScanning) {
                gridScanButton.disabled = false;
                collectButton.disabled = false;
            }
        }
    });

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
        gridScanButton.disabled = false; // Re-enable grid scan button after clearing
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

    // Count uploaded images
    const uploadedImagesCount = data.uploadedImages ? data.uploadedImages.split('::').length : 0;

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
        <td class="images-col">${uploadedImagesCount}</td>
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

// Function to resize image if needed
async function resizeImageIfNeeded(file, maxSizeMB = 8) {
    Logger.info('Checking if image needs resizing', { 
        filename: file.name,
        currentSize: `${(file.size / 1024 / 1024).toFixed(2)}MB`,
        maxSize: `${maxSizeMB}MB`
    });

    if (file.size <= maxSizeMB * 1024 * 1024) {
        Logger.info('Image is within size limit, no resize needed');
        return file;
    }

    try {
        // Create an image bitmap from the file
        const bitmap = await createImageBitmap(file);
        
        // Create a canvas
        const canvas = document.createElement('canvas');
        let width = bitmap.width;
        let height = bitmap.height;
        
        // Calculate scale factor to reduce size while maintaining aspect ratio
        const targetSize = maxSizeMB * 1024 * 1024; // Convert MB to bytes
        const currentSize = file.size;
        const scaleFactor = Math.sqrt(targetSize / currentSize);
        
        // Apply scale factor to dimensions
        width *= scaleFactor;
        height *= scaleFactor;
        
        Logger.info('Resizing image', {
            originalWidth: bitmap.width,
            originalHeight: bitmap.height,
            newWidth: Math.round(width),
            newHeight: Math.round(height),
            scaleFactor
        });

        canvas.width = width;
        canvas.height = height;
        
        // Draw resized image to canvas
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        // Convert canvas to blob
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, file.type, 0.9);
        });
        
        // Create new file with same name but resized content
        const resizedFile = new File([blob], file.name, { type: file.type });
        
        Logger.success('Image resized successfully', {
            filename: file.name,
            originalSize: `${(file.size / 1024 / 1024).toFixed(2)}MB`,
            newSize: `${(resizedFile.size / 1024 / 1024).toFixed(2)}MB`
        });
        
        return resizedFile;
    } catch (error) {
        Logger.error('Error resizing image', {
            error: error.stack,
            filename: file.name
        });
        return file;
    }
}

// Function to process and download image
async function processGoogleImage(imageUrl, index, total) {
    Logger.info(`Processing image ${index + 1}/${total}`, { url: imageUrl });
    
    try {
        // Remove any size parameters and get highest quality version
        const baseUrl = imageUrl.split('=')[0];
        const highQualityUrl = `${baseUrl}=s0`; // s0 requests original size
        Logger.info(`Requesting high quality image`, { highQualityUrl });

        // Fetch the image
        const response = await fetch(highQualityUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${highQualityUrl} (Status: ${response.status})`);
        }
        
        // Get content type from response
        const contentType = response.headers.get('content-type');
        let fileExtension = '.jpg'; // default to jpg
        
        // Determine file extension based on content type
        if (contentType) {
            Logger.info(`Detected content type: ${contentType}`);
            if (contentType.includes('png')) fileExtension = '.png';
            else if (contentType.includes('gif')) fileExtension = '.gif';
            else if (contentType.includes('webp')) fileExtension = '.webp';
            else if (contentType.includes('svg')) fileExtension = '.svg';
        } else {
            Logger.warn('No content type detected, defaulting to .jpg');
        }

        // Get the image data
        const blob = await response.blob();
        Logger.info(`Image downloaded successfully`, { 
            size: `${(blob.size / 1024).toFixed(2)}KB`,
            type: blob.type
        });
        
        // Create a unique filename
        const uniqueId = Math.random().toString(36).substring(2, 15);
        const filename = `rv_park_image_${uniqueId}${fileExtension}`;
        
        // Create a File object with proper type
        let file = new File([blob], filename, { type: contentType || 'image/jpeg' });
        
        // Resize if needed
        file = await resizeImageIfNeeded(file);
        
        Logger.success(`Image processed successfully`, { 
            filename: file.name,
            size: `${(file.size / 1024).toFixed(2)}KB`,
            type: file.type
        });
        
        return file;
    } catch (error) {
        Logger.error(`Error processing Google image: ${error.message}`, {
            url: imageUrl,
            error: error.stack
        });
        return null;
    }
}

// Function to download CSV
async function downloadCsv() {
    const startTime = Date.now();
    Logger.info('Starting CSV download process');
    
    // Show loading state
    const downloadButton = document.getElementById('downloadCsvButton');
    const originalIcon = downloadButton.innerHTML;
    downloadButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    downloadButton.disabled = true;

    try {
        const totalEntries = AppState.processedData.size;
        Logger.info(`Processing ${totalEntries} entries for CSV generation`);

        const rows = Array.from(AppState.processedData.values()).map(data => {
            const addressParts = parseAddress(data.address || '');
            
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
                data.uploadedImages || '' // Use the already uploaded images
            ];
        });

        Logger.info('Generating CSV content');
        const csvContent = [
            CSV_HEADERS.join(','),
            ...rows.map(row => row.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv' });
        
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

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `google_maps_data.${timestamp}.csv`;
        
        Logger.info('Initiating CSV download', {
            filename: a.download,
            size: `${(blob.size / 1024).toFixed(2)}KB`
        });
        
        a.click();
        window.URL.revokeObjectURL(url);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        Logger.success(`Process completed successfully`, {
            duration: `${duration}s`,
            entriesProcessed: totalEntries,
            csvSize: `${(blob.size / 1024).toFixed(2)}KB`
        });

    } catch (error) {
        Logger.error('Error generating CSV', {
            error: error.stack,
            duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
        });
        alert('Error generating CSV. Please check the console for details.');
    } finally {
        // Restore button state
        downloadButton.innerHTML = originalIcon;
        downloadButton.disabled = false;
    }
}

// Function to handle stall detection
function setStallTimeout(url, duration = 15000) {
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
    }, duration);
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

// Function to scroll results
function scrollResults() {
    return new Promise((resolve) => {
        let lastHeight = 0;
        const maxAttempts = 10;
        let attempts = 0;
        
        function scroll() {
            const resultsDiv = document.querySelector('div[role="feed"]');
            if (!resultsDiv) {
                console.log('Results container not found');
                resolve();
                return;
            }

            const currentHeight = resultsDiv.scrollHeight;
            if (currentHeight === lastHeight || attempts >= maxAttempts) {
                console.log('Scrolling complete or max attempts reached');
                resolve();
                return;
            }

            lastHeight = currentHeight;
            resultsDiv.scrollTo(0, currentHeight);
            attempts++;
            
            setTimeout(scroll, 1000);
        }

        scroll();
    });
}

// ... rest of existing code ...
