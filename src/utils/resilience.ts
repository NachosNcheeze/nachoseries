/**
 * NachoSeries Resilience Utilities
 * Fetch timeouts, retry logic, circuit breaker, and crash handlers.
 */

// =============================================================================
// Fetch with Timeout
// =============================================================================

/**
 * Wrapper around fetch() with an AbortController timeout.
 * Prevents hung HTTP connections from blocking the process forever.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 15000, ...fetchOptions } = options;
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// Retry with Exponential Backoff
// =============================================================================

export interface RetryOptions {
  maxRetries?: number;       // Default: 3
  baseDelay?: number;        // Default: 1000ms
  maxDelay?: number;         // Default: 30000ms
  backoffMultiplier?: number; // Default: 2
  retryOn?: (error: unknown, attempt: number) => boolean; // Custom retry predicate
}

/**
 * Retry an async function with exponential backoff.
 * Returns the result on success, throws the last error on exhaustion.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    retryOn = isRetryableError,
  } = options;
  
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt >= maxRetries || !retryOn(error, attempt)) {
        throw error;
      }
      
      const delay = Math.min(baseDelay * Math.pow(backoffMultiplier, attempt), maxDelay);
      const jitter = delay * 0.1 * Math.random(); // ±10% jitter
      const waitMs = Math.round(delay + jitter);
      
      console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  
  throw lastError;
}

/**
 * Determine if an error is retryable (transient network issues, rate limits, server errors).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout') ||
        msg.includes('enotfound') || msg.includes('epipe') || msg.includes('fetch failed') ||
        msg.includes('aborted') || msg.includes('network') || msg.includes('socket hang up')) {
      return true;
    }
  }
  // HTTP status-based (if someone wraps it)
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: number }).status;
    return status === 429 || status === 502 || status === 503 || status === 504;
  }
  return false;
}

// =============================================================================
// Circuit Breaker
// =============================================================================

export interface CircuitBreakerOptions {
  failureThreshold?: number;  // Failures before opening circuit (default: 5)
  resetTimeout?: number;      // Time in ms before trying again (default: 60000)
  name?: string;              // Identifier for logging
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly name: string;
  
  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 60000;
    this.name = options.name ?? 'unknown';
  }
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half-open';
        console.log(`[CircuitBreaker:${this.name}] Half-open — testing one request`);
      } else {
        const waitSec = Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000);
        throw new Error(`Circuit breaker OPEN for ${this.name} — retry in ${waitSec}s`);
      }
    }
    
    try {
      const result = await fn();
      // Success — reset
      if (this.state === 'half-open') {
        console.log(`[CircuitBreaker:${this.name}] Recovered — circuit closed`);
      }
      this.state = 'closed';
      this.failures = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.failureThreshold) {
        this.state = 'open';
        console.log(`[CircuitBreaker:${this.name}] OPEN — ${this.failures} consecutive failures, pausing for ${this.resetTimeout / 1000}s`);
      }
      
      throw error;
    }
  }
  
  getState(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}

// =============================================================================
// Process Crash Handlers
// =============================================================================

type CleanupFn = () => void;
const cleanupHandlers: CleanupFn[] = [];
let handlersInstalled = false;

/**
 * Register a cleanup function to run on process exit/crash.
 * Call this once per module that needs cleanup (e.g., database close).
 */
export function registerCleanup(fn: CleanupFn): void {
  cleanupHandlers.push(fn);
  
  if (handlersInstalled) return;
  handlersInstalled = true;
  
  const runCleanup = (reason: string) => {
    console.log(`\n[NachoSeries] Shutting down (${reason})...`);
    for (const handler of cleanupHandlers) {
      try { handler(); } catch { /* best effort */ }
    }
  };
  
  // Graceful signals (Docker sends SIGTERM)
  process.on('SIGTERM', () => {
    runCleanup('SIGTERM');
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    runCleanup('SIGINT');
    process.exit(0);
  });
  
  // Crash handlers (log before dying)
  process.on('uncaughtException', (error) => {
    console.error(`\n[NachoSeries] UNCAUGHT EXCEPTION:`, error);
    runCleanup('uncaughtException');
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error(`\n[NachoSeries] UNHANDLED REJECTION:`, reason);
    runCleanup('unhandledRejection');
    process.exit(1);
  });
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
