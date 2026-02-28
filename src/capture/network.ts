import { BaseCapture, type CaptureOptions } from './base-capture';
import { CircularBuffer } from '@bugspotter/common';

type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

// Extend XMLHttpRequest to include our custom tracking properties
interface TrackedXMLHttpRequest extends XMLHttpRequest {
  _method?: string;
  _url?: string;
  _startTime?: number;
}

export interface NetworkCaptureOptions extends CaptureOptions {
  maxRequests?: number;
  /**
   * Optional filter function to exclude URLs from capture
   * Returns true to CAPTURE the URL, false to FILTER it out
   * Note: Error responses (non-2xx status) are always captured regardless of filter result
   * Example: (url) => !url.startsWith('https://api.bugspotter.com') captures all except SDK API
   */
  filterUrls?: (url: string) => boolean;
}

export class NetworkCapture extends BaseCapture<
  NetworkRequest[],
  NetworkCaptureOptions
> {
  private buffer: CircularBuffer<NetworkRequest>;
  private filterUrls?: (url: string) => boolean;
  private originalFetch: typeof fetch;
  private originalXHR: {
    open: typeof XMLHttpRequest.prototype.open;
    send: typeof XMLHttpRequest.prototype.send;
  };
  private isIntercepting = false;

  constructor(options: NetworkCaptureOptions = {}) {
    super(options);
    const maxRequests = options.maxRequests ?? 50;
    this.buffer = new CircularBuffer<NetworkRequest>(maxRequests);
    this.filterUrls = options.filterUrls;

    this.originalFetch = window.fetch;
    this.originalXHR = {
      open: XMLHttpRequest.prototype.open,
      send: XMLHttpRequest.prototype.send,
    };
    this.interceptFetch();
    this.interceptXHR();
    this.isIntercepting = true;
  }

  capture(): NetworkRequest[] {
    return this.getRequests();
  }

  private parseFetchArgs(args: Parameters<typeof fetch>): {
    url: string;
    method: HttpMethod;
  } {
    const [input, init] = args;

    let url: string;
    let method: HttpMethod = 'GET';

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof Request) {
      url = input.url;
      method = (input.method.toUpperCase() as HttpMethod) || 'GET';
    } else {
      url = input.toString();
    }

    if (init?.method) {
      method = init.method.toUpperCase() as HttpMethod;
    }

    return { url, method };
  }

  private createNetworkRequest(
    url: string,
    method: HttpMethod,
    status: number,
    startTime: number,
    error?: string
  ): NetworkRequest {
    const request: NetworkRequest = {
      url,
      method,
      status,
      duration: Date.now() - startTime,
      timestamp: startTime,
      ...(error && { error }),
    };

    // Sanitize network data if sanitizer is enabled
    if (this.sanitizer) {
      const sanitized = this.sanitizer.sanitizeNetworkData({
        url: request.url,
        method: request.method,
        status: request.status,
        ...(request.error && { error: request.error }),
      });
      return {
        ...request,
        url: sanitized.url || request.url,
        error: sanitized.error as string | undefined,
      };
    }

    return request;
  }

  private addRequest(request: NetworkRequest): void {
    // Check if URL should be filtered
    // filterUrls returns true to CAPTURE, false to FILTER OUT
    // Exception: Always capture error responses (non-2xx) for debugging purposes
    // Rationale: Error responses from SDK API calls (4xx, 5xx) are invaluable for diagnosing
    // connectivity issues, authentication failures, rate limiting, or backend problems that
    // could affect bug report submission. Users need this visibility to troubleshoot SDK issues.
    if (this.filterUrls) {
      const shouldCapture = this.filterUrls(request.url);
      const isError = request.status < 200 || request.status >= 300;

      if (!shouldCapture && !isError) {
        return; // Filter out successful requests from filtered URLs
      }
    }

    this.buffer.add(request);
  }

  private interceptFetch() {
    const originalFetch = this.originalFetch;

    window.fetch = async (...args) => {
      const startTime = Date.now();
      let url = '';
      let method: HttpMethod = 'GET';

      try {
        ({ url, method } = this.parseFetchArgs(args));
      } catch (error) {
        this.handleError('parsing fetch arguments', error);
      }

      try {
        const response = await originalFetch(...args);
        // Only log if response is valid (handles mocked data URLs that return undefined)
        if (response && typeof response.status === 'number') {
          const request = this.createNetworkRequest(
            url,
            method,
            response.status,
            startTime
          );
          this.addRequest(request);
        }
        return response;
      } catch (error) {
        const request = this.createNetworkRequest(
          url,
          method,
          0,
          startTime,
          (error as Error).message
        );
        this.addRequest(request);
        throw error;
      }
    };
  }

  private interceptXHR() {
    const originalOpen = this.originalXHR.open;
    const originalSend = this.originalXHR.send;
    const createRequest = this.createNetworkRequest.bind(this);
    const addRequest = this.addRequest.bind(this);

    XMLHttpRequest.prototype.open = function (
      this: TrackedXMLHttpRequest,
      method: string,
      url: string | URL,
      ...args: unknown[]
    ) {
      this._method = method.toUpperCase();
      this._url = url.toString();
      this._startTime = Date.now();
      // Type assertion needed for rest params compatibility
      return originalOpen.apply(this, [method, url, ...args] as Parameters<
        typeof originalOpen
      >);
    };

    XMLHttpRequest.prototype.send = function (
      this: TrackedXMLHttpRequest,
      ...args: unknown[]
    ) {
      const onLoad = () => {
        const request = createRequest(
          this._url || '',
          (this._method as HttpMethod) || 'GET',
          this.status,
          this._startTime || Date.now()
        );
        addRequest(request);
      };

      const onError = () => {
        const request = createRequest(
          this._url || '',
          (this._method as HttpMethod) || 'GET',
          0,
          this._startTime || Date.now(),
          'XMLHttpRequest failed'
        );
        addRequest(request);
      };

      this.addEventListener('load', onLoad);
      this.addEventListener('error', onError);

      // Type assertion needed for rest params compatibility
      return originalSend.apply(this, args as Parameters<typeof originalSend>);
    };
  }

  getRequests(): NetworkRequest[] {
    return this.buffer.getAll();
  }

  clear(): void {
    this.buffer.clear();
  }

  destroy() {
    if (!this.isIntercepting) {
      return;
    }

    try {
      window.fetch = this.originalFetch;
      XMLHttpRequest.prototype.open = this.originalXHR.open;
      XMLHttpRequest.prototype.send = this.originalXHR.send;
      this.isIntercepting = false;
    } catch (error) {
      this.handleError('destroying network capture', error);
    }
  }
}

export interface NetworkRequest {
  url: string;
  method: HttpMethod;
  status: number;
  duration: number;
  timestamp: number;
  error?: string;
}
