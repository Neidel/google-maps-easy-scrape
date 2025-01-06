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

// Import WordPress uploader and other modules
import WordPressImageUploader from './wordpress.js';
import { processAboutText, parseAddressWithAI } from './openai.js';
import { 
    initializeFromStorage,
    saveToStorage,
    checkUrlInStorage,
    clearAllStorage,
    getStoredPlacesForExport
} from './storage-integration.js';

// State management
const AppState = {
    collectedUrls: [],
    processedData: new Map(),
    urlToPlaceId: new Map(),
    isProcessing: false,
    currentUrl: null,
    stallTimeout: null,
    processingHistory: new Set(),
    retryCount: new Map(),
    MAX_RETRIES: 3,
    gridScanState: {
        isScanning: false,
        currentLat: null,
        currentLon: null,
        currentRegionIndex: 0,
        zoom: 8.69,
        lonStep: 6.28,
        latStep: 5.0,
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
    updateScanProgress('Navigating to new location...');
    
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
            console.error('No active tab found');
            updateScanProgress('Error: No active tab found');
            return;
        }

        await chrome.tabs.update(tab.id, { url: currentUrl });
        
        // Wait for initial page load
        await new Promise(resolve => setTimeout(resolve, 3000));
        updateScanProgress('Waiting for page to load...');
        
        // Execute scrolling script
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scrollResults,
        });
        
        // Wait for scrolling to complete and content to load
        await new Promise(resolve => setTimeout(resolve, 2000));
        updateScanProgress('Collecting data from page...');
        
        await collectAndProcessLocation();
    } catch (error) {
        console.error('Navigation error:', error);
        updateScanProgress('Error during navigation');
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
        const progress = `Scanning ${region.name} | Position: ${position} | URLs: ${AppState.gridScanState.urlsCollected}`;
        progressElement.textContent = progress;
        console.log('Grid scan progress:', progress);
    } else if (AppState.isProcessing) {
        // Show processing status even when not scanning
        const displayMessage = message || 'Processing...';
        progressElement.textContent = displayMessage;
        console.log('Processing status:', displayMessage);
    } else {
        const displayMessage = AppState.gridScanState.urlsCollected > 0 ? 
            `Scan complete. Total URLs: ${AppState.gridScanState.urlsCollected}` : 
            message || 'Ready to scan';
        progressElement.textContent = displayMessage;
        console.log('Status update:', displayMessage);
    }
}

// UI Elements
let resultsTable;
let collectButton, processButton, clearButton, downloadCsvButton;

