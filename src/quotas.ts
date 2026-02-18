/**
 * Daily Quota Tracking for External APIs
 * 
 * Tracks usage counts per API per day in SQLite.
 * Both NachoSeries (batch enrichment) and NachoReads (live lookups)
 * report usage here so they share the same daily limits.
 */

import { getDb } from './database/db.js';

// Daily limits
const DAILY_LIMITS: Record<string, number> = {
  'google-books': 900,   // Google Books: ~1000/day, leave 100 buffer
  'itunes': 5000,        // iTunes: ~20/min = ~28,800/day, but be conservative
};

/**
 * Ensure the daily_quotas table exists
 */
export function initQuotaTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_quotas (
      service TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service, date)
    )
  `);
}

/**
 * Get today's date string (UTC)
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get current usage for a service today
 */
export function getQuotaUsage(service: string): { used: number; limit: number; remaining: number; exhausted: boolean } {
  const db = getDb();
  const row = db.prepare(
    'SELECT count FROM daily_quotas WHERE service = ? AND date = ?'
  ).get(service, today()) as { count: number } | undefined;

  const used = row?.count || 0;
  const limit = DAILY_LIMITS[service] || Infinity;
  const remaining = Math.max(0, limit - used);

  return { used, limit, remaining, exhausted: remaining <= 0 };
}

/**
 * Record usage of a service (increment counter)
 * Returns false if quota is exhausted (does NOT increment in that case)
 */
export function useQuota(service: string, count = 1): boolean {
  const { exhausted } = getQuotaUsage(service);
  if (exhausted) return false;

  const db = getDb();
  const d = today();
  db.prepare(`
    INSERT INTO daily_quotas (service, date, count)
    VALUES (?, ?, ?)
    ON CONFLICT(service, date) DO UPDATE SET count = count + ?
  `).run(service, d, count, count);

  return true;
}

/**
 * Check if a service has quota remaining (without consuming any)
 */
export function hasQuota(service: string): boolean {
  return !getQuotaUsage(service).exhausted;
}

/**
 * Get all quota statuses
 */
export function getAllQuotas(): Record<string, { used: number; limit: number; remaining: number; exhausted: boolean }> {
  const result: Record<string, { used: number; limit: number; remaining: number; exhausted: boolean }> = {};
  for (const service of Object.keys(DAILY_LIMITS)) {
    result[service] = getQuotaUsage(service);
  }
  return result;
}

/**
 * Get seconds until quotas reset (next UTC midnight)
 */
export function secondsUntilReset(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
}

/**
 * Clean up old quota records (keep last 7 days)
 */
export function cleanOldQuotas(): void {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  db.prepare('DELETE FROM daily_quotas WHERE date < ?').run(cutoff.toISOString().slice(0, 10));
}
