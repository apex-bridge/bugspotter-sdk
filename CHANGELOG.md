# Changelog

All notable changes to the BugSpotter SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in cross-navigation replay persistence: `replay.persistAcrossNavigation: true` (with a required `replay.dbName`) keeps rrweb events in IndexedDB across full-page reloads, scoped per tab. Flushes on `pagehide` and `visibilitychange` for mobile browsers that skip `pagehide`; restore is an atomic read-and-clear (#128, #133, #135, #136)
- In-widget deflection: while the user types a title, the widget probes `POST /api/v1/sdk/similar` (400 ms debounce) and shows likely duplicates; picking one submits with `deflected_to_canonical_id`. Needs a backend with the similarity endpoint (#118)

### Changed

- `engines.node` raised from `>=16.0.0` to `>=20.19.0` (#116)

## [2.1.0] - 2026-04-10

### Added

- `sampleRate` (0 to 1): fraction of sessions that activate capture; unsampled sessions get a no-op instance (#90)
- `replay.blockSelectors` and `replay.blockClass`: exclude DOM elements from session replay (#90)
- PII sanitization documentation (#91)

## [2.0.5] - 2026-03-31

### Changed

- **Breaking (shipped as a patch release):** `apiKey` moved to the top level of the `init()` config and the `auth` wrapper was removed. `endpoint` is now the API base URL; the SDK appends `/api/v1/reports` itself (#78)

```javascript
// 2.0.0
BugSpotter.init({
  endpoint: 'https://api.example.com/api/v1/reports',
  auth: { apiKey: 'bgs_your_api_key' },
});

// 2.0.5 and later
BugSpotter.init({
  endpoint: 'https://api.example.com',
  apiKey: 'bgs_your_api_key',
});
```

## [2.0.0] - 2026-03-30

### Changed

- **Breaking:** `AuthConfig` reduced to `{ apiKey: string }`. `type` and `projectId` were removed; the backend resolves the project from the API key (#69)

## [1.1.0] - 2026-03-03

### Changed

- Shared utilities (circular buffer, sanitizer, PII patterns, URL helpers) now come from the `@bugspotter/common` package instead of local copies (#54)

### Fixed

- CDN asset paths in the release and CDN deploy workflows (#42, #43)

## [1.0.0] - 2026-01-17

### Changed

- **Stable Release**: First production-ready 1.0.0 release
- Improved code quality and readability across core modules
- Enhanced test infrastructure with better Node.js and browser compatibility
- Optimized transport layer and URL validation logic

### Fixed

- E2E test compatibility issues in Playwright test suite
- Integration test Node.js Buffer API compatibility
- ESLint configuration for test environment globals

## [0.3.1] - 2026-01-13

### Added

- Node.js 22 LTS support for long-term stability
- pnpm 9.15.0 integration with improved dependency resolution
- Cross-browser E2E test suite (Chromium, Firefox, WebKit)
- Enhanced CI/CD pipeline with better error handling
- CDN deployment support in release workflow

### Changed

- Updated Firefox large DOM test timeout from 35s to 45s for better compatibility
- Improved ESLint configuration for test environments
- Better handling of runtime-injected globals in type checking

### Fixed

- Resolved pnpm version conflict between CI config and package.json
- Fixed E2E test timeouts for slower browser environments
- Corrected TypeScript type definitions for test mocks

## [0.3.0] - 2025-12-20

### Added

- **Duplicate Prevention System**: Automatic detection and prevention of duplicate bug reports
- **Backend-Controlled Replay Settings**: Dynamic replay configuration from server
- **Upload Progress Feedback**: Real-time progress indication for file uploads
- **Screenshot Proxy Endpoint**: Server-side screenshot proxy support
- **SDK Internal Log Filtering**: Automatic exclusion of SDK's own logs from reports

### Changed

- BugSpotter.init() is now async (returns Promise<BugSpotter>)
- Improved transport layer architecture
- Enhanced offline queue management

## [0.2.0] - 2025-11-21

### Added

- **Session Replay**: Recording with rrweb (configurable buffer duration up to 30s)
- **Mouse Event Sampling**: Configurable intervals for mouse tracking
- **Comprehensive E2E Tests**: Full test suite with Playwright (Chromium, Firefox, WebKit)
- **Shadow DOM Support**: Complete replay capture for Shadow DOM content
- **Type Safety Enhancements**: Improved Zod validation and type definitions

### Changed

- Refactored capture classes with better options and performance
- Improved transport and offline queue architecture
- Enhanced error handling in retry logic

### Fixed

- Content-Type header removal from presigned URL uploads (fixed 403 errors)
- rrweb CDN loading for reliable replay verification
- Release workflow prerelease tag support

## [0.1.0] - 2025-11-01

### Added

#### Core Capture Features

- **Screenshot Capture**: Full-page screenshots with CSP-safe html-to-image library
- **Console Logging**: Capture all console messages with stack traces
- **Network Tracking**: Monitor all HTTP requests (fetch/XHR) with timing
- **Browser Metadata**: Automatic detection of browser, OS, viewport
- **DOM Capture**: Complete DOM structure preservation

#### Data Protection & Privacy

- **PII Sanitization**: Automatic detection and redaction of sensitive data
  - Built-in patterns: email, phone, credit card, SSN, IIN, IP address
  - Custom regex pattern support
  - Per-element CSS selector-based exclusion
- **Content Security Policy (CSP) Compliant**: No eval, no inline scripts

#### Reliability & Performance

- **Compression**: gzip compression reduces payloads by 70-90%
- **Direct Upload**: Presigned URL uploads with 97% memory reduction vs base64
- **Offline Queue**: Store and sync bug reports when network unavailable
- **Exponential Backoff**: Intelligent retry strategy with configurable delays
- **Circular Buffering**: Efficient memory usage for long-running sessions

#### User Interface

- **Floating Widget Button**: Customizable position (corner/edge), styling, and icon
- **Bug Report Modal**: User-friendly form with validation for manual submission
- **Responsive Design**: Optimized for both desktop and mobile viewports

#### Authentication & Integration

- **Multiple Auth Types**: API Key, Bearer token, custom headers
- **Framework Agnostic**: Works with vanilla JavaScript and all major frameworks

#### Module Formats & TypeScript

- **ESM, CommonJS, UMD**: Support for all modern module systems
- **TypeScript Support**: Full type definitions with proper generic types
- **Source Maps**: Included for debugging and production support

#### Documentation

- Complete API reference with examples
- Framework integration guides (React, Vue, Angular, Next.js, Nuxt, Svelte)
- Session replay configuration and best practices
- PII sanitization customization guide
- Direct upload implementation guide