// State management functions
async function resetState() {
    try {
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
        
        // Clear storage
        await clearAllStorage();
        
        const progressElement = document.getElementById('scanProgress');
        if (progressElement) {
            progressElement.textContent = 'Ready to scan';
        }
    } catch (error) {
        console.error('Error resetting state:', error);
        updateScanProgress('Error resetting state');
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

async function markUrlAsProcessed(url, data) {
    if (!url || !data) return false;
    
    const placeId = data.placeId;
    if (!placeId) return false;

    AppState.processedData.set(placeId, data);
    AppState.urlToPlaceId.set(url, placeId);
    AppState.processingHistory.add(url);
    
    await saveToStorage(url, data);
    
    // Enable download button since we have data
    if (downloadCsvButton) {
        downloadCsvButton.disabled = false;
    }
    
    return true;
}

async function isUrlProcessed(url) {
    return AppState.processingHistory.has(url) || 
           Array.from(AppState.urlToPlaceId.keys()).includes(url) ||
           await checkUrlInStorage(url);
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

// Update processNextUrl to use storage
async function processNextUrl() {
    if (AppState.isProcessing) {
        console.log('Already processing a URL, skipping');
        return;
    }

    clearStallTimeout();

    // Filter out processed URLs and those that have exceeded retry limits
    const unprocessedUrls = [];
    for (const url of AppState.collectedUrls) {
        const processed = await isUrlProcessed(url);
        if (!processed && canRetryUrl(url)) {
            unprocessedUrls.push(url);
        } else if (!processed) {
            console.log(`URL exceeded retry limit: ${url}`);
            updateRowStatus(url, 'error', 'Max retries exceeded');
        } else {
            console.log(`URL already processed: ${url}`);
            updateRowStatus(url, 'completed');
        }
    }

    console.log('Unprocessed URLs:', unprocessedUrls.length, unprocessedUrls);

    if (unprocessedUrls.length > 0) {
        const nextUrl = unprocessedUrls[0];
        
        console.log('Processing next URL:', nextUrl);
        updateRowStatus(nextUrl, 'processing');
        
        AppState.isProcessing = true;
        AppState.currentUrl = nextUrl;
        
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
        processButton.disabled = true;  // Disable the process button when all URLs are processed
        
        // If we have processed data, enable the download button
        if (AppState.processedData.size > 0 || await StorageManager.getStoredPlaces().length > 0) {
            downloadCsvButton.disabled = false;
        }
    }
}

// Update handleXhrCaptured to use new state management
async function handleXhrCaptured(message) {
    const data = message.data;
    console.log('Received XHR data:', data);
    
    if (data && data.placeId) {
        console.log('Processing data for place ID:', data.placeId);
        AppState.isProcessing = true;
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

            AppState.isProcessing = false;
            AppState.currentUrl = null;

            setTimeout(() => {
                if (!AppState.isProcessing) {
                    processNextUrl();
                }
            }, 2000);
        }
    } else {
        console.warn('Received XHR data without place ID', data);
        if (AppState.currentUrl) {
            const retryCount = incrementRetryCount(AppState.currentUrl);
            const errorMessage = `No place ID found (Attempt ${retryCount}/${AppState.MAX_RETRIES})`;
            updateRowStatus(AppState.currentUrl, 'error', errorMessage);
            updateScanProgress(`Error: ${errorMessage}`);
            AppState.isProcessing = false;
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

    // Load stored data and enable download if we have any data
    const storedPlaces = await initializeFromStorage();
    if (storedPlaces.length > 0) {
        storedPlaces.forEach(data => {
            if (data.placeId) {
                AppState.processedData.set(data.placeId, data);
                if (data.url) {
                    AppState.urlToPlaceId.set(data.url, data.placeId);
                    AppState.processingHistory.add(data.url);
                }
            }
        });
        downloadCsvButton.disabled = false;  // Enable download if we have stored data
    }

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

            const entries = await collectUrlsFromPage();
            if (entries && entries.length > 0) {
                AppState.collectedUrls = entries.map(entry => entry.url);
                updateTable(entries);
                processButton.disabled = false;
                clearButton.disabled = false;
            } else {
                alert('No new URLs found. All visible locations have already been processed.');
                collectButton.disabled = false;
            }
        } catch (error) {
            console.error('Error collecting URLs:', error);
            alert('Error collecting URLs. Please try again.');
            collectButton.disabled = false;
        }
    });

    processButton.addEventListener('click', async () => {
        const hasUnprocessedUrls = await checkForUnprocessedUrls();
        if (!hasUnprocessedUrls) {
            console.log('No unprocessed URLs found');
            processButton.disabled = true;
            alert('No URLs available for processing. Please collect URLs first.');
            return;
        }
        
        processButton.disabled = true;
        processNextUrl();
    });

    clearButton.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all data? This cannot be undone.')) {
            await clearAllStorage();
            resetState();
            clearTable();
            chrome.runtime.sendMessage({ type: 'clear_captured_data' });
            processButton.disabled = true;
            clearButton.disabled = true;
            downloadCsvButton.disabled = true;  // Disable download when clearing all data
            collectButton.disabled = false;
            gridScanButton.disabled = false;
        }
    });

    downloadCsvButton.addEventListener('click', async () => {
        const storedPlaces = await getStoredPlacesForExport();
        if (storedPlaces.length === 0) {
            alert('No data available for export. Please collect and process some locations first.');
            return;
        }
        downloadCsv();
    });

    const clearMemoryButton = document.getElementById('clearMemoryButton');
    
    clearMemoryButton.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all stored data from memory? This will remove all previously collected data but keep the current list.')) {
            await clearAllStorage();
            AppState.processedData.clear();
            AppState.urlToPlaceId.clear();
            AppState.processingHistory.clear();
            Logger.success('Memory cleared successfully');
            
            // Update UI to reflect cleared memory
            const rows = resultsTable.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const statusCell = row.querySelector('.status-col');
                if (statusCell && statusCell.textContent === 'Completed') {
                    statusCell.textContent = 'Pending';
                }
            });
            
            // Enable process button if there are URLs in the list
            if (AppState.collectedUrls.length > 0) {
                processButton.disabled = false;
            }
            
            // Disable download button since memory is cleared
            downloadCsvButton.disabled = true;
        }
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
                const entries = [];
                const links = Array.from(document.querySelectorAll('a[href*="maps/place"]'));
                links.forEach(link => {
                    const url = link.href;
                    if (url.includes('/maps/place/')) {
                        // Get name from aria-label, removing " · Visited link" if present
                        let name = link.getAttribute('aria-label') || '';
                        name = name.replace(/\s*·\s*Visited link$/, '').trim();
                        
                        // If no aria-label, try to find name in heading elements
                        if (!name) {
                            const nameElement = link.querySelector('h3, h4, h5') || 
                                             link.closest('[role="article"]')?.querySelector('h3, h4, h5');
                            name = nameElement ? nameElement.textContent.trim() : '';
                        }
                        
                        entries.push({ url, name });
                    }
                });
                return entries.filter((entry, index, self) => 
                    self.findIndex(e => e.url === entry.url) === index
                );
            }
        });

        const allEntries = result[0]?.result || [];
        const newEntries = [];
        
        // Filter out already processed URLs
        for (const entry of allEntries) {
            const processed = await isUrlProcessed(entry.url);
            if (!processed) {
                newEntries.push(entry);
            } else {
                console.log(`Skipping already processed URL: ${entry.url}`);
            }
        }

        return newEntries;
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
function updateTable(entries) {
    const tbody = resultsTable.querySelector('tbody');
    tbody.innerHTML = '';

    entries.forEach(entry => {
        const row = document.createElement('tr');
        row.dataset.url = entry.url;
        row.innerHTML = `
            <td class="status-col">
                Pending
                <button class="delete-row-btn" title="Remove from list">
                    <i class="fas fa-times"></i>
                </button>
            </td>
            <td class="name-col">${entry.name || 'Unknown'}</td>
            <td colspan="6" class="url-cell">
                <a href="${entry.url}" target="_blank" class="url-link">[Page Link]</a>
            </td>
        `;

        // Add click handler for delete button
        const deleteBtn = row.querySelector('.delete-row-btn');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            const url = row.dataset.url;
            
            // Remove from AppState
            AppState.collectedUrls = AppState.collectedUrls.filter(u => u !== url);
            
            // Remove the row
            row.remove();
            
            // Update button states
            if (AppState.collectedUrls.length === 0) {
                processButton.disabled = true;
                clearButton.disabled = true;
            }
            
            Logger.info('Removed URL from list:', url);
        });

        tbody.appendChild(row);
    });
}

