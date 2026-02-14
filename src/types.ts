/**
 * NachoSeries Type Definitions
 */

// =============================================================================
// Source Data Types (raw data from external sources)
// =============================================================================

/**
 * Book data from any source (normalized structure)
 */
export interface SourceBook {
  title: string;
  position?: number;
  author?: string;
  yearPublished?: number;
  isbn?: string;
  sourceId?: string;        // ID in the source system
}

/**
 * Series data from any source (normalized structure)
 */
export interface SourceSeries {
  name: string;
  author?: string;
  description?: string;
  books: SourceBook[];
  sourceId?: string;        // ID in the source system
  tags?: string[];          // Tags/categories from the source
  subSeries?: Array<{ id: string; name: string }>;  // Child series (e.g., from ISFDB)
  parentSeriesId?: string;  // Parent series ID if this is a sub-series
}

/**
 * Result from a source fetch operation
 */
export interface SourceResult {
  source: 'librarything' | 'openlibrary' | 'isfdb' | 'talpa';
  series: SourceSeries | null;
  raw: unknown;             // Raw response for debugging
  error?: string;
}

// =============================================================================
// Reconciliation Types
// =============================================================================

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
  titleMatches: number;     // How many titles match
  titleMismatches: string[]; // Titles that don't match
  confidence: number;       // Overall confidence score
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
  bookPosition?: number;    // If discrepancy is about a specific book
}

// =============================================================================
// Crawl Types
// =============================================================================

/**
 * Genre mapping for different sources
 */
export const GENRE_MAPPING: Record<string, Record<string, string>> = {
  'science-fiction': {
    librarything: 'Science fiction',
    openlibrary: 'science_fiction',
    isfdb: 'SF',
  },
  'fantasy': {
    librarything: 'Fantasy',
    openlibrary: 'fantasy',
    isfdb: 'Fantasy',
  },
  'litrpg': {
    librarything: 'LitRPG',
    openlibrary: 'litrpg',  // May not exist
    isfdb: '',              // Not tracked
  },
  'post-apocalyptic': {
    librarything: 'Post-apocalyptic',
    openlibrary: 'post_apocalyptic',
    isfdb: 'Post-Apocalyptic',
  },
};

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
  duration: number;         // milliseconds
}
