/**
 * Open Library Source Fetcher
 * Uses Open Library API for series data
 */
import type { SourceResult } from '../types.js';
interface OpenLibraryWork {
    key: string;
    title: string;
    authors?: Array<{
        author: {
            key: string;
        };
    }>;
    series?: Array<{
        name: string;
        position?: string;
    }>;
    first_publish_date?: string;
    covers?: number[];
}
/**
 * Fetch series data from Open Library
 * Note: Open Library doesn't have a direct series API, so we search and aggregate
 */
export declare function fetchSeries(seriesName: string): Promise<SourceResult>;
/**
 * Fetch detailed work info by Open Library key
 */
export declare function fetchWork(workKey: string): Promise<OpenLibraryWork | null>;
/**
 * Search for series in a genre
 */
export declare function searchSeriesByGenre(genre: string, limit?: number): Promise<string[]>;
export {};
//# sourceMappingURL=openLibrary.d.ts.map