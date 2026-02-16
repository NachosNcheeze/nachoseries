/**
 * Google Books API Integration
 * 
 * Used for:
 * 1. Enriching series with descriptions (Layer 3 of Combo 1)
 * 2. Cross-validating book data against a second source
 * 3. Fetching ISBNs for retailer linking
 * 
 * Google Books API is free, has generous rate limits, and requires no auth
 * for basic queries. Returns descriptions, ISBNs, cover URLs, and metadata.
 */

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes';
const USER_AGENT = 'NachoSeries/0.1.0 (Book Enrichment)';
const FETCH_TIMEOUT = 10000; // 10 seconds

import { fetchWithTimeout, withRetry } from '../utils/resilience.js';

// Rate limiter (generous, but be respectful)
let lastRequest = 0;
const MIN_INTERVAL = 200; // 200ms between requests (5 req/sec)

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

// Types for Google Books API response
interface GoogleBooksVolume {
  id: string;
  volumeInfo: {
    title: string;
    subtitle?: string;
    authors?: string[];
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{
      type: 'ISBN_10' | 'ISBN_13' | 'OTHER';
      identifier: string;
    }>;
    categories?: string[];
    averageRating?: number;
    ratingsCount?: number;
    imageLinks?: {
      smallThumbnail?: string;
      thumbnail?: string;
    };
    pageCount?: number;
    language?: string;
    seriesInfo?: {
      shortSeriesBookTitle?: string;
      bookDisplayNumber?: string;
      volumeSeries?: Array<{
        seriesId: string;
        seriesBookType: string;
        orderNumber: number;
      }>;
    };
  };
}

interface GoogleBooksSearchResult {
  totalItems: number;
  items?: GoogleBooksVolume[];
}

export interface BookEnrichment {
  description?: string;
  isbn10?: string;
  isbn13?: string;
  categories?: string[];
  pageCount?: number;
  averageRating?: number;
  ratingsCount?: number;
  coverUrl?: string;
  publishedDate?: string;
  language?: string;
  googleBooksId?: string;
}

/**
 * Search Google Books by title and optional author
 * Returns the best matching volume
 */
