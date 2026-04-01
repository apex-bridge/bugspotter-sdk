# @bugspotter/sdk

> Core SDK for capturing and reporting bugs with session replay

The BugSpotter SDK provides a comprehensive solution for capturing bug reports in web applications, including screenshots, console logs, network requests, session replay, and browser metadata.

## 📦 Installation

### NPM Package

```bash
# npm
npm install @bugspotter/sdk

# yarn
yarn add @bugspotter/sdk

# pnpm
pnpm add @bugspotter/sdk
```

### CDN

```html
<!-- BugSpotter CDN (versioned - recommended for production) -->
<script src="https://cdn.bugspotter.io/sdk/bugspotter-2.0.0.min.js"></script>

<!-- Latest version (for development only) -->
<script src="https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js"></script>

<!-- Or unpkg -->
<script src="https://unpkg.com/@bugspotter/sdk@latest/dist/bugspotter.min.js"></script>
```

📘 **See [CDN Usage Guide](./docs/CDN.md) for detailed CDN integration, SRI hashes, and troubleshooting.**

### From Source

```bash
# Clone and build from source
git clone https://github.com/apex-bridge/bugspotter-sdk.git
cd bugspotter-sdk
pnpm install
pnpm build
```

The built SDK will be available at `dist/bugspotter.min.js` (~99 KB minified with session replay).

## 🚀 Quick Start

### Basic Usage

**ES Modules (React, Vue, Angular, etc.)**

```javascript
import BugSpotter from '@bugspotter/sdk';

// Initialize with auto-widget (note: init is async)
const bugSpotter = await BugSpotter.init({
  endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
  showWidget: true,
});
```

**CommonJS (Node.js)**

```javascript
const BugSpotter = require('@bugspotter/sdk');

const bugSpotter = await BugSpotter.init({
  endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
  showWidget: true,
});
```

**UMD (Browser script tag)**

```html
<script src="https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js"></script>
<script>
  // Initialize with auto-widget
  (async () => {
    const bugSpotter = await BugSpotter.init({
      endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
      showWidget: true,
    });
  })();
</script>
```

### How It Works

The SDK automatically uses an **optimized presigned URL upload flow** (40% fewer HTTP requests):

```javascript
import BugSpotter from '@bugspotter/sdk';

// 1. Initialize SDK with required auth
const bugSpotter = await BugSpotter.init({
  endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
  showWidget: true,
});

// 2. Submit a bug report (SDK handles everything automatically)
// Optimized flow (3 HTTP requests instead of 5):
// - Step 1: POST /api/v1/reports with hasScreenshot/hasReplay flags
//           → Returns bug ID + presigned URLs for screenshot & replay
// - Step 2: PUT to S3 presigned URLs (parallel uploads)
// - Step 3: POST /api/v1/reports/{id}/confirm-upload (confirm each file)
```

**Benefits:**

- **40% fewer HTTP requests** - 3 requests vs 5 in legacy flow
- Files upload directly to S3 (faster, no API bottleneck)
- Automatic compression for replay events
- Concurrent uploads (screenshot + replay in parallel)
- Reduced server load

### Manual Capture & Programmatic Submission

```javascript
// Initialize without widget
const bugSpotter = await BugSpotter.init({
  endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
  showWidget: false,
});

// Capture bug report data
const report = await bugSpotter.capture();
console.log('Captured:', report);
// report contains: screenshot, console, network, metadata, replay

// Submit programmatically (SDK handles presigned URL uploads)
await bugSpotter.submit({
  title: 'Application crashed',
  description: 'Error occurred during form submission',
  priority: 'high',
  report,
});
// ✅ SDK automatically:
// 1. Detects hasScreenshot/hasReplay from report data
// 2. Gets presigned URLs from backend
// 3. Uploads screenshot + replay to S3 (parallel)
// 4. Confirms uploads with backend
```

## 🎨 Using the Widget

### Automatic Widget

```javascript
// Widget appears automatically with showWidget: true
const bugSpotter = await BugSpotter.init({
  endpoint: 'https://api.bugspotter.com',
  apiKey: 'bgs_your_api_key',
  showWidget: true,
  widgetOptions: {
    position: 'bottom-right',
    icon: '⚡',
    backgroundColor: '#1a365d',
    size: 48,
  },
});
```

### Custom Widget

