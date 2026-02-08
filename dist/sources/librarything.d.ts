/**
 * LibraryThing Source Fetcher
 * Scrapes series data from LibraryThing (no quota limit)
 * Uses FlareSolverr to bypass Cloudflare protection
 */
import type { SourceResult } from '../types.js';
/**
 * Fetch series data from LibraryThing series page
 */
export declare function fetchSeries(seriesName: string): Promise<SourceResult>;
/**
 * Search for series by genre on LibraryThing
 * Returns list of series names to fetch individually
 */
export declare function searchSeriesByGenre(genre: string, limit?: number): Promise<string[]>;
//# sourceMappingURL=librarything.d.ts.map