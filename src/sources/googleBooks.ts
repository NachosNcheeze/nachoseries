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
      
      // Is English
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
 * Check if a description looks like a single-book synopsis rather than a series description.
 * Returns true if the description appears to be about one specific book (not the series).
 */
function looksLikeBookSynopsis(description: string, seriesName?: string): boolean {
  const lower = description.toLowerCase();

  // Patterns that indicate a specific book in a series
  const bookIndicators = [
    /\bbook\s+\d+\b/i,                          // "Book 11 of..."
    /\bvolume\s+\d+\b/i,                         // "Volume 3..."
    /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:book|novel|installment|volume|entry)\b/i,
    /\b(?:sequel|prequel|continuation|conclusion)\b/i,
    /\bpick(?:s)?\s+up\s+where\b/i,              // "picks up where Book X left off"
    /\bgrab\s+your\s+copy\b/i,                   // marketing for individual book
    /\bbuy\s+(?:now|today|your\s+copy)\b/i,
    /\bavailable\s+now\b/i,
    /\bin\s+this\s+(?:thrilling|exciting|latest|new)\s+(?:installment|entry|chapter|book)\b/i,
    /\bthe\s+(?:latest|newest|final|last)\s+(?:book|installment|entry|novel)\b/i,
  ];

  for (const pattern of bookIndicators) {
    if (pattern.test(description)) {
      return true;
    }
  }

  // If description is very character-specific and doesn't mention the series name, likely a book synopsis
  // (e.g., "Zac must stop them" with no mention of what the series is about broadly)
  if (seriesName) {
    const seriesLower = seriesName.toLowerCase();
    // If the description never mentions the series by name and reads like a plot summary
    // with a specific character doing specific things, it's likely a book synopsis.
    // But we can't be too aggressive here — many valid series descriptions also have character names.
    // Only flag if the description has NONE of these series-level signals:
    const seriesSignals = [
      /\bseries\b/i,
      /\btrilogy\b/i,
      /\bsaga\b/i,
      /\bcollection\b/i,
      /\bchronicles?\b/i,
      /\bfollow(?:s|ing)?\s+(?:the\s+)?(?:adventures?|journey|story|stories)\b/i,
      /\bepic\s+(?:fantasy|saga|adventure|series)\b/i,
      new RegExp(`\\b${seriesLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    ];

    const hasSeriesSignal = seriesSignals.some(p => p.test(description));
    if (!hasSeriesSignal && description.length < 500) {
      // Short description with no series signals — likely a book synopsis
      return true;
    }
  }

  return false;
}

/**
 * Search for a true series-level description.
 * 
 * Strategy:
 * 1. Search Google Books for the series name directly — may find a box set or series overview
 * 2. If that fails, check individual books for descriptions that read like series overviews
 *    (containing words like "series", "saga", "chronicles", etc.)
 * 3. Reject descriptions that are clearly single-book synopses
 *    (containing "Book X of", "grab your copy", character-specific plot)
 * 
 * Returns null rather than returning a book synopsis — better to have no series description
 * than a misleading one. Book synopses belong in series_book.description.
 */
export async function getSeriesDescription(
  books: Array<{ title: string; author?: string }>,
  seriesName?: string,
  maxAttempts: number = 3
): Promise<{ description: string; source: string } | null> {
  // STRATEGY 1: Search for the series name directly
  // This sometimes finds box sets, omnibus editions, or series landing pages
  // that have genuine series-level descriptions
  if (seriesName) {
    // Try "series name + series" to find overview entries
    const seriesSearches = [
      `${seriesName} series`,
      seriesName,
    ];

    for (const query of seriesSearches) {
      const enrichment = await searchBook(query);
      if (enrichment?.description && enrichment.description.length > 50) {
        if (!looksLikeBookSynopsis(enrichment.description, seriesName)) {
          return {
            description: enrichment.description,
            source: `google-books:${enrichment.googleBooksId}`,
          };
        }
      }
    }
  }

  // STRATEGY 2: Check individual book descriptions for series-level content
  // Sometimes book 1's description includes a series overview paragraph
  // (e.g., "SERIES DESCRIPTION: The Cradle series is...")
  const booksToTry = books.slice(0, maxAttempts);
  
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

      // Only use a book description if it genuinely reads like a series overview
      if (!looksLikeBookSynopsis(enrichment.description, seriesName)) {
        // Additional check: the description should feel like it's describing a series arc,
        // not a single book's plot. We do this by requiring series-level language.
        const hasSeriesLanguage = /\bseries\b|\btrilogy\b|\bsaga\b|\bchronicles?\b|\bbooks?\s+in\b/i.test(
          enrichment.description
        );
        if (hasSeriesLanguage) {
          return {
            description: enrichment.description,
            source: `google-books:${enrichment.googleBooksId}`,
          };
        }
      }
    }
  }
  
  // Better to return null than a book synopsis masquerading as a series description.
  // The frontend will fall back to firstBookDescription (clearly labeled) or a generated description.
  return null;
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