```javascript
// Default professional SVG icon (recommended)
const button = new BugSpotter.FloatingButton({
  position: 'bottom-right',
  // icon: 'svg' is default - professional bug icon
  backgroundColor: '#2563eb', // Professional blue (default)
  tooltip: 'Report an Issue',
});

// Custom emoji/text icon
const button2 = new BugSpotter.FloatingButton({
  position: 'bottom-right',
  icon: '🐛',
  backgroundColor: '#ff4444',
  size: 56,
  offset: { x: 24, y: 24 },
});

// Custom SVG icon
const button3 = new BugSpotter.FloatingButton({
  position: 'bottom-left',
  customSvg: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>
    </svg>
  `,
  tooltip: 'Custom Report Button',
  backgroundColor: '#1a365d',
  size: 48,
});

// Handle click
button.onClick(async () => {
  const report = await bugSpotter.capture();

  const modal = new BugSpotter.BugReportModal({
    onSubmit: async (data) => {
      // Use SDK's submit() method for automatic presigned URL uploads
      await bugSpotter.submit({
        ...data, // title, description, priority
        report,
      });
      // ✅ SDK handles presigned URLs and S3 uploads automatically
    },
  });

  modal.show(report._screenshotPreview || '');
});

// Control button
button.show();
button.hide();
button.setIcon('⚠️');
button.setBackgroundColor('#00ff00');
```

## 🔒 PII Sanitization

Automatic detection and masking of sensitive data before submission.

**Built-in patterns:** Email, phone, credit card, SSN, Kazakhstan IIN, IP address

```javascript
await BugSpotter.init({
  sanitize: {
    enabled: true, // Default
    patterns: ['email', 'phone', 'creditcard'],
    customPatterns: [{ name: 'api-key', regex: /API[-_]KEY:\s*[\w-]{20,}/gi }],
    excludeSelectors: ['.public-email'],
  },
});
```

**Performance:** <10ms overhead, supports Cyrillic text

## 📋 API Reference

### BugSpotter Class

#### `BugSpotter.init(config)`

Initialize the SDK. **This method is async** to support fetching backend-controlled replay quality settings.

**Parameters:**

```typescript
interface BugSpotterConfig {
  apiKey: string; // Required: API key (bgs_...)
  endpoint?: string; // Base URL of BugSpotter API (e.g., https://api.example.com)
  showWidget?: boolean; // Auto-show widget (default: true)
  widgetOptions?: FloatingButtonOptions;
  replay?: {
    // Session replay configuration
    enabled?: boolean; // Enable replay (default: true)
    duration?: number; // Buffer duration in seconds (default: 15)
    sampling?: {
      mousemove?: number; // Mousemove throttle in ms (default: 50)
      scroll?: number; // Scroll throttle in ms (default: 100)
    };
    // Quality settings (optional, backend controlled by default)
    inlineStylesheet?: boolean; // Inline CSS stylesheets (default: backend controlled)
    inlineImages?: boolean; // Inline images (default: backend controlled)
    collectFonts?: boolean; // Collect fonts (default: backend controlled)
    recordCanvas?: boolean; // Record canvas elements (default: backend controlled)
    recordCrossOriginIframes?: boolean; // Record cross-origin iframes (default: backend controlled)
  };
  sanitize?: {
    // PII sanitization configuration
    enabled?: boolean; // Enable PII sanitization (default: true)
    patterns?: Array<
      // PII patterns to detect
      'email' | 'phone' | 'creditcard' | 'ssn' | 'iin' | 'ip' | 'custom'
    >;
    customPatterns?: Array<{
      // Custom regex patterns
      name: string; // Pattern name for [REDACTED-NAME]
      regex: RegExp; // Detection regex
    }>;
    excludeSelectors?: string[]; // CSS selectors to exclude from sanitization
  };
}
```

**Returns:** `BugSpotter` instance

#### `bugSpotter.submit(payload)`

Submit a bug report with automatic file uploads via presigned URLs.

**Parameters:**

```typescript
interface BugReportPayload {
  title: string; // Bug title (required)
  description?: string; // Bug description (optional)
  priority?: 'low' | 'medium' | 'high' | 'critical';
  report: BugReport; // Report data from capture()
}
```

**Returns:** `Promise<void>`

**Throws:** Error if submission fails

**Example:**

```typescript
const report = await bugSpotter.capture();

