// Import Logger from popup.js
import { Logger } from './popup.js';

// Function to parse XML response
async function parseXmlResponse(xmlText) {
    Logger.info('Parsing XML response', { responseLength: xmlText.length });
    
    // Clean up any potential invalid characters
    xmlText = xmlText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    
    // Check for parsing errors
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
        const errorText = parseError.textContent;
        Logger.error('XML parsing error', { error: errorText, xml: xmlText });
        throw new Error(`XML parsing error: ${errorText}`);
    }

    // Find fault element (error response)
    const fault = xmlDoc.querySelector('fault');
    if (fault) {
        const faultString = fault.querySelector('value string')?.textContent || 
                           fault.querySelector('string')?.textContent ||
                           fault.querySelector('value')?.textContent ||
                           'Unknown error';
        Logger.error('WordPress fault', { fault: faultString, xml: xmlText });
        throw new Error(`WordPress fault: ${faultString}`);
    }

    // Find the response struct
    const struct = xmlDoc.querySelector('methodResponse params param value struct');
    if (!struct) {
        Logger.error('Invalid response format', { 
            xmlResponse: xmlText,
            responseStructure: xmlDoc.documentElement.outerHTML
        });
        throw new Error('Invalid response format: No struct found');
    }

    const result = {};
    const members = struct.querySelectorAll('member');
    
    members.forEach(member => {
        const nameElem = member.querySelector('name');
        const valueElem = member.querySelector('value > string, value > int, value > boolean, value > double');
        
        if (nameElem && valueElem) {
            result[nameElem.textContent] = valueElem.textContent;
        }
    });

    if (!result.url) {
        Logger.error('No URL in response', { result, xml: xmlText });
        throw new Error('No URL found in response');
    }

    Logger.success('Successfully parsed XML response', { url: result.url });
    return result;
}

class WordPressImageUploader {
    static SUPPORTED_FORMATS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
    static MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
    static MAX_RETRIES = 5; // Increased from 3 to 5
    static INITIAL_RETRY_DELAY = 5000; // 5 seconds
    static MAX_CONCURRENT_UPLOADS = 2; // Limit concurrent uploads
    static MAX_IMAGE_DIMENSION = 1600; // Max width/height for images
    static JPEG_QUALITY = 0.85; // JPEG quality (0.85 is a good balance)
    static activeUploads = 0;
    static uploadQueue = [];
    static uploadInProgress = false;

    constructor(xmlrpcUrl, username, password, blogId = '') {
        // Ensure URL has protocol
        if (!xmlrpcUrl.startsWith('http://') && !xmlrpcUrl.startsWith('https://')) {
            xmlrpcUrl = `https://${xmlrpcUrl}`;
        }
        
        // Ensure URL ends with xmlrpc.php
        if (!xmlrpcUrl.endsWith('xmlrpc.php')) {
            xmlrpcUrl = xmlrpcUrl.replace(/\/$/, '') + '/xmlrpc.php';
        }

        // Escape special characters in credentials
        this.xmlrpcUrl = xmlrpcUrl;
        this.username = this.escapeXml(username);
        this.password = this.escapeXml(password);
        this.blogId = this.escapeXml(blogId);
    }

