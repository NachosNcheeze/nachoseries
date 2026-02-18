/**
 * Circuit Breaker for Open Library
 * 
 * Distinguishes between "no data" (normal) and "service down" (outage):
 * - HTTP 5xx, timeouts, connection errors → counted as failures
 * - HTTP 200 with empty results, 404 → NOT failures (just no data)
 * 
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Service is down, all requests short-circuit immediately
 * - HALF_OPEN: Probe mode, one request allowed to test recovery
 * 
 * Transitions:
 * - CLOSED → OPEN: After N consecutive infrastructure failures
 * - OPEN → HALF_OPEN: After cooldown period expires
 * - HALF_OPEN → CLOSED: Probe request succeeds
 * - HALF_OPEN → OPEN: Probe request fails (with increased cooldown)
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Name for logging */
  name: string;
  /** Number of consecutive failures before opening (default: 5) */
  failureThreshold?: number;
  /** Initial cooldown in ms before half-open probe (default: 30s) */
  cooldownMs?: number;
  /** Max cooldown in ms (default: 5 min) */
  maxCooldownMs?: number;
  /** Cooldown multiplier after each failed probe (default: 2) */
  cooldownMultiplier?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private currentCooldownMs: number;
  private totalTrips = 0;

  private name: string;
  private failureThreshold: number;
  private baseCooldownMs: number;
  private maxCooldownMs: number;
  private cooldownMultiplier: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseCooldownMs = options.cooldownMs ?? 30_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 300_000;
    this.cooldownMultiplier = options.cooldownMultiplier ?? 2;
    this.currentCooldownMs = this.baseCooldownMs;
  }

  /**
   * Check if requests should be allowed through.
   * Returns true if the circuit allows the request.
   * Returns false if the circuit is OPEN (service is down).
   */
  allowRequest(): boolean {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      // Check if cooldown has elapsed
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.currentCooldownMs) {
        this.state = 'HALF_OPEN';
        console.log(`[CircuitBreaker:${this.name}] → HALF_OPEN (probing after ${Math.round(this.currentCooldownMs / 1000)}s cooldown)`);
        return true; // Allow one probe request
      }
      return false; // Still in cooldown
    }

    // HALF_OPEN: allow one probe
    return true;
  }

  /**
   * Report a successful request.
   * Call this when the API returns a valid response (even if no data found).
   */
  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker:${this.name}] → CLOSED (probe succeeded, service recovered)`);
      this.currentCooldownMs = this.baseCooldownMs; // Reset cooldown
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
  }

  /**
   * Report an infrastructure failure (5xx, timeout, connection error).
   * Do NOT call this for empty results or 404s — those are "no data", not failures.
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Probe failed — reopen with increased cooldown
      this.state = 'OPEN';
      this.currentCooldownMs = Math.min(
        this.currentCooldownMs * this.cooldownMultiplier,
        this.maxCooldownMs
      );
      console.log(`[CircuitBreaker:${this.name}] → OPEN (probe failed, cooldown ${Math.round(this.currentCooldownMs / 1000)}s)`);
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.totalTrips++;
      console.log(
        `[CircuitBreaker:${this.name}] → OPEN (${this.consecutiveFailures} consecutive failures, ` +
        `cooldown ${Math.round(this.currentCooldownMs / 1000)}s, trip #${this.totalTrips})`
      );
    }
  }

  /**
   * Get current state info (for API/logging)
   */
  getStatus(): {
    state: CircuitState;
    consecutiveFailures: number;
    cooldownMs: number;
    cooldownRemainingMs: number;
    totalTrips: number;
  } {
    let cooldownRemainingMs = 0;
    if (this.state === 'OPEN') {
      cooldownRemainingMs = Math.max(0, this.currentCooldownMs - (Date.now() - this.lastFailureTime));
    }

    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      cooldownMs: this.currentCooldownMs,
      cooldownRemainingMs,
      totalTrips: this.totalTrips,
    };
  }

  /**
   * Check if an error is an infrastructure failure (vs. a data miss).
   * Static helper to standardize what counts as a "failure".
   */
  static isInfraFailure(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('epipe') ||
        msg.includes('enetunreach') ||
        msg.includes('enotfound') ||
        msg.includes('aborted') ||
        msg.includes('fetch failed') ||
        msg.includes('socket hang up')
      );
    }
    return false;
  }

  static isHttpFailure(status: number): boolean {
    return status >= 500 || status === 429;
  }
}

// Singleton circuit breaker for Open Library
export const olCircuitBreaker = new CircuitBreaker({
  name: 'OpenLibrary',
  failureThreshold: 5,
  cooldownMs: 30_000,        // Start at 30s
  maxCooldownMs: 300_000,    // Max 5 min
  cooldownMultiplier: 2,     // 30s → 60s → 120s → 240s → 300s
});
