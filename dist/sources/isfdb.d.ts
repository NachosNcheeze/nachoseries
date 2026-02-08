/**
 * ISFDB Source Fetcher
 * Internet Speculative Fiction Database - traditional HTML scraping
 *
 * ISFDB is a comprehensive database of speculative fiction.
 * Unlike LibraryThing, it uses server-side rendering so we can scrape directly.
 */
import type { SourceResult } from '../types.js';
/**
 * Main entry point - fetch series data from ISFDB
 */
export declare function fetchSeries(seriesName: string): Promise<SourceResult>;
/**
 * Browse series by genre/category
 * ISFDB has category pages we can crawl
 */
export declare function browseSeries(genre: string): Promise<string[]>;
//# sourceMappingURL=isfdb.d.ts.map