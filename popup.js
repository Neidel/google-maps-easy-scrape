// Define utility functions at the global scope
let resultsTable;
let collectedUrls = [];
let processedData = new Map();
let urlToPlaceId = new Map();
let isProcessing = false;
let currentUrl = null;
let collectButton, processButton, clearButton, downloadCsvButton;

// Helper functions defined at global scope
function updateRowStatus(url, status, errorMessage = '') {
    console.log('Updating row status:', { url, status, errorMessage });
    if (!resultsTable) {
        console.error('Results table not initialized');
        return;
    }
    
    const rows = resultsTable.getElementsByTagName('tr');
    let found = false;
    
    for (let i = 0; i < rows.length; i++) {
        const urlCell = rows[i].cells[rows[i].cells.length - 1];
        const urlLink = urlCell?.querySelector('a');
        
        if (urlLink && urlLink.href === url) {
            found = true;
            const statusCell = rows[i].cells[0];
            if (status === 'processing') {
                console.log('Setting processing status');
                statusCell.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                rows[i].className = 'processing';
            } else if (status === 'completed') {
                console.log('Setting completed status');
                statusCell.innerHTML = '<i class="fas fa-check"></i>';
                rows[i].className = 'completed';
            } else if (status === 'error') {
                console.log('Setting error status');
                statusCell.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
                rows[i].className = 'error';
                statusCell.title = errorMessage || 'Failed to process - auth error';
                
                // Add retry button
                const retryButton = document.createElement('button');
                retryButton.innerHTML = '<i class="fas fa-redo"></i>';
                retryButton.className = 'button';
                retryButton.title = 'Retry';
                retryButton.style.marginLeft = '5px';
                retryButton.onclick = () => {
                    updateRowStatus(url, 'processing');
                    processNextUrl();
                };
                statusCell.appendChild(retryButton);
            }
            break;
        }
    }
    
    if (!found) {
        console.warn('No row found for URL:', url);
    }
}

function updateTableRow(url, data) {
    console.log('Attempting to update row for URL:', url);
    if (!resultsTable) {
        console.error('Results table not initialized');
        return;
    }
    
    const rows = resultsTable.getElementsByTagName('tr');
    let found = false;
    
    for (let i = 0; i < rows.length; i++) {
        const urlCell = rows[i].cells[rows[i].cells.length - 1];
        const urlLink = urlCell?.querySelector('a');
        
        if (urlLink && urlLink.href === url) {
            console.log('Found matching row for URL');
            found = true;
            const row = rows[i];
            
            try {
                // Update data cells with cleaner data
                const cells = row.cells;
                const values = [
                    data.name || '',
                    data.businessType || '',
                    data.address?.street || '',
                    data.address?.city || '',
                    data.address?.state || '',
                    data.address?.postalCode || '',
                    data.address?.country || '',
                    data.rating || '',
                    data.coordinates?.lat || '',
                    data.coordinates?.lng || '',
                    data.placeId || ''
                ];
                
                console.log('Updating cells with values:', values);
                values.forEach((value, index) => {
                    if (cells[index + 1]) {
                        cells[index + 1].textContent = value;
                    }
                });
                
                // Update website cell if present
                const websiteCell = cells[cells.length - 2];
                if (websiteCell && data.website) {
                    websiteCell.innerHTML = '';
                    const websiteLink = document.createElement('a');
                    websiteLink.href = data.website;
                    websiteLink.textContent = 'Visit';
                    websiteLink.className = 'url-link';
                    websiteLink.target = '_blank';
                    websiteLink.title = data.website;
                    websiteCell.appendChild(websiteLink);
                } else if (websiteCell) {
                    websiteCell.textContent = '-';
                }
                
                console.log('Row updated successfully');
            } catch (error) {
                console.error('Error updating row:', error);
            }
            break;
        }
    }
    
    if (!found) {
        console.warn('No matching row found for URL:', url);
    }
}