export async function searchBook(
  title: string,
  author?: string
): Promise<BookEnrichment | null> {
  await rateLimit();
  
  try {
    // Build search query
    let query = `intitle:${encodeURIComponent(title)}`;
    if (author) {
      query += `+inauthor:${encodeURIComponent(author)}`;
    }
    
    const url = `${BASE_URL}?q=${query}&maxResults=5&printType=books&langRestrict=en`;
    
    const response = await withRetry(
      () => fetchWithTimeout(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: FETCH_TIMEOUT,
      }),
      {
        maxRetries: 3,
        baseDelay: 2000,
        retryOn: (error) => {
          // Retry on network errors and 429s
          if (error instanceof Error && error.message.includes('429')) return true;
          if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            return msg.includes('econnrefused') || msg.includes('econnreset') ||
                   msg.includes('etimedout') || msg.includes('aborted') || msg.includes('fetch failed');
          }
          return false;
        },
      }
    );
    
    if (!response.ok) {
      if (response.status === 429) {
        console.warn('[GoogleBooks] Rate limited, waiting 10s...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        return null;
      }
      console.error(`[GoogleBooks] API error: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as GoogleBooksSearchResult;
    
    if (!data.items || data.items.length === 0) {
      return null;
    }
    
    // Find best match (prefer one with description and matching title)
    const normalizedTitle = title.toLowerCase().replace(/[^\w\s]/g, '');
    
    let bestMatch: GoogleBooksVolume | null = null;
    let bestScore = 0;
    
    for (const volume of data.items) {
      const vi = volume.volumeInfo;
      let score = 0;
      
      // Title similarity
      const volTitle = vi.title.toLowerCase().replace(/[^\w\s]/g, '');
      if (volTitle === normalizedTitle) {
        score += 10;
      } else if (volTitle.includes(normalizedTitle) || normalizedTitle.includes(volTitle)) {
        score += 5;
      }
      
      // Has description (very important for enrichment)
      if (vi.description && vi.description.length > 50) {
        score += 5;
      }
      
      // Has ISBN
      if (vi.industryIdentifiers?.some(id => id.type === 'ISBN_13' || id.type === 'ISBN_10')) {
        score += 2;
      }
      
      // Must be English — reject non-English results entirely
      // (langRestrict=en on the API doesn't always filter reliably)
      if (vi.language && vi.language !== 'en') {
        continue;
      }
      if (vi.language === 'en') {
        score += 3;
      }
      
      // Author match — if author was provided, reject mismatches
      if (author && vi.authors) {
        const normalizedAuthor = author.toLowerCase();
        const authorLastName = normalizedAuthor.split(/\s+/).pop() || normalizedAuthor;
        const authorMatches = vi.authors.some(a => {
          const la = a.toLowerCase();
          const laLast = la.split(/\s+/).pop() || la;
          return la.includes(normalizedAuthor) || normalizedAuthor.includes(la) || laLast === authorLastName;
        });
        if (authorMatches) {
          score += 4;
        } else {
          // Wrong author — skip this result entirely
          continue;
        }
      } else if (author && !vi.authors) {
        // Author requested but book has no author info — skip
        continue;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = volume;
      }
    }
    
    if (!bestMatch) return null;
    
    const vi = bestMatch.volumeInfo;
    
    // Extract ISBNs
    const isbn10 = vi.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier;
    const isbn13 = vi.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier;
    
    // Clean up description (remove HTML tags)
    let description = vi.description;
    if (description) {
      description = description
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    }
    
    return {
      description,
      isbn10,
      isbn13,
      categories: vi.categories,
      pageCount: vi.pageCount,
      averageRating: vi.averageRating,
      ratingsCount: vi.ratingsCount,
      coverUrl: vi.imageLinks?.thumbnail?.replace('http://', 'https://'),
      publishedDate: vi.publishedDate,
      language: vi.language,
      googleBooksId: bestMatch.id,
    };
  } catch (error) {
    console.error(`[GoogleBooks] Error searching "${title}":`, error);
    return null;
  }
}

/**
 * Get a description for a series by looking up its books.
 * 
 * Uses Book 1's description as the series description. If a book description
 * contains an explicit "ABOUT THE SERIES" section, that is extracted and preferred.
 * 
 * We intentionally do NOT search Google Books for the series name directly,
 * because that consistently returns descriptions from later/popular books 
 * (e.g., Book 8 of Chaos Seeds, a collection volume of Cradle) rather than
 * genuine series-level overviews.
 */
export async function getSeriesDescription(
  books: Array<{ title: string; author?: string }>,
  seriesName?: string,
  maxAttempts: number = 3
): Promise<{ description: string; source: string } | null> {
  // Strategy: Use the first book's description as the series description.
  //
  // Previously we searched Google Books for the series name directly, but this
  // consistently returned descriptions from later/popular books in the series
  // (e.g. Book 8 of Chaos Seeds, a collection volume of Cradle) rather than
  // genuine series-level overviews. Using Book 1's description is more
  // predictable and gives readers the right starting context.
  //
  // If a book description contains an explicit "ABOUT THE SERIES" section,
  // we extract and prefer that over the raw description.

  const booksToTry = books.slice(0, maxAttempts);
  let fallbackDescription: { description: string; source: string } | null = null;
  
  for (const book of booksToTry) {
    const enrichment = await searchBook(book.title, book.author);
    
    if (enrichment?.description && enrichment.description.length > 50) {
      // Check if the description contains an explicit series description section
      const seriesDescMatch = enrichment.description.match(
        /(?:SERIES\s+DESCRIPTION|ABOUT\s+THE\s+SERIES|THE\s+SERIES)[:\s]*(.{50,})/is
      );
      if (seriesDescMatch) {
        return {
          description: seriesDescMatch[1].trim(),
          source: `google-books:${enrichment.googleBooksId}`,
        };
      }

      // Save first usable description as fallback (book 1's description)
      if (!fallbackDescription) {
        fallbackDescription = {
          description: enrichment.description,
          source: `google-books:${enrichment.googleBooksId}`,
        };
      }
    }
  }
  
  // Fall back to first book's description.
  // Book 1's description gives readers the right starting context for the series.
  return fallbackDescription;
}

/**
 * Enrich a book with Google Books data (ISBN, description, etc.)
 * Returns enrichment data without modifying the database
 */
export async function enrichBook(
  title: string,
  author?: string
): Promise<BookEnrichment | null> {
  return searchBook(title, author);
}

/**
 * Batch enrich multiple books with rate limiting
 * Calls the callback for each enriched book
 */
export async function batchEnrich(
  books: Array<{ title: string; author?: string; id?: string }>,
  onResult: (book: { title: string; author?: string; id?: string }, enrichment: BookEnrichment | null) => void,
  onProgress?: (current: number, total: number, enriched: number) => void
): Promise<{ total: number; enriched: number; failed: number }> {
  let enriched = 0;
  let failed = 0;
  
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    
    try {
      const result = await searchBook(book.title, book.author);
      
      if (result) {
        enriched++;
        onResult(book, result);
      } else {
        failed++;
        onResult(book, null);
      }
    } catch (error) {
      failed++;
      onResult(book, null);
    }
    
    onProgress?.(i + 1, books.length, enriched);
  }
  
  return { total: books.length, enriched, failed };
}
