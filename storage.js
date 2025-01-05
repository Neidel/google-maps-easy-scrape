// Storage module for handling persistent data storage

export class StorageManager {
    static async savePlaceData(url, placeData) {
        try {
            // Get existing data
            const { places = {}, urlToPlaceId = {} } = await chrome.storage.local.get(['places', 'urlToPlaceId']);
            
            // Update data
            places[placeData.placeId] = {
                data: placeData,
                processedAt: Date.now()
            };
            urlToPlaceId[url] = placeData.placeId;

            // Save updated data
            await chrome.storage.local.set({ places, urlToPlaceId });
            return true;
        } catch (error) {
            console.error('Error saving place data:', error);
            return false;
        }
    }

    static async savePendingUrls(urls) {
        try {
            const { pendingUrls = [] } = await chrome.storage.local.get('pendingUrls');
            // Merge new URLs with existing ones, removing duplicates
            const uniqueUrls = [...new Set([...pendingUrls, ...urls])];
            await chrome.storage.local.set({ pendingUrls: uniqueUrls });
            return true;
        } catch (error) {
            console.error('Error saving pending URLs:', error);
            return false;
        }
    }

    static async getPendingUrls() {
        try {
            const { pendingUrls = [] } = await chrome.storage.local.get('pendingUrls');
            return pendingUrls;
        } catch (error) {
            console.error('Error getting pending URLs:', error);
            return [];
        }
    }

    static async removePendingUrl(url) {
        try {
            const { pendingUrls = [] } = await chrome.storage.local.get('pendingUrls');
            const updatedUrls = pendingUrls.filter(u => u !== url);
            await chrome.storage.local.set({ pendingUrls: updatedUrls });
            return true;
        } catch (error) {
            console.error('Error removing pending URL:', error);
            return false;
        }
    }

    static async isUrlProcessed(url) {
        try {
            const { urlToPlaceId = {} } = await chrome.storage.local.get('urlToPlaceId');
            return !!urlToPlaceId[url];
        } catch (error) {
            console.error('Error checking URL status:', error);
            return false;
        }
    }

    static async getStoredPlaces() {
        try {
            const { places = {} } = await chrome.storage.local.get('places');
            return Object.values(places).map(place => place.data);
        } catch (error) {
            console.error('Error getting stored places:', error);
            return [];
        }
    }

    static async clearStorage() {
        try {
            await chrome.storage.local.clear();
            return true;
        } catch (error) {
            console.error('Error clearing storage:', error);
            return false;
        }
    }
} 