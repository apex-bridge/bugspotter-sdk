# BugSpotter SDK - Framework Integration Guide

Complete guide for integrating BugSpotter SDK into React, Vue, Angular, and other JavaScript frameworks.

## Table of Contents

- [React Integration](#react-integration)
- [Vue Integration](#vue-integration)
- [Angular Integration](#angular-integration)
- [Next.js Integration](#nextjs-integration)
- [Nuxt Integration](#nuxt-integration)
- [Svelte Integration](#svelte-integration)
- [Vanilla JavaScript](#vanilla-javascript)
- [TypeScript Support](#typescript-support)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## React Integration

### Installation

```bash
# Install the SDK
npm install @bugspotter/sdk
# or
yarn add @bugspotter/sdk
# or
pnpm add @bugspotter/sdk
```

### Basic Setup with Hook

Create a custom hook for BugSpotter:

```typescript
// hooks/useBugSpotter.ts
import { useEffect, useRef } from 'react';
import BugSpotter from '@bugspotter/sdk';

export function useBugSpotter() {
  const bugSpotterRef = useRef<any>(null);

  useEffect(() => {
    // Initialize BugSpotter on mount
    bugSpotterRef.current = BugSpotter.init({
      apiKey: process.env.REACT_APP_BUGSPOTTER_API_KEY,
      endpoint: process.env.REACT_APP_BUGSPOTTER_ENDPOINT,
      showWidget: true,
      widgetOptions: {
        position: 'bottom-right',
        icon: '🐛',
      },
      sanitize: {
        enabled: true,
        patterns: ['email', 'phone', 'creditcard'],
      },
      replay: {
        enabled: true,
        duration: 30,
      },
    });

    // Cleanup on unmount
    return () => {
      if (bugSpotterRef.current) {
        bugSpotterRef.current.destroy();
      }
    };
  }, []);

  return bugSpotterRef.current;
}
```

### Usage in App Component

```typescript
// App.tsx
import React from 'react';
import { useBugSpotter } from './hooks/useBugSpotter';

function App() {
  const bugSpotter = useBugSpotter();

  return (
    <div className="App">
      <h1>My Application</h1>
      {/* Your app content */}
    </div>
  );
}

export default App;
```

### Context Provider Pattern

For more control, create a context:

```typescript
// context/BugSpotterContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import BugSpotter from '@bugspotter/sdk';

interface BugSpotterContextType {
  bugSpotter: any | null;
  reportBug: () => Promise<void>;
  isInitialized: boolean;
}

const BugSpotterContext = createContext<BugSpotterContextType>({
  bugSpotter: null,
  reportBug: async () => {},
  isInitialized: false,
});

export function BugSpotterProvider({ children }: { children: React.ReactNode }) {
  const [bugSpotter, setBugSpotter] = useState<any>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const instance = BugSpotter.init({
      apiKey: process.env.REACT_APP_BUGSPOTTER_API_KEY,
      endpoint: process.env.REACT_APP_BUGSPOTTER_ENDPOINT,
      showWidget: true,
    });

    setBugSpotter(instance);
    setIsInitialized(true);

    return () => {
      instance.destroy();
    };
  }, []);

  const reportBug = async () => {
    if (bugSpotter) {
      const report = await bugSpotter.capture();
      console.log('Bug report captured:', report);
    }
  };

  return (
    <BugSpotterContext.Provider value={{ bugSpotter, reportBug, isInitialized }}>
      {children}
    </BugSpotterContext.Provider>
  );
}

export function useBugSpotterContext() {
  return useContext(BugSpotterContext);
}
```

```typescript
// index.tsx
import { BugSpotterProvider } from './context/BugSpotterContext';

ReactDOM.render(
  <BugSpotterProvider>
    <App />
  </BugSpotterProvider>,
  document.getElementById('root')
);
```

### Manual Bug Reporting Component

```typescript
// components/BugReportButton.tsx
import React from 'react';
import { useBugSpotterContext } from '../context/BugSpotterContext';

export function BugReportButton() {
  const { reportBug, isInitialized } = useBugSpotterContext();

  const handleClick = async () => {
    try {
      await reportBug();
      alert('Bug report submitted!');
    } catch (error) {
      console.error('Failed to submit bug report:', error);
    }
  };

  if (!isInitialized) return null;

  return (
    <button onClick={handleClick} className="bug-report-btn">
      Report Bug
    </button>
  );
}
```

### Error Boundary Integration

```typescript
// components/ErrorBoundary.tsx
import React, { Component, ErrorInfo, ReactNode } from 'react';
import BugSpotter from '@bugspotter/sdk';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  private bugSpotter: any;

  constructor(props: Props) {
    super(props);
    this.bugSpotter = BugSpotter.init({
      apiKey: process.env.REACT_APP_BUGSPOTTER_API_KEY,
      endpoint: process.env.REACT_APP_BUGSPOTTER_ENDPOINT,
      showWidget: false, // Hide widget in error boundary
    });
  }

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public async componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);

    // Automatically capture and report the error
    try {
      const report = await this.bugSpotter.capture();
      // Send report with error details
      console.log('Error report captured:', report);
    } catch (captureError) {
      console.error('Failed to capture error report:', captureError);
    }
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="error-fallback">
          <h1>Something went wrong</h1>
          <p>The error has been automatically reported.</p>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
```

---

## Vue Integration

### Vue 3 Composition API

```typescript
// composables/useBugSpotter.ts
import { onMounted, onUnmounted, ref } from 'vue';
import BugSpotter from '@bugspotter/sdk';

export function useBugSpotter() {
  const bugSpotter = ref<any>(null);
  const isInitialized = ref(false);

  onMounted(() => {
    bugSpotter.value = BugSpotter.init({
      apiKey: import.meta.env.VITE_BUGSPOTTER_API_KEY,
      endpoint: import.meta.env.VITE_BUGSPOTTER_ENDPOINT,
      showWidget: true,
      widgetOptions: {
        position: 'bottom-right',
        icon: '🐛',
      },
    });
    isInitialized.value = true;
  });

  onUnmounted(() => {
    if (bugSpotter.value) {
      bugSpotter.value.destroy();
    }
  });

  const reportBug = async () => {
    if (bugSpotter.value) {
      return await bugSpotter.value.capture();
    }
  };

  return {
    bugSpotter,
    isInitialized,
    reportBug,
  };
}
```

### Usage in Component

```vue
<!-- App.vue -->
<script setup lang="ts">
import { useBugSpotter } from './composables/useBugSpotter';

const { isInitialized, reportBug } = useBugSpotter();

const handleReportBug = async () => {
  try {
    const report = await reportBug();
    console.log('Bug reported:', report);
  } catch (error) {
    console.error('Failed to report bug:', error);
  }
};
</script>

<template>
  <div id="app">
    <h1>My Vue Application</h1>
    <button v-if="isInitialized" @click="handleReportBug">Report Bug</button>
  </div>
</template>
```

### Vue 3 Plugin

```typescript
// plugins/bugspotter.ts
import type { App } from 'vue';
import BugSpotter from '@bugspotter/sdk';

export default {
  install: (app: App, options: any) => {
    const bugSpotter = BugSpotter.init({
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      showWidget: true,
      ...options,
    });

    // Make available globally
    app.config.globalProperties.$bugSpotter = bugSpotter;

    // Provide/inject pattern
    app.provide('bugSpotter', bugSpotter);

    // Global error handler
    app.config.errorHandler = async (err, instance, info) => {
      console.error('Global error:', err, info);
      try {
        await bugSpotter.capture();
      } catch (captureError) {
        console.error('Failed to capture error:', captureError);
      }
    };
  },
};
```

```typescript
// main.ts
import { createApp } from 'vue';
import App from './App.vue';
import BugSpotterPlugin from './plugins/bugspotter';

const app = createApp(App);

app.use(BugSpotterPlugin, {
  apiKey: import.meta.env.VITE_BUGSPOTTER_API_KEY,
  endpoint: import.meta.env.VITE_BUGSPOTTER_ENDPOINT,
});

app.mount('#app');
```

### Vue 2 (Options API)

```javascript
// main.js
import Vue from 'vue';
import App from './App.vue';
import BugSpotter from '@bugspotter/sdk';

// Initialize BugSpotter
const bugSpotter = BugSpotter.init({
  apiKey: process.env.VUE_APP_BUGSPOTTER_API_KEY,
  endpoint: process.env.VUE_APP_BUGSPOTTER_ENDPOINT,
  showWidget: true,
});

// Make available globally
Vue.prototype.$bugSpotter = bugSpotter;

// Global error handler
Vue.config.errorHandler = async (err, vm, info) => {
  console.error('Global error:', err, info);
  try {
    await bugSpotter.capture();
  } catch (captureError) {
    console.error('Failed to capture error:', captureError);
  }
};

new Vue({
  render: (h) => h(App),
}).$mount('#app');
```

---

## Angular Integration

### Service Setup

```typescript
// services/bugspotter.service.ts
import { Injectable, OnDestroy } from '@angular/core';
import BugSpotter from '@bugspotter/sdk';
import { environment } from '../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class BugSpotterService implements OnDestroy {
  private bugSpotter: any;
  private initialized = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    this.bugSpotter = BugSpotter.init({
      apiKey: environment.bugspotterApiKey,
      endpoint: environment.bugspotterEndpoint,
      showWidget: true,
      widgetOptions: {
        position: 'bottom-right',
        icon: '🐛',
      },
      sanitize: {
        enabled: true,
        patterns: ['email', 'phone', 'creditcard'],
      },
    });
    this.initialized = true;
  }

  async capture(): Promise<any> {
    if (!this.initialized) {
      throw new Error('BugSpotter not initialized');
    }
    return await this.bugSpotter.capture();
  }

  getConfig() {
    return this.bugSpotter?.getConfig();
  }

  ngOnDestroy(): void {
    if (this.bugSpotter) {
      this.bugSpotter.destroy();
    }
  }
}
```

### Environment Configuration

```typescript
// environments/environment.ts
export const environment = {
  production: false,
  bugspotterApiKey: 'bgs_your_dev_api_key',
  bugspotterEndpoint: 'http://localhost:3000',
};

// environments/environment.prod.ts
export const environment = {
  production: true,
  bugspotterApiKey: 'bgs_your_prod_api_key',
  bugspotterEndpoint: 'https://api.bugspotter.com',
};
```

### Global Error Handler

```typescript
// app.module.ts
import { ErrorHandler, NgModule } from '@angular/core';
import { BugSpotterService } from './services/bugspotter.service';

class GlobalErrorHandler implements ErrorHandler {
  constructor(private bugSpotter: BugSpotterService) {}

  async handleError(error: Error): Promise<void> {
    console.error('Global error:', error);
    try {
      await this.bugSpotter.capture();
    } catch (captureError) {
      console.error('Failed to capture error:', captureError);
    }
  }
}

@NgModule({
  providers: [
    {
      provide: ErrorHandler,
      useClass: GlobalErrorHandler,
      deps: [BugSpotterService],
    },
  ],
})
export class AppModule {}
```

### Component Usage

```typescript
// components/bug-report-button.component.ts
import { Component } from '@angular/core';
import { BugSpotterService } from '../services/bugspotter.service';

@Component({
  selector: 'app-bug-report-button',
  template: ` <button (click)="reportBug()" class="bug-report-btn">Report Bug</button> `,
})
export class BugReportButtonComponent {
  constructor(private bugSpotter: BugSpotterService) {}

  async reportBug(): Promise<void> {
    try {
      const report = await this.bugSpotter.capture();
      console.log('Bug report captured:', report);
      alert('Bug report submitted!');
    } catch (error) {
      console.error('Failed to submit bug report:', error);
    }
  }
}
```

---

## Next.js Integration

### App Router (Next.js 13+)

```typescript
// app/providers.tsx
'use client';

import { useEffect, useRef } from 'react';
import BugSpotter from '@bugspotter/sdk';

export function BugSpotterProvider({ children }: { children: React.ReactNode }) {
  const bugSpotterRef = useRef<any>(null);

  useEffect(() => {
    // Only initialize on client side
    if (typeof window !== 'undefined' && !bugSpotterRef.current) {
      bugSpotterRef.current = BugSpotter.init({
        apiKey: process.env.NEXT_PUBLIC_BUGSPOTTER_API_KEY,
        endpoint: process.env.NEXT_PUBLIC_BUGSPOTTER_ENDPOINT,
        showWidget: true,
      });
    }

    return () => {
      if (bugSpotterRef.current) {
        bugSpotterRef.current.destroy();
      }
    };
  }, []);

  return <>{children}</>;
}
```

```typescript
// app/layout.tsx
import { BugSpotterProvider } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BugSpotterProvider>{children}</BugSpotterProvider>
      </body>
    </html>
  );
}
```

### Pages Router (Next.js 12 and below)

```typescript
// pages/_app.tsx
import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import BugSpotter from '@bugspotter/sdk';

function MyApp({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Initialize BugSpotter on client side only
    const bugSpotter = BugSpotter.init({
      apiKey: process.env.NEXT_PUBLIC_BUGSPOTTER_API_KEY,
      endpoint: process.env.NEXT_PUBLIC_BUGSPOTTER_ENDPOINT,
      showWidget: true,
    });

    return () => {
      bugSpotter.destroy();
    };
  }, []);

  return <Component {...pageProps} />;
}

export default MyApp;
```

### Environment Variables

```bash
# .env.local
NEXT_PUBLIC_BUGSPOTTER_API_KEY=bgs_your_api_key
NEXT_PUBLIC_BUGSPOTTER_ENDPOINT=https://api.bugspotter.com
```

---

## Nuxt Integration

### Nuxt 3

```typescript
// plugins/bugspotter.client.ts
import BugSpotter from '@bugspotter/sdk';

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();

  const bugSpotter = BugSpotter.init({
    apiKey: config.public.bugspotterApiKey,
    endpoint: config.public.bugspotterEndpoint,
    showWidget: true,
  });

  return {
    provide: {
      bugSpotter,
    },
  };
});
```

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      bugspotterApiKey: process.env.NUXT_PUBLIC_BUGSPOTTER_API_KEY,
      bugspotterEndpoint: process.env.NUXT_PUBLIC_BUGSPOTTER_ENDPOINT,
    },
  },
});
```

### Usage in Component

```vue
<script setup lang="ts">
const { $bugSpotter } = useNuxtApp();

const reportBug = async () => {
  const report = await $bugSpotter.capture();
  console.log('Bug reported:', report);
};
</script>

<template>
  <div>
    <button @click="reportBug">Report Bug</button>
  </div>
</template>
```

---

## Svelte Integration

### SvelteKit

```typescript
// src/hooks.client.ts
import BugSpotter from '@bugspotter/sdk';
import { browser } from '$app/environment';
import { PUBLIC_BUGSPOTTER_API_KEY, PUBLIC_BUGSPOTTER_ENDPOINT } from '$env/static/public';

if (browser) {
  BugSpotter.init({
    apiKey: PUBLIC_BUGSPOTTER_API_KEY,
    endpoint: PUBLIC_BUGSPOTTER_ENDPOINT,
    showWidget: true,
  });
}
```

### Svelte Store

```typescript
// stores/bugspotter.ts
import { writable } from 'svelte/store';
import BugSpotter from '@bugspotter/sdk';
import { browser } from '$app/environment';

function createBugSpotterStore() {
  const { subscribe, set } = writable<any>(null);

  if (browser) {
    const instance = BugSpotter.init({
      apiKey: import.meta.env.VITE_BUGSPOTTER_API_KEY,
      endpoint: import.meta.env.VITE_BUGSPOTTER_ENDPOINT,
      showWidget: true,
    });
    set(instance);
  }

  return {
    subscribe,
    capture: async () => {
      let instance: any;
      subscribe((value) => (instance = value))();
      if (instance) {
        return await instance.capture();
      }
    },
  };
}

export const bugSpotter = createBugSpotterStore();
```

---

## Vanilla JavaScript

### Script Tag (CDN)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>My App</title>
  </head>
  <body>
    <h1>My Application</h1>
    <button id="report-bug">Report Bug</button>

    <!-- Load BugSpotter SDK from CDN -->
    <script src="https://cdn.bugspotter.io/sdk/bugspotter-latest.min.js"></script>
    <script>
      // Initialize BugSpotter
      var bugSpotter = BugSpotter.init({
        apiKey: 'bgs_your_api_key',
        endpoint: 'https://api.bugspotter.com',
        showWidget: true,
      });

      // Manual bug reporting
      document.getElementById('report-bug').addEventListener('click', async function () {
        try {
          var report = await bugSpotter.capture();
          console.log('Bug reported:', report);
          alert('Bug report submitted!');
        } catch (error) {
          console.error('Failed to report bug:', error);
        }
      });
    </script>
  </body>
</html>
```

### ES Modules

```javascript
// app.js
import BugSpotter from '@bugspotter/sdk';

// Initialize
const bugSpotter = BugSpotter.init({
  apiKey: 'bgs_your_api_key',
  endpoint: 'https://api.bugspotter.com',
  showWidget: true,
  widgetOptions: {
    position: 'bottom-right',
    icon: '🐛',
  },
});

// Manual reporting
document.getElementById('report-bug').addEventListener('click', async () => {
  const report = await bugSpotter.capture();
  console.log('Report captured:', report);
});
```

---

## TypeScript Support

### Type Definitions

```typescript
// types/bugspotter.d.ts
declare module '@bugspotter/sdk' {
  export interface BugSpotterConfig {
    apiKey?: string;
    endpoint?: string;
    showWidget?: boolean;
    widgetOptions?: {
      position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
      icon?: string;
      backgroundColor?: string;
      size?: number;
    };
    replay?: {
      enabled?: boolean;
      duration?: number;
      sampling?: {
        mousemove?: number;
        scroll?: number;
      };
    };
    sanitize?: {
      enabled?: boolean;
      patterns?: string[];
      customPatterns?: Array<{ name: string; regex: RegExp }>;
      excludeSelectors?: string[];
    };
  }

  export interface BugReport {
    screenshot: string;
    console: ConsoleLog[];
    network: NetworkRequest[];
    metadata: BrowserMetadata;
    replay: any[];
  }

  export interface ConsoleLog {
    level: string;
    message: string;
    timestamp: number;
    stack?: string;
  }

  export interface NetworkRequest {
    url: string;
    method: string;
    status: number;
    duration: number;
    timestamp: number;
    error?: string;
  }

  export interface BrowserMetadata {
    userAgent: string;
    viewport: { width: number; height: number };
    browser: string;
    os: string;
    url: string;
    timestamp: number;
  }

  export interface BugSpotterInstance {
    capture(): Promise<BugReport>;
    getConfig(): Readonly<BugSpotterConfig>;
    destroy(): void;
  }

  export default class BugSpotter {
    static init(config: BugSpotterConfig): BugSpotterInstance;
  }
}
```

### Usage with Types

```typescript
import BugSpotter, { BugSpotterConfig, BugReport } from '@bugspotter/sdk';

const config: BugSpotterConfig = {
  apiKey: process.env.BUGSPOTTER_API_KEY,
  endpoint: process.env.BUGSPOTTER_ENDPOINT,
  showWidget: true,
};

const bugSpotter = BugSpotter.init(config);

async function captureReport(): Promise<BugReport> {
  return await bugSpotter.capture();
}
```

---

## Best Practices

### 1. Environment-Based Configuration

Use different configurations for development and production:

```typescript
const config = {
  apiKey:
    process.env.NODE_ENV === 'production'
      ? process.env.PROD_BUGSPOTTER_API_KEY
      : process.env.DEV_BUGSPOTTER_API_KEY,
  endpoint:
    process.env.NODE_ENV === 'production' ? 'https://api.bugspotter.com' : 'http://localhost:3000',
  showWidget: process.env.NODE_ENV === 'development', // Only in dev
};
```

### 2. Lazy Loading

Load BugSpotter only when needed to reduce initial bundle size:

```typescript
// Lazy load BugSpotter
const loadBugSpotter = async () => {
  const BugSpotter = await import('@bugspotter/sdk');
  return BugSpotter.default.init({
    apiKey: process.env.BUGSPOTTER_API_KEY,
    endpoint: process.env.BUGSPOTTER_ENDPOINT,
  });
};

// Use when needed
button.addEventListener('click', async () => {
  const bugSpotter = await loadBugSpotter();
  await bugSpotter.capture();
});
```

### 3. Error Handling

Always wrap BugSpotter calls in try-catch:

```typescript
async function reportBug() {
  try {
    const report = await bugSpotter.capture();
    console.log('Report captured:', report);
  } catch (error) {
    console.error('Failed to capture report:', error);
    // Fallback: Show user a message or use alternative error reporting
  }
}
```

### 4. PII Sanitization

Enable PII sanitization in production:

```typescript
BugSpotter.init({
  sanitize: {
    enabled: true,
    patterns: ['email', 'phone', 'creditcard', 'ssn'],
    excludeSelectors: ['.public-data'],
  },
});
```

### 5. Performance Optimization

Configure session replay sampling for better performance:

```typescript
BugSpotter.init({
  replay: {
    enabled: true,
    duration: 15, // Shorter buffer for less memory usage
    sampling: {
      mousemove: 100, // Higher = less CPU usage
      scroll: 200,
    },
  },
});
```

### 6. Testing

Mock BugSpotter in tests:

```typescript
// __mocks__/@bugspotter/sdk.ts
export default {
  init: jest.fn(() => ({
    capture: jest.fn(() => Promise.resolve({})),
    destroy: jest.fn(),
    getConfig: jest.fn(() => ({})),
  })),
};
```

---

## Troubleshooting

### Widget Not Appearing

**Issue**: BugSpotter widget doesn't show up.

**Solutions**:

- Ensure `showWidget: true` in config
- Check CSS z-index conflicts
- Verify BugSpotter is initialized after DOM is ready
- Check browser console for errors

### CSP (Content Security Policy) Errors

**Issue**: Content Security Policy blocks BugSpotter.

**Solution**: Add to your CSP headers:

```
img-src 'self' data: blob:;
script-src 'self';
```

### Memory Issues

**Issue**: High memory usage with session replay.

**Solutions**:

- Reduce replay duration: `replay: { duration: 15 }`
- Increase sampling intervals: `sampling: { mousemove: 100 }`
- Disable replay if not needed: `replay: { enabled: false }`

### Build Errors

**Issue**: Module not found or build failures.

**Solutions**:

- Ensure package is installed: `npm install @bugspotter/sdk`
- Check import path: `import BugSpotter from '@bugspotter/sdk'`
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`

### SSR/SSG Issues (Next.js, Nuxt)

**Issue**: "window is not defined" or similar SSR errors.

**Solutions**:

- Use `.client` suffix for plugins (Nuxt)
- Check `typeof window !== 'undefined'` before initializing
- Use `useEffect` or `onMounted` hooks
- Mark components as client-only

### TypeScript Errors

**Issue**: Type errors or missing types.

**Solutions**:

- Add type definitions file (see TypeScript Support section)
- Use `@ts-ignore` as temporary fix
- Check if types are exported from package

---

## Additional Resources

- [SDK README](../README.md) - Complete SDK documentation
- [Session Replay Guide](./SESSION_REPLAY.md) - Session replay configuration
- [API Documentation](../../../API_DOCUMENTATION.md) - Backend API reference
- [Demo App](../../../apps/demo/README.md) - Working example

---

**Need Help?** Open an issue on [GitHub](https://github.com/apex-bridge/bugspotter-sdk) or contact support.
