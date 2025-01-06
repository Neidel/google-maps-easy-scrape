# Google Maps RV Park Scraper

A powerful Chrome extension designed to efficiently collect and process RV park data from Google Maps, with a focus on Canadian locations. This tool automates the process of gathering detailed information about RV parks, including amenities, descriptions, images, and location data.

## Installation

1. **Prerequisites**:
   - Google Chrome browser (version 88 or higher)
   - Node.js (v14 or higher)
   - npm (v6 or higher)

2. **Chrome Extension Installation**:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked" and select the project directory
   - The extension icon should appear in your Chrome toolbar

## Features

### Data Collection
- **Grid-Based Scanning**: Systematically scans across Canadian regions (BC, Prairies, Ontario, Quebec & Atlantic)
- **Smart Data Extraction**: Pulls comprehensive information for each RV park:
  - Basic details (name, address, phone, rating)
  - Geographic coordinates
  - Website URLs
  - Amenities and features
  - Photos
  - Business descriptions
  - User ratings

### Data Processing
- **AI-Powered Description Generation**: Uses OpenAI's GPT model to create engaging, natural descriptions
- **Intelligent Address Parsing**: Automatically breaks down addresses into components
- **Image Processing**: 
  - Automatic image optimization
  - WordPress integration for image hosting
  - Handles multiple image formats (JPG, PNG, GIF, WebP, SVG)

### Export & Integration
- **CSV Export**: Generates detailed CSV files with all collected data
- **WordPress Integration**: Direct upload of processed images to WordPress
- **Data Fields Include**:
  - Name
  - Park URL
  - Phone
  - Street Address
  - City
  - State/Province
  - Postal Code
  - Country
  - Rating
  - Latitude/Longitude
  - Place ID
  - Maps URL
  - Details
  - About
  - Summary
  - Images

## Technical Components

### System Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│   Chrome UI     │     │  Background      │     │   External     │
│  (popup.js)     │────▶│  Service Worker  │────▶│   Services     │
│                 │     │  (background.js)  │     │                │
└────────┬────────┘     └────────┬─────────┘     └────────────────┘
         │                       │                        ▲
         │                       │                        │
         │                       ▼                        │
         │               ┌──────────────────┐            │
         └──────────────▶│  Data Processing │────────────┘
                        │   & Storage       │
                        └──────────────────┘

```

#### Component Communication
- **UI Layer** (`popup.js`):
  - Handles user interactions
  - Manages visual state
  - Initiates operations
  - Displays results

- **Background Service** (`background.js`):
  - Manages browser tabs
  - Handles XHR interception
  - Coordinates data processing
  - Manages retry logic

- **Data Processing**:
  - Address parsing (OpenAI)
  - Image processing
  - Data validation
  - State management

- **External Services**:
  - OpenAI API integration
  - WordPress image hosting
  - Google Maps data extraction

#### Data Flow
1. User initiates scan/collection
2. Background service manages tab navigation
3. Data is extracted and processed
4. Results are stored and displayed
5. Export/integration as requested

## Key Functions

#### Data Collection
- `startGridScan()`: Initiates systematic scanning of Canadian regions
- `collectUrlsFromPage()`: Extracts RV park URLs from Google Maps
- `parseLocationData()`: Extracts detailed information from each location
- `collectImageUrls()`: Gathers high-quality images for each location

#### Data Processing
- `processAboutText()`: Generates AI-powered descriptions
- `parseAddress()`: Breaks down address components
- `resizeImageIfNeeded()`: Optimizes images for storage
- `processGoogleImage()`: Handles image downloading and processing

#### Export & Management
- `downloadCsv()`: Generates formatted CSV exports
- `updateTableRow()`: Updates UI with processed data
- `markUrlAsProcessed()`: Manages processing state
- `saveToStorage()`: Handles data persistence

## Usage

1. **Grid Scan Mode**:
   - Click the grid scan button to systematically scan Canadian regions
   - Monitor progress in real-time
   - Automatically collects URLs for processing

2. **Manual Collection**:
   - Navigate to Google Maps
   - Search for RV parks
   - Click collect button to gather visible locations

3. **Processing**:
   - Click process button to start data extraction
   - Monitor progress in the table
   - View status updates in real-time

4. **Export**:
   - Click download button for CSV export
   - All data includes AI-generated descriptions
   - Images are hosted on WordPress

## Error Handling

- Automatic retry mechanism for failed requests
- Exponential backoff for rate limiting
- Graceful handling of API failures
- Data persistence to prevent loss

## Limitations

- Focused on Canadian RV parks
- Requires Chrome browser
- API key requirements:
  - OpenAI for descriptions/address parsing
  - WordPress for image hosting

## Dependencies

- Chrome Extension APIs
- OpenAI GPT API
- WordPress XML-RPC API
- Font Awesome for UI
- Poppins font family 