// Function to update table row with data
async function updateTableRow(url, data) {
    const row = resultsTable.querySelector(`tr[data-url="${url}"]`);
    if (!row) return;

    // Split address into components
    const addressParts = await parseAddress(data.address || '');

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
async function parseAddress(fullAddress) {
    // Try AI parsing first
    const aiParsed = await parseAddressWithAI(fullAddress);
    if (aiParsed) {
        return aiParsed;
    }

    // Fallback to regex parsing if AI fails
    const parts = {
        street: '',
        city: '',
        state: '',
        postalCode: '',
        country: ''
    };

    if (!fullAddress) return parts;

    // Split address by commas and clean each part
    const components = fullAddress.split(',').map(part => part.trim());

    // Handle Canadian address format
    if (components.length >= 1) {
        // First component is always street
        parts.street = components[0];
    }
    
    if (components.length >= 2) {
        // Second component is typically the city
        parts.city = components[1];
    }
    
    if (components.length >= 3) {
        // Third component usually contains province and postal code
        const thirdPart = components[2].trim();
        
        // Try different postal code formats
        // Format 1: "SK S7K 3N2"
        const combinedMatch = thirdPart.match(/([A-Z]{2})\s+([A-Z]\d[A-Z]\s*\d[A-Z]\d)/i);
        // Format 2: "SK"
        const stateOnlyMatch = thirdPart.match(/^[A-Z]{2}$/i);
        // Format 3: "S7K 3N2"
        const postalOnlyMatch = thirdPart.match(/^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i);
        
        if (combinedMatch) {
            // Both province and postal code in same part
            parts.state = combinedMatch[1].toUpperCase();
            parts.postalCode = combinedMatch[2].replace(/\s+/g, ' ').trim().toUpperCase();
        } else if (stateOnlyMatch) {
            // Just province code
            parts.state = thirdPart.toUpperCase();
        } else if (postalOnlyMatch) {
            // Just postal code
            parts.postalCode = thirdPart.replace(/\s+/g, ' ').trim().toUpperCase();
        } else {
            // Try to extract any province code
            const stateMatch = thirdPart.match(/[A-Z]{2}/i);
            if (stateMatch) {
                parts.state = stateMatch[0].toUpperCase();
            }
            // Try to extract any postal code
            const postalMatch = thirdPart.match(/[A-Z]\d[A-Z]\s*\d[A-Z]\d/i);
            if (postalMatch) {
                parts.postalCode = postalMatch[0].replace(/\s+/g, ' ').trim().toUpperCase();
            }
        }
    }
    
    if (components.length >= 4) {
        const fourthPart = components[3].trim().toUpperCase();
        if (fourthPart === 'CANADA') {
            parts.country = 'Canada';
            } else {
            // Check if fourth part contains a postal code
            const postalMatch = fourthPart.match(/([A-Z]\d[A-Z]\s*\d[A-Z]\d)/i);
            if (postalMatch && !parts.postalCode) {
                parts.postalCode = postalMatch[0].replace(/\s+/g, ' ').trim().toUpperCase();
                // Rest is country
                parts.country = fourthPart.replace(postalMatch[0], '').trim();
        } else {
                parts.country = fourthPart;
            }
        }
    }

    // Default country to Canada if not specified
    if (!parts.country && parts.state) {
        parts.country = 'Canada';
    }

    // Clean up any remaining whitespace and standardize case
    Object.keys(parts).forEach(key => {
        if (parts[key]) {
            parts[key] = parts[key].replace(/\s+/g, ' ').trim();
            // Proper case for country
            if (key === 'country' && parts[key].toUpperCase() === 'CANADA') {
                parts[key] = 'Canada';
        }
    }
    });

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
    
    const downloadButton = document.getElementById('downloadCsvButton');
    const originalIcon = downloadButton.innerHTML;
    downloadButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    downloadButton.disabled = true;

    try {
        const storedPlaces = await getStoredPlacesForExport();
        Logger.info(`Processing ${storedPlaces.length} entries for CSV generation`);

        const rows = await Promise.all(storedPlaces.map(async data => {
            const addressParts = await parseAddress(data.address || '');
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
                data.uploadedImages || ''
            ];
        }));

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
            entriesProcessed: storedPlaces.length,
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

// Helper function to check for unprocessed URLs
async function checkForUnprocessedUrls() {
    for (const url of AppState.collectedUrls) {
        const processed = await isUrlProcessed(url);
        if (!processed && canRetryUrl(url)) {
            return true;
        }
    }
    return false;
}

// ... rest of existing code ...