function handleXhrCaptured(message) {
    const data = message.data;
    console.log('Received XHR data:', data);
    
    if (data && data.placeId) {
        console.log('Processing data for place ID:', data.placeId);
        
        // Update local state with the complete current state from background
        if (message.currentState) {
            console.log('Updating state from background:', message.currentState);
            
            // Keep existing URLs if none provided in state
            if (!message.currentState.collectedUrls || message.currentState.collectedUrls.length === 0) {
                message.currentState.collectedUrls = collectedUrls;
            }
            
            // Update local state
            collectedUrls = message.currentState.collectedUrls;
            processedData = new Map(message.currentState.processedData || []);
            urlToPlaceId = new Map(message.currentState.urlToPlaceId || []);
            isProcessing = message.currentState.isProcessing;
            currentUrl = message.currentState.currentUrl;

            console.log('Current state after update:', {
                collectedUrls: collectedUrls.length,
                processedData: processedData.size,
                urlToPlaceId: urlToPlaceId.size,
                isProcessing,
                currentUrl
            });

            // Find the URL that corresponds to this place ID
            const processedUrl = currentUrl || collectedUrls.find(url => {
                const urlPlaceId = extractPlaceIdFromUrl(url);
                return validatePlaceIds(urlPlaceId, data.placeId);
            });

            if (processedUrl) {
                console.log('Found processed URL:', processedUrl);
                // Update local state
                processedData.set(data.placeId, data);
                urlToPlaceId.set(processedUrl, data.placeId);
                
                // Update the specific row
                updateTableRow(processedUrl, data);
                updateRowStatus(processedUrl, 'completed');
            } else {
                console.warn('Could not find URL for place ID:', data.placeId);
            }

            // Get remaining unprocessed URLs
            const remainingUrls = collectedUrls.filter(url => {
                const urlPlaceId = urlToPlaceId.get(url);
                return !processedData.has(urlPlaceId);
            });

            console.log('Remaining URLs:', remainingUrls.length, remainingUrls);

            // Reset processing flag and process next URL after a delay
            isProcessing = false;
            if (remainingUrls.length > 0) {
                console.log('Processing next URL in 2 seconds');
                setTimeout(() => {
                    if (!isProcessing) {
                        processNextUrl();
                    }
                }, 2000);
            } else {
                console.log('No more URLs to process');
                chrome.runtime.sendMessage({ type: 'processing_complete' });
                if (processButton) processButton.disabled = false;
            }
        }
    } else {
        console.warn('Received XHR data without place ID');
        if (currentUrl) {
            updateRowStatus(currentUrl, 'error', 'No place ID found in response');
        }
    }
}

function processNextUrl() {
    if (isProcessing) {
        console.log('Already processing a URL, skipping');
        return;
    }

    // Check all URLs against processed data
    const unprocessedUrls = collectedUrls.filter(url => {
        const urlPlaceId = extractPlaceIdFromUrl(url);
        const mappedPlaceId = urlToPlaceId.get(url);
        const isProcessed = mappedPlaceId && urlPlaceId === mappedPlaceId;
        
        console.log('URL processing check:', {
            url,
            urlPlaceId,
            mappedPlaceId,
            isProcessed
        });
        
        return !isProcessed;
    });

    console.log('Unprocessed URLs:', unprocessedUrls.length, unprocessedUrls);

    if (unprocessedUrls.length > 0) {
        const nextUrl = unprocessedUrls[0];
        console.log('Processing next URL:', nextUrl);
        
        // Update UI to show processing state
        updateRowStatus(nextUrl, 'processing');
        
        // Send message to process URL
        chrome.runtime.sendMessage({
            type: 'process_url',
            url: nextUrl
        });
        
        isProcessing = true;
        currentUrl = nextUrl;
        
        // Set up stall detection
        stallTimeout = setTimeout(() => {
            console.log('Processing appears stalled, retrying...');
            updateRowStatus(nextUrl, 'error', 'Processing stalled, retrying...');
            isProcessing = false;
            currentUrl = null;
            processNextUrl();
        }, 15000); // 15 second timeout
    } else {
        console.log('All URLs processed');
        isProcessing = false;
        currentUrl = null;
    }
}

