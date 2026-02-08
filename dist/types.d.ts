/**
 * NachoSeries Type Definitions
 */
/**
 * Book data from any source (normalized structure)
 */
export interface SourceBook {
    title: string;
    position?: number;
    author?: string;
    yearPublished?: number;
    isbn?: string;
    sourceId?: string;
}
/**
 * Series data from any source (normalized structure)
 */
export interface SourceSeries {
    name: string;
    author?: string;
    description?: string;
    books: SourceBook[];
    sourceId?: string;
}
/**
 * Result from a source fetch operation
 */
export interface SourceResult {
    source: 'librarything' | 'openlibrary' | 'isfdb' | 'talpa';
    series: SourceSeries | null;
    raw: unknown;
    error?: string;
}
/**
 * Comparison result between two sources
 */
export interface ComparisonResult {
    seriesName: string;
    sources: string[];
    bookCountMatch: boolean;
    bookCountA: number;
    bookCountB: number;
    orderMatch: boolean;
    titleMatches: number;
    titleMismatches: string[];
    confidence: number;
    discrepancies: Discrepancy[];
}
/**
 * A specific discrepancy between sources
 */
export interface Discrepancy {
    field: 'book_count' | 'book_order' | 'title' | 'author' | 'position';
    sourceA: string;
    valueA: string | number | null;
    sourceB: string;
    valueB: string | number | null;
    bookPosition?: number;
}
/**
 * Genre mapping for different sources
 */
export declare const GENRE_MAPPING: Record<string, Record<string, string>>;
/**
 * Crawl job configuration
 */
export interface CrawlJob {
    genre: string;
    yearStart: number;
    yearEnd: number;
    maxSeries?: number;
}
/**
 * Crawl result summary
 */
export interface CrawlResult {
    genre: string;
    seriesFound: number;
    seriesAdded: number;
    seriesUpdated: number;
    errors: number;
    duration: number;
}
//# sourceMappingURL=types.d.ts.map