    // Helper method to escape XML special characters
    escapeXml(unsafe) {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    async validateImage(file) {
        // Validate file type
        const fileExt = '.' + file.name.split('.').pop().toLowerCase();
        if (!WordPressImageUploader.SUPPORTED_FORMATS.has(fileExt)) {
            return {
                isValid: false,
                error: `Unsupported file format. Supported formats: ${Array.from(WordPressImageUploader.SUPPORTED_FORMATS).join(', ')}`
            };
        }

        // Validate file size
        if (file.size > WordPressImageUploader.MAX_FILE_SIZE) {
            return {
                isValid: false,
                error: 'File size exceeds 10MB limit'
            };
        }

        return {
            isValid: true,
            error: null
        };
    }

    async getFileHash(file) {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const base64String = reader.result
                        .split(',')[1] // Get only the base64 part
                        .replace(/[\r\n]+/g, ''); // Remove any line breaks
                    resolve(base64String);
                } catch (error) {
                    reject(new Error(`Error extracting base64 data: ${error.message}`));
                }
            };
            reader.onerror = error => reject(new Error(`FileReader error: ${error.message}`));
            reader.readAsDataURL(file);
        });
    }

    // Helper method to delay execution with exponential backoff
    async delay(retryCount) {
        const backoffDelay = Math.min(
            WordPressImageUploader.INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
            30000 // Max delay of 30 seconds
        );
        return new Promise(resolve => setTimeout(resolve, backoffDelay));
    }

    // Helper method to make XML-RPC request with retries and exponential backoff
    async makeRequest(xmlrpcRequest, filename, retryCount = 0) {
        try {
            // Wait if too many active uploads
            while (WordPressImageUploader.activeUploads >= WordPressImageUploader.MAX_CONCURRENT_UPLOADS) {
                Logger.info('Waiting for upload slot', {
                    filename,
                    activeUploads: WordPressImageUploader.activeUploads
                });
                await this.delay(1); // Short delay while waiting
            }

            WordPressImageUploader.activeUploads++;

            // Add delay between retries with exponential backoff
            if (retryCount > 0) {
                const backoffDelay = Math.min(
                    WordPressImageUploader.INITIAL_RETRY_DELAY * Math.pow(2, retryCount - 1),
                    30000
                );
                Logger.info(`Retrying upload with exponential backoff (attempt ${retryCount + 1}/${WordPressImageUploader.MAX_RETRIES})`, {
                    filename,
                    delay: `${backoffDelay}ms`
                });
                await this.delay(retryCount);
            }

            const response = await fetch(this.xmlrpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml',
                    'Accept': 'text/xml',
                    'User-Agent': 'WordPress/XMLRPCClient'
                },
                body: xmlrpcRequest
            });

            if (!response.ok) {
                const shouldRetry = response.status === 503 || 
                                  response.status === 429 || 
                                  response.status >= 500;
                
                if (shouldRetry && retryCount < WordPressImageUploader.MAX_RETRIES) {
                    WordPressImageUploader.activeUploads--;
                    return this.makeRequest(xmlrpcRequest, filename, retryCount + 1);
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const xmlResponse = await response.text();
            Logger.info('Received XML response', {
                filename,
                responseSize: `${(xmlResponse.length / 1024).toFixed(2)}KB`,
                response: xmlResponse
            });

            const result = await parseXmlResponse(xmlResponse);
            Logger.success('Upload successful', {
                filename,
                url: result.url
            });

            WordPressImageUploader.activeUploads--;
            return result;

        } catch (error) {
            if (retryCount < WordPressImageUploader.MAX_RETRIES) {
                WordPressImageUploader.activeUploads--;
                return this.makeRequest(xmlrpcRequest, filename, retryCount + 1);
            }
            WordPressImageUploader.activeUploads--;
            throw error;
        }
    }

    // Helper method to resize image
    async resizeImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                // Calculate new dimensions while maintaining aspect ratio
                let width = img.width;
                let height = img.height;
                
                if (width > WordPressImageUploader.MAX_IMAGE_DIMENSION || 
                    height > WordPressImageUploader.MAX_IMAGE_DIMENSION) {
                    if (width > height) {
                        height = Math.round(height * (WordPressImageUploader.MAX_IMAGE_DIMENSION / width));
                        width = WordPressImageUploader.MAX_IMAGE_DIMENSION;
                    } else {
                        width = Math.round(width * (WordPressImageUploader.MAX_IMAGE_DIMENSION / height));
                        height = WordPressImageUploader.MAX_IMAGE_DIMENSION;
                    }
                }

                // Create canvas for resizing
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                
                // Draw resized image
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);

                // Convert to blob
                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            reject(new Error('Failed to create blob from canvas'));
                            return;
                        }
                        
                        const resizedFile = new File([blob], file.name, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });

                        Logger.info('Image resized', {
                            filename: file.name,
                            originalSize: `${(file.size / 1024).toFixed(2)}KB`,
                            newSize: `${(resizedFile.size / 1024).toFixed(2)}KB`,
                            dimensions: `${width}x${height}`
                        });

                        resolve(resizedFile);
                    },
                    'image/jpeg',
                    WordPressImageUploader.JPEG_QUALITY
                );
            };

            img.onerror = () => reject(new Error('Failed to load image for resizing'));
            img.src = URL.createObjectURL(file);
        });
    }

    async uploadImage(file) {
        try {
            // Validate the image file
            const { isValid, error } = await this.validateImage(file);
            if (!isValid) {
                Logger.error(`Validation error: ${error}`, { filename: file.name });
                return null;
            }

            // Resize image if it's not an SVG
            let processedFile = file;
            if (!file.name.toLowerCase().endsWith('.svg')) {
                try {
                    processedFile = await this.resizeImage(file);
                } catch (error) {
                    Logger.warn('Failed to resize image, using original', {
                        filename: file.name,
                        error: error.message
                    });
                }
            }

            // Get file details
            const fileExt = '.jpg'; // Always use .jpg for resized images
            const fileHash = await this.getFileHash(processedFile);
            const uniqueFilename = `${fileHash}${fileExt}`;

            // Get base64 data
            let base64Data;
            try {
                base64Data = await this.fileToBase64(processedFile);
                Logger.info('File converted to base64', { 
                    filename: processedFile.name,
                    base64Length: base64Data.length
                });
            } catch (error) {
                Logger.error('Error converting file to base64', {
                    filename: processedFile.name,
                    error: error.stack
                });
                return null;
            }

            // Prepare XML-RPC request
            const xmlrpcRequest = [
                '<?xml version="1.0"?>',
                '<methodCall>',
                '<methodName>wp.uploadFile</methodName>',
                '<params>',
                `<param><value><string>${this.blogId}</string></value></param>`,
                `<param><value><string>${this.username}</string></value></param>`,
                `<param><value><string>${this.password}</string></value></param>`,
                '<param><value><struct>',
                '<member><name>name</name>',
                `<value><string>${uniqueFilename}</string></value></member>`,
                '<member><name>type</name>',
                '<value><string>image/jpeg</string></value></member>',
                '<member><name>bits</name>',
                `<value><base64>${base64Data}</base64></value></member>`,
                '<member><name>overwrite</name>',
                '<value><boolean>1</boolean></value></member>',
                '</struct></value></param>',
                '</params>',
                '</methodCall>'
            ].join('');

            Logger.info('Sending XML-RPC request', {
                filename: uniqueFilename,
                requestSize: `${(xmlrpcRequest.length / 1024).toFixed(2)}KB`
            });

            return await this.makeRequest(xmlrpcRequest, uniqueFilename);

        } catch (error) {
            Logger.error('Error uploading image', {
                filename: file.name,
                error: error.stack
            });
            return null;
        }
    }
}

// Export only WordPressImageUploader
export default WordPressImageUploader; 