// Main initialization
document.addEventListener('DOMContentLoaded', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        var currentTab = tabs[0];
        
        // Initialize global variables
        resultsTable = document.getElementById('resultsTable');
        collectButton = document.getElementById('collectButton');
        processButton = document.getElementById('processButton');
        clearButton = document.getElementById('clearButton');
        downloadCsvButton = document.getElementById('downloadCsvButton');

        // Navigate to default search URL if not already on Google Maps
        const defaultSearchUrl = 'https://www.google.com/maps/search/rv+park+canada/@50.9913465,-119.2177973,9z/data=!4m2!2m1!6e1?entry=ttu&g_ep=EgoyMDI0MTIxMS4wIKXMDSoASAFQAw%3D%3D';
        
        if (!currentTab.url.includes("://www.google.com/maps")) {
            chrome.tabs.update(currentTab.id, { url: defaultSearchUrl });
        } else {
            if (currentTab.url.includes("://www.google.com/maps")) {
                collectButton.disabled = false;
            } else {
                collectButton.style.display = 'none';
                processButton.style.display = 'none';
                downloadCsvButton.style.display = 'none';
            }
        }

        // Collect URLs button
        collectButton.addEventListener('click', function() {
            console.log('Starting URL collection...');
            chrome.scripting.executeScript({
                target: {tabId: currentTab.id},
                function: collectUrls
            }, function(results) {
                console.log('Collection results:', results);
                if (!results || !results[0] || !results[0].result) {
                    console.log('No results found');
                    return;
                }
                
                collectedUrls = results[0].result;
                // Update background script with new URLs
                chrome.runtime.sendMessage({ 
                    type: 'set_collected_urls', 
                    urls: collectedUrls 
                });
                
                console.log('Collected URLs:', collectedUrls);
                updateTable(collectedUrls);
                
                if (collectedUrls.length > 0) {
                    console.log('Enabling buttons after URL collection');
                    processButton.disabled = false;
                    downloadCsvButton.disabled = false;
                }
            });
        });

        // Process URLs button
        processButton.addEventListener('click', function() {
            processButton.disabled = true;
            chrome.runtime.sendMessage({ type: 'clear_captured_data' }, () => {
                // Check if we're on Google Maps
                chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                    const currentUrl = tabs[0].url;
                    if (!currentUrl.includes('google.com/maps')) {
                        // If not on maps, navigate there first
                        chrome.tabs.update(tabs[0].id, { 
                            url: 'https://www.google.com/maps' 
                        }, () => {
                            // Wait for navigation to complete
                            setTimeout(() => {
                                // Process all URLs
                                if (collectedUrls.length > 0) {
                                    processNextUrl();
                                }
                            }, 2000);
                        });
                    } else {
                        // Process all URLs
                        if (collectedUrls.length > 0) {
                            processNextUrl();
                        }
                    }
                });
            });
        });

        // Clear button
        clearButton.addEventListener('click', function() {
            console.log('Clearing data');
            collectedUrls = [];
            processedData.clear();
            urlToPlaceId.clear();
            currentUrl = null;
            updateTable([]);
            processButton.disabled = true;
            downloadCsvButton.disabled = true;
            isProcessing = false;
            chrome.runtime.sendMessage({ type: 'clear_captured_data' });
        });

        // Download CSV button
        downloadCsvButton.addEventListener('click', function() {
            var csv = generateCsv();
            var now = new Date();
            var timestamp = now.getFullYear() + 
                          ('0' + (now.getMonth() + 1)).slice(-2) + 
                          ('0' + now.getDate()).slice(-2) + '_' +
                          ('0' + now.getHours()).slice(-2) + 
                          ('0' + now.getMinutes()).slice(-2);
            var filename = 'locations_' + timestamp + '.csv';
            downloadCsv(csv, filename);
        });

        // Restore state from background script
        chrome.runtime.sendMessage({ type: 'get_state' }, (response) => {
            if (response && response.success && response.state) {
                const state = response.state;
                collectedUrls = state.collectedUrls;
                processedData = new Map(state.processedData);
                urlToPlaceId = new Map(state.urlToPlaceId);
                isProcessing = state.isProcessing;
                currentUrl = state.currentUrl;

                // Update UI based on restored state
                updateTable(collectedUrls);
                if (collectedUrls.length > 0) {
                    processButton.disabled = false;
                    downloadCsvButton.disabled = false;
                }
                if (isProcessing) {
                    processButton.disabled = true;
                }
            }
        });
    });
});

