# Using BugSpotter SDK via CDN

The BugSpotter SDK is available via CDN for easy integration without npm installation.

## 🚀 Quick Start

Add the SDK to your HTML file:

```html
<script src="https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js"></script>
<script>
  const bugSpotter = window.BugSpotter.init({
    apiKey: 'bgs_your_api_key',
    endpoint: 'https://api.bugspotter.io',
  });
</script>
```

## 📦 CDN URLs

### Production (Versioned)

**Recommended for production use** - immutable, cached for 1 year:

```html
<!-- Specific version (replace X.Y.Z with actual version) -->
<script src="https://cdn.bugspotter.io/sdk/bugspotter-X.Y.Z.min.js"></script>
```

**Example:**

```html
<script src="https://cdn.bugspotter.io/sdk/bugspotter-1.0.0.min.js"></script>
```

### Development (Latest)

**For development/testing only** - auto-updates to latest version:

```html
<script src="https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js"></script>
```

⚠️ **Warning:** The `latest` version updates automatically. Use versioned URLs in production to prevent breaking changes.

## 🔒 Subresource Integrity (SRI)

For enhanced security, use SRI hashes to verify file integrity:

```html
<script
  src="https://cdn.bugspotter.io/sdk/bugspotter-1.0.0.min.js"
  integrity="sha384-WmzRwRsJDYQTHnPU0mTuz+VqnCFn70GlSiGh6lsogKahPBEB48pTzfEEB71+uA7I"
  crossorigin="anonymous"
></script>
```

To generate SRI hash for a specific version:

```bash
curl https://cdn.bugspotter.io/sdk/bugspotter-1.0.0.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

## 📝 Complete Example

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>BugSpotter Example</title>
  </head>
  <body>
    <h1>My Application</h1>
    <button id="trigger-error">Trigger Test Error</button>

    <!-- Load BugSpotter SDK -->
    <script src="https://cdn.bugspotter.io/sdk/bugspotter-1.0.0.min.js"></script>

    <script>
      // Initialize BugSpotter
      const bugSpotter = window.BugSpotter.init({
        apiKey: 'bgs_your_api_key',
        endpoint: 'https://api.bugspotter.io',
        sessionReplay: true,
        captureConsole: true,
        captureNetwork: true,
      });

      // Test error reporting
      document.getElementById('trigger-error').addEventListener('click', () => {
        try {
          throw new Error('Test error from CDN example');
        } catch (error) {
          console.error('Caught error:', error);
        }
      });
    </script>
  </body>
</html>
```

## 🌐 Alternative CDN Options

If our primary CDN is unavailable, you can also use:

### unpkg

```html
<!-- Auto-resolves to browser field (recommended) -->
<script src="https://unpkg.com/@bugspotter/sdk@latest"></script>

<!-- Or explicit path with specific version -->
<script src="https://unpkg.com/@bugspotter/sdk@0.1.0/dist/bugspotter.min.js"></script>
```

### jsDelivr

```html
<!-- Auto-resolves to browser field (recommended) -->
<script src="https://cdn.jsdelivr.net/npm/@bugspotter/sdk@latest"></script>

<!-- Or explicit path with specific version -->
<script src="https://cdn.jsdelivr.net/npm/@bugspotter/sdk@0.1.0/dist/bugspotter.min.js"></script>
```

## 🆚 CDN vs npm

| Feature             | CDN                     | npm                             |
| ------------------- | ----------------------- | ------------------------------- |
| **Setup**           | Add `<script>` tag      | `npm install @bugspotter/sdk`   |
| **Bundle Size**     | ~99KB (gzipped: ~35KB)  | Tree-shakable, optimized        |
| **Updates**         | Change version in URL   | `npm update`                    |
| **TypeScript**      | No types                | Full TypeScript support         |
| **Best For**        | Quick prototypes, demos | Production apps, React/Vue/etc. |
| **Browser Support** | ES2017+ (95% coverage)  | Configurable via bundler        |

## 📊 Version History

Check available versions:

- [npm package page](https://www.npmjs.com/package/@bugspotter/sdk?activeTab=versions)
- [GitHub releases](https://github.com/apex-bridge/bugspotter-sdk/releases)

## ⚙️ Configuration

All configuration options from npm package work with CDN:

```javascript
window.BugSpotter.init({
  apiKey: 'bgs_your_api_key',
  endpoint: 'https://api.bugspotter.io',

  // Session replay
  sessionReplay: true,

  // Data capture
  captureConsole: true,
  captureNetwork: true,
  captureScreenshot: true,

  // Privacy
  sanitizePII: true,

  // Performance
  sampleRate: 1.0, // 100% of sessions

  // Custom data
  metadata: {
    environment: 'production',
    version: '1.0.0',
  },
});
```

See [Configuration Guide](./README.md#configuration) for all options.

## 🔧 Troubleshooting

### Script Not Loading

1. **Check browser console** for CORS or loading errors
2. **Verify URL** - ensure version exists
3. **Try alternative CDN** (unpkg or jsDelivr)

### Global Not Found

If `window.BugSpotter` is undefined:

1. **Script loaded?** Check Network tab in DevTools
2. **Correct order?** SDK must load before initialization
3. **No conflicts?** Another script may override `window.BugSpotter`

### Old Version Cached

If updates aren't showing:

1. **Hard refresh:** Ctrl+Shift+R (Cmd+Shift+R on Mac)
2. **Use versioned URL** in production (not `latest`)
3. **Check cache headers** in Network tab

## 📚 Next Steps

- [Full SDK Documentation](./README.md)
- [Framework Integration](./FRAMEWORK_INTEGRATION.md)
- [Session Replay Guide](./SESSION_REPLAY.md)
- [API Reference](../../README.md#api-reference)

## 🆘 Support

- **Issues:** [GitHub Issues](https://github.com/apex-bridge/bugspotter-sdk/issues)
- **Discussions:** [GitHub Discussions](https://github.com/apex-bridge/bugspotter-sdk/discussions)
- **Security:** security@bugspotter.io
