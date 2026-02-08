/**
 * NachoSeries Database Operations
 * SQLite database for series data
 */
import Database from 'better-sqlite3';
/**
 * Initialize database connection and schema
 */
export declare function initDatabase(): Database.Database;
/**
 * Get database instance
 */
export declare function getDb(): Database.Database;
/**
 * Close database connection
 */
export declare function closeDatabase(): void;
export interface SeriesRecord {
    id: string;
    name: string;
    name_normalized: string;
    author: string | null;
    author_normalized: string | null;
    genre: string | null;
    total_books: number | null;
    year_start: number | null;
    year_end: number | null;
    description: string | null;
    confidence: number;
    verified: boolean;
    last_verified: string | null;
    librarything_id: string | null;
    openlibrary_key: string | null;
    isfdb_id: string | null;
    created_at: string;
    updated_at: string;
}
export interface SeriesBookRecord {
    id: string;
    series_id: string;
    position: number | null;
    title: string;
    title_normalized: string;
    author: string | null;
    year_published: number | null;
    ebook_known: boolean;
    audiobook_known: boolean;
    openlibrary_key: string | null;
    librarything_id: string | null;
    audible_asin: string | null;
    isbn: string | null;
    confidence: number;
    created_at: string;
    updated_at: string;
}
/**
 * Normalize text for matching (lowercase, remove punctuation)
 */
export declare function normalizeText(text: string): string;
/**
 * Insert or update a series
 */
export declare function upsertSeries(series: Partial<SeriesRecord> & {
    name: string;
}): string;
/**
 * Find series by name (fuzzy match)
 */
export declare function findSeriesByName(name: string): SeriesRecord | null;
/**
 * Get all series for a genre
 */
export declare function getSeriesByGenre(genre: string, limit?: number): SeriesRecord[];
/**
 * Get series needing verification
 */
export declare function getSeriesNeedingVerification(limit?: number): SeriesRecord[];
/**
 * Insert or update a book in a series
 */
export declare function upsertSeriesBook(book: Partial<SeriesBookRecord> & {
    series_id: string;
    title: string;
}): string;
/**
 * Get all books in a series
 */
export declare function getBooksInSeries(seriesId: string): SeriesBookRecord[];
/**
 * Store raw source data for a series
 */
export declare function storeSourceData(seriesId: string, source: string, rawData: unknown, bookCount: number): void;
export interface DatabaseStats {
    totalSeries: number;
    totalBooks: number;
    verifiedSeries: number;
    seriesByGenre: Record<string, number>;
    avgConfidence: number;
}
/**
 * Get database statistics
 */
export declare function getStats(): DatabaseStats;
//# sourceMappingURL=db.d.ts.map