// Add missing functions
function collectUrls() {
    console.log('Collecting URLs...');
    
    // Try multiple selectors to find location links
    const selectors = [
        'a[href*="/maps/place/"]',    // Direct place links
        'div.Nv2PK a.hfpxzc',        // Search results links
        'a.hfpxzc[href*="/maps/place/"]', // Alternative search results
        'div[jsaction*="navigationCard"] a[href*="/maps/place/"]' // Navigation cards
    ];
    
    const websiteUrls = new Map();
    const placeUrls = new Set();

    // Try each selector
    selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        console.log(`Found ${elements.length} elements with selector: ${selector}`);
        
        elements.forEach(element => {
            if (element.href && element.href.includes('/maps/place/')) {
                placeUrls.add(element.href);
                
                // Find the parent container
                const container = element.closest('div[role="article"], div.Nv2PK, div[jsaction*="navigationCard"]');
                if (container) {
                    // Look for website link in this container
                    const websiteLink = container.querySelector('a[data-tooltip="Open website"], a.CsEnBe[href^="http"]');
                    if (websiteLink) {
                        websiteUrls.set(element.href, websiteLink.href);
                    }
                }
            }
        });
    });

    const uniqueUrls = Array.from(placeUrls);

    // Store website URLs in chrome.storage for later use
    chrome.storage.local.set({ websiteUrls: Array.from(websiteUrls.entries()) }, () => {
        console.log('Stored website URLs:', websiteUrls);
    });

    console.log('Found URLs:', uniqueUrls);
    console.log('Found website URLs:', websiteUrls);
    
    return uniqueUrls;
}

function updateTable(urls) {
    console.log('Updating table with URLs:', urls?.length);
    if (!urls || urls.length === 0) {
        console.log('No URLs to display');
        return;
    }

    const tbody = resultsTable.getElementsByTagName('tbody')[0];
    const thead = resultsTable.getElementsByTagName('thead')[0];

    // Keep existing header if it exists
    if (!thead.innerHTML) {
        thead.innerHTML = `
            <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Business Type</th>
                <th>Address</th>
                <th>City</th>
                <th>State</th>
                <th>Postal Code</th>
                <th>Country</th>
                <th>Rating</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Place ID</th>
                <th>Website</th>
                <th>Maps URL</th>
            </tr>
        `;
    }

    // Clear existing rows
    tbody.innerHTML = '';
    
    // Add rows for each URL
    urls.forEach((url, index) => {
        console.log(`Processing URL ${index + 1}/${urls.length}`);
        const row = tbody.insertRow();
        
        // Get place ID and data
        const placeId = urlToPlaceId.get(url);
        const data = placeId ? processedData.get(placeId) : null;
        
        // Status column
        const statusCell = row.insertCell();
        statusCell.style.textAlign = 'center';
        
        if (data) {
            // Processed URL
            statusCell.innerHTML = '<i class="fas fa-check"></i>';
            row.className = 'completed';
            
            // Add data cells
            [
                data.name,
                data.businessType,
                data.address?.street,
                data.address?.city,
                data.address?.state,
                data.address?.postalCode,
                data.address?.country,
                data.rating,
                data.coordinates?.lat,
                data.coordinates?.lng,
                data.placeId
            ].forEach(value => {
                row.insertCell().textContent = value ?? '';
            });
            
            // Website cell
            const websiteCell = row.insertCell();
            if (data.website) {
                const websiteLink = document.createElement('a');
                websiteLink.href = data.website;
                websiteLink.textContent = 'Visit';
                websiteLink.className = 'url-link';
                websiteLink.target = '_blank';
                websiteLink.title = data.website;
                websiteCell.appendChild(websiteLink);
            } else {
                websiteCell.textContent = '-';
            }
        } else {
            // Unprocessed URL
            statusCell.innerHTML = '<i class="fas fa-circle"></i>';
            row.className = '';
            
            // Add placeholder cells
            for (let i = 0; i < 12; i++) {
                row.insertCell().textContent = '...';
            }
        }
        
        // Maps URL cell
        const urlCell = row.insertCell();
        urlCell.style.textAlign = 'center';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = 'View';
        link.className = 'url-link';
        link.target = '_blank';
        link.title = url;
        urlCell.appendChild(link);
    });
}

function generateCsv() {
    const headers = [
        'Name', 'Business Type', 'Street Address', 'City', 'State/Province',
        'Postal Code', 'Country', 'Rating', 'Latitude', 'Longitude',
        'Place ID', 'Website URL', 'Maps URL'
    ];

    const rows = [headers];

    collectedUrls.forEach(url => {
        // Get the place ID for this URL
        const placeId = urlToPlaceId.get(url);
        // Get the data using the place ID
        const data = placeId ? processedData.get(placeId) : null;
        
        if (data) {
            // Safely access nested properties
            const row = [
                data.name || '',
                data.businessType || '',
                data.address?.street || '',
                data.address?.city || '',
                data.address?.state || '',
                data.address?.postalCode || '',
                data.address?.country || '',
                data.rating || '',
                data.coordinates?.lat || '',
                data.coordinates?.lng || '',
                data.placeId || '',
                data.website || '',
                url
            ];
            rows.push(row);
        }
    });

    // Add debug logging
    console.log('Generated CSV rows:', rows);
    
    return rows.map(row => 
        row.map(cell => {
            // Handle null, undefined, and empty values
            const value = (cell ?? '').toString();
            // Escape quotes and wrap in quotes
            return `"${value.replace(/"/g, '""')}"`;
        }).join(',')
    ).join('\n');
}

function downloadCsv(csv, filename) {
    // Add debug logging
    console.log('CSV content length:', csv.length);
    console.log('First 100 characters of CSV:', csv.substring(0, 100));
    
    var csvFile = new Blob([csv], {type: 'text/csv'});
    var downloadLink = document.createElement('a');
    downloadLink.download = filename;
    downloadLink.href = window.URL.createObjectURL(csvFile);
    downloadLink.style.display = 'none';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    
    // Cleanup
    setTimeout(() => {
        document.body.removeChild(downloadLink);
        window.URL.revokeObjectURL(downloadLink.href);
    }, 100);
}

// Add missing validatePlaceIds and extractPlaceIdFromUrl functions
function validatePlaceIds(urlPlaceId, responsePlaceId) {
    if (!urlPlaceId || !responsePlaceId) {
        console.log('Skipping validation - missing place ID:', { urlPlaceId, responsePlaceId });
        return true; // Skip validation if either ID is missing
    }

    // Log original values
    console.log('Validating place IDs:', { urlPlaceId, responsePlaceId });

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

function extractPlaceIdFromUrl(url) {
    try {
        console.log('Extracting place ID from URL:', url);
        
        // Try multiple patterns to extract place ID
        const patterns = [
            /!1s([^!]+)!/,                     // Standard format
            /place\/[^/]+\/([^/]+)/,           // Alternative format
            /data=.*?!1s([^!]+)!/,             // Data parameter format
            /[?&]pb=.*?!1s([^!]+)!/,           // Preview format
            /0x[0-9a-fA-F]+:[0-9a-fA-F]+/,     // Direct hex format
            /ChIJ[a-zA-Z0-9_-]+/,              // ChIJ format
            /!19s([^?]+)\?/,                   // New format with 19s prefix
            /0[a-zA-Z0-9]+!/                   // Alternative Google ID format
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                const placeId = match[1] || match[0];
                console.log('Found place ID with pattern:', {
                    pattern: pattern.toString(),
                    placeId: placeId
                });
                return placeId;
            }
        }

        // If no pattern matches but URL contains a place ID in hex format
        const hexMatch = url.match(/0x[0-9a-fA-F]+:[0-9a-fA-F]+/);
        if (hexMatch) {
            console.log('Found hex format place ID:', hexMatch[0]);
            return hexMatch[0];
        }

        console.log('No place ID found in URL');
        return null;
    } catch (e) {
        console.error('Error extracting place ID:', e);
        return null;
    }
}

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Received message in popup:', message.type, message);
    
    if (message.type === 'xhr_captured') {
        handleXhrCaptured(message);
    } else if (message.type === 'auth_failed') {
        console.log('Auth failed for URL:', message.url);
        updateRowStatus(message.url, 'error', message.error || 'Authentication failed');
        isProcessing = false;
        currentUrl = null;
        
        // Add longer delay before processing next URL
        setTimeout(() => {
            if (!isProcessing) {
                processNextUrl();
            }
        }, 5000);
    } else if (message.type === 'retry_processing') {
        console.log('Received retry processing signal for URL:', message.url);
        isProcessing = false;
        currentUrl = null;
        
        // If a specific URL was provided, update its status
        if (message.url) {
            updateRowStatus(message.url, 'error', 'Retrying...');
        }
        
        setTimeout(() => {
            if (!isProcessing) {
                processNextUrl();
            }
        }, 2000);
    }
});

// ... rest of your existing code ...