await bugSpotter.submit({
  title: 'Button not responding',
  description: 'Submit button does not work on checkout page',
  priority: 'high',
  report,
});
```

**What it does:**

1. Detects screenshot and replay from report data
2. Requests presigned URLs from backend
3. Uploads files directly to S3 (parallel)
4. Confirms uploads with backend
5. Handles errors and retries automatically

#### `bugSpotter.capture()`

Capture current bug report data.

**Returns:** `Promise<BugReport>`

```typescript
interface BugReport {
  screenshotKey?: string; // Storage key after presigned URL upload
  console: ConsoleLog[]; // Array of console entries
  network: NetworkRequest[]; // Array of network requests
  metadata: BrowserMetadata; // Browser/system info
  replay?: eventWithTime[]; // Session replay events (rrweb format)
  replayKey?: string; // Storage key after presigned URL upload
  _screenshotPreview?: string; // Internal: screenshot preview for modal (not sent to API)
}

interface ConsoleLog {
  level: string; // 'log', 'warn', 'error', 'info', 'debug'
  message: string; // Formatted message
  timestamp: number; // Unix timestamp
  stack?: string; // Error stack trace (for errors)
}

interface NetworkRequest {
  url: string; // Request URL
  method: string; // HTTP method
  status: number; // HTTP status code
  duration: number; // Request duration in ms
  timestamp: number; // Unix timestamp
  error?: string; // Error message if failed
}

interface BrowserMetadata {
  userAgent: string;
  viewport: { width: number; height: number };
  browser: string; // Detected browser name
  os: string; // Detected OS
  url: string; // Current page URL
  timestamp: number; // Capture timestamp
}
```

#### `bugSpotter.getConfig()`

Get current configuration.

**Returns:** `Readonly<BugSpotterConfig>`

#### `bugSpotter.destroy()`

Clean up and destroy the SDK instance.

### FloatingButton Class

#### Constructor

```typescript
new FloatingButton(options?: FloatingButtonOptions)

interface FloatingButtonOptions {
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  icon?: string;            // 'svg' for default bug icon, or custom emoji/text
  customSvg?: string;       // Custom SVG icon (overrides icon if provided)
  backgroundColor?: string; // CSS color (default: '#2563eb' professional blue)
  size?: number;            // Size in pixels (default: 56)
  offset?: { x: number; y: number };
  tooltip?: string;         // Custom tooltip text (default: 'Report an Issue')
  style?: Record<string, string>; // Additional CSS
}
```

#### Methods

- `button.onClick(handler: () => void | Promise<void>)` - Set click handler
- `button.show()` - Show the button
- `button.hide()` - Hide the button
- `button.setIcon(icon: string)` - Change icon
- `button.setBackgroundColor(color: string)` - Change color
- `button.destroy()` - Remove button from DOM

### BugReportModal Class

#### Constructor

```typescript
new BugReportModal(options: BugReportModalOptions)

interface BugReportModalOptions {
  onSubmit: (data: BugReportData) => void | Promise<void>;
  onClose?: () => void;
}

interface BugReportData {
  title: string;
  description: string;
}
```

#### Methods

- `modal.show(screenshot: string)` - Display modal with screenshot
- `modal.close()` - Close the modal
- `modal.destroy()` - Remove modal from DOM

**Features:**

- Form validation (title and description required)
- Loading state during async submission
- Error handling with user feedback
- Escape key to close
- Click X button to close
- Cannot close by clicking outside (prevents data loss)

### DirectUploader Class

Direct client-to-storage uploads using presigned URLs (97% memory reduction, 3x faster).

#### Constructor

```typescript
new DirectUploader(config: DirectUploadConfig)

interface DirectUploadConfig {
  apiEndpoint: string;    // Backend API URL
  apiKey: string;         // bgs_... API key
  bugId: string;         // Bug report UUID
}
```

#### Methods

**`uploadScreenshot(file, onProgress?)`**

Upload screenshot directly to storage.

```typescript
const screenshotBlob = await fetch(dataUrl).then((r) => r.blob());

const result = await uploader.uploadScreenshot(screenshotBlob, (progress) => {
  console.log(`Screenshot: ${progress.loaded}/${progress.total} (${progress.percentage}%)`);
});

// result: { success: true, storageKey: "screenshots/..." }
```

**`uploadReplay(compressedBlob, onProgress?)`**

Upload compressed replay data to storage.

```typescript
const compressed = await compressReplayEvents(events);
const result = await uploader.uploadReplay(compressed);
```

**`uploadAttachment(file, onProgress?)`**

Upload attachment file to storage.

```typescript
const file = document.querySelector('input[type="file"]').files[0];
const result = await uploader.uploadAttachment(file);
```

#### Upload Progress

```typescript
interface UploadProgress {
  loaded: number; // Bytes uploaded
  total: number; // Total bytes
  percentage: number; // 0-100
}

