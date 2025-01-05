import { StorageManager } from './storage.js';
import { Logger } from './popup.js';

export async function initializeFromStorage() {
    try {
        const storedPlaces = await StorageManager.getStoredPlaces();
        return storedPlaces;
    } catch (error) {
        Logger.error('Error initializing from storage:', error);
        return [];
    }
}

export async function saveToStorage(url, data) {
    try {
        await StorageManager.savePlaceData(url, data);
        Logger.success('Saved data to storage', { url });
        return true;
    } catch (error) {
        Logger.error('Error saving to storage:', error);
        return false;
    }
}

export async function checkUrlInStorage(url) {
    try {
        return await StorageManager.isUrlProcessed(url);
    } catch (error) {
        Logger.error('Error checking URL in storage:', error);
        return false;
    }
}

export async function clearAllStorage() {
    try {
        await StorageManager.clearStorage();
        Logger.success('Cleared all storage');
        return true;
    } catch (error) {
        Logger.error('Error clearing storage:', error);
        return false;
    }
}

export async function getStoredPlacesForExport() {
    try {
        return await StorageManager.getStoredPlaces();
    } catch (error) {
        Logger.error('Error getting stored places for export:', error);
        return [];
    }
} 