type UploadProgressCallback = (progress: UploadProgress) => void;
```

#### Upload Result

```typescript
interface UploadResult {
  success: boolean;
  storageKey?: string; // Storage location (if successful)
  error?: string; // Error message (if failed)
}
```

### Compression Utilities

Compress replay events before uploading (2MB JSON → ~200KB gzip).

**`compressReplayEvents(events)`**

```typescript
import { compressReplayEvents } from '@bugspotter/sdk';

const events = [
  /* rrweb events */
];
const compressed = await compressReplayEvents(events);
console.log(`Compressed: ${(compressed.size / 1024).toFixed(2)} KB`);
```

Uses native `CompressionStream` API (Chrome 80+, Firefox 113+, Safari 16.4+).

**`estimateCompressedReplaySize(events)`**

Estimate compressed size without actually compressing.

```typescript
const estimatedSize = estimateCompressedReplaySize(events);
console.log(`Estimated: ${(estimatedSize / 1024).toFixed(2)} KB`);
```

**`isWithinSizeLimit(blob, limitMB)`**

Check if blob is within size limit.

```typescript
if (!isWithinSizeLimit(compressed, 10)) {
  console.warn('File exceeds 10MB limit');
}
```

## 📊 Capture Modules

The SDK automatically captures:

- **📸 Screenshots** - CSP-safe full page capture (~500ms)
- **🎥 Session Replay** - Last 15-30s of user interactions (rrweb)
- **📝 Console** - All log levels with stack traces
- **🌐 Network** - fetch/XHR timing and responses
- **💻 Metadata** - Browser, OS, viewport, URL

See [Session Replay Documentation](docs/SESSION_REPLAY.md) for detailed configuration.

### Screenshot Capture

```typescript
import { ScreenshotCapture } from '@bugspotter/sdk';

const screenshotCapture = new ScreenshotCapture();
const screenshot = await screenshotCapture.capture();
// Returns: Base64 PNG data URL or 'SCREENSHOT_FAILED'
```

**Features:**

- CSP-safe using `html-to-image`
- Full page capture
- Automatic error handling
- ~500ms average capture time

### Console Capture

```typescript
import { ConsoleCapture } from '@bugspotter/sdk';

const consoleCapture = new ConsoleCapture();
const logs = consoleCapture.getLogs();
```

**Features:**

- Captures: log, warn, error, info, debug
- Stack traces for errors
- Timestamps for all entries
- Object stringification
- Circular reference handling
- Configurable max logs (default: 100)

### Network Capture

```typescript
import { NetworkCapture } from '@bugspotter/sdk';

const networkCapture = new NetworkCapture();
const requests = networkCapture.getRequests();
```

**Features:**

- Captures fetch() and XMLHttpRequest
- Request/response timing
- HTTP status codes
- Error tracking
- Singleton pattern (one instance per page)

### Metadata Capture

```typescript
import { MetadataCapture } from '@bugspotter/sdk';

const metadataCapture = new MetadataCapture();
const metadata = metadataCapture.capture();
```

**Features:**

- Browser detection (Chrome, Firefox, Safari, Edge, etc.)
- OS detection (Windows, macOS, Linux, iOS, Android)
- Viewport dimensions
- User agent string
- Current URL
- Timestamp

## 🧪 Testing

```bash
pnpm test              # All tests
pnpm test --watch      # Watch mode
pnpm test --coverage   # Coverage report
```

**345 tests** passing (unit + E2E + Playwright)

## 🛠️ Building

```bash
pnpm run dev    # Development with watch
pnpm run build  # Production build
```

Output: `dist/bugspotter.min.js` (~99 KB)

## 📈 Performance

- **Bundle**: ~99 KB minified
- **Load**: < 100ms
- **Memory**: < 15 MB (30s replay buffer)
- **Screenshot**: ~500ms
- **PII sanitization**: <10ms

## 🔒 Security

- CSP-safe (no eval, no inline scripts)
- Automatic PII detection and masking
- Input validation
- HTTPS recommended

## 🤝 Contributing

See the main [CONTRIBUTING.md](../../CONTRIBUTING.md) guide.

## 📄 License

MIT License - see [LICENSE](../../LICENSE)

---

Part of the [BugSpotter](../../README.md) project
