/**
 * Goodreads Source Fetcher
 * Scrapes series data from Goodreads book pages
 * 
 * Goodreads uses Next.js with embedded JSON data, making it easy to parse.
 * Series info is embedded in the __NEXT_DATA__ script tag.
 */

import type { SourceBook, SourceSeries } from '../types.js';
import { fetchWithTimeout, withRetry } from '../utils/resilience.js';

const BASE_URL = 'https://www.goodreads.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 20000; // 20 seconds

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 2000; // Be respectful - 2 seconds between requests

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

interface GoodreadsBook {
  title: string;
  titleComplete: string;
  legacyId: number;
  bookSeries?: Array<{
    userPosition: string;
    series: {
      __ref: string;  // Reference to Series in Apollo state
    };
  }>;
  primaryContributorEdge?: {
    node: {
      name: string;
      legacyId: number;
    };
  };
  details?: {
    publicationTime?: number;
  };
}

interface GoodreadsSeries {
  __typename: string;
  id: string;
  title: string;
  webUrl: string;
}

interface GoodreadsNextData {
  props: {
    pageProps: {
      apolloState: Record<string, unknown>;
    };
  };
}

/**
 * Extract __NEXT_DATA__ JSON from Goodreads page HTML
 */
function extractNextData(html: string): GoodreadsNextData | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    return null;
  }
  
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.error('[Goodreads] Failed to parse __NEXT_DATA__:', error);
    return null;
  }
}

/**
 * Search for a book on Goodreads and get its series info
 */
export async function searchBookSeries(title: string, author?: string): Promise<{
  seriesName: string;
  position: number;
  goodreadsSeriesId: string;
  goodreadsSeriesUrl: string;
} | null> {
  await rateLimit();
  
  // Search for the book
  const query = author ? `${title} ${author}` : title;
  const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
  
  console.log(`[Goodreads] Searching for: ${query}`);
  
  const searchResponse = await withRetry(
    () => fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: FETCH_TIMEOUT,
    }),
    { maxRetries: 2, baseDelay: 3000 }
  );
  
  if (!searchResponse.ok) {
    console.error(`[Goodreads] Search failed: ${searchResponse.status}`);
    return null;
  }
  
  const searchHtml = await searchResponse.text();
  
  // Extract book IDs from search results
  const bookIdMatches = searchHtml.match(/\/book\/show\/(\d+)/g);
  if (!bookIdMatches || bookIdMatches.length === 0) {
    console.log(`[Goodreads] No books found for: ${query}`);
    return null;
  }
  
  // Get the first book's details
  const firstBookId = bookIdMatches[0].replace('/book/show/', '');
  
  await rateLimit();
  
  const bookUrl = `${BASE_URL}/book/show/${firstBookId}`;
  const bookResponse = await withRetry(
    () => fetchWithTimeout(bookUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: FETCH_TIMEOUT,
    }),
    { maxRetries: 2, baseDelay: 3000 }
  );
  
  if (!bookResponse.ok) {
    console.error(`[Goodreads] Book fetch failed: ${bookResponse.status}`);
    return null;
  }
  
  const bookHtml = await bookResponse.text();
  const nextData = extractNextData(bookHtml);
  
  if (!nextData) {
    console.log(`[Goodreads] No Next.js data found for book ${firstBookId}`);
    return null;
  }
  
  // Find the book in Apollo state
  const apolloState = nextData.props.pageProps.apolloState;
  
  for (const key of Object.keys(apolloState)) {
    if (key.startsWith('Book:')) {
      const book = apolloState[key] as GoodreadsBook;
      if (book.bookSeries && book.bookSeries.length > 0) {
        const primarySeries = book.bookSeries[0];
        const position = parseFloat(primarySeries.userPosition) || 0;
        
        // Follow the __ref to get the actual series object
        const seriesRef = primarySeries.series.__ref;
        const seriesObj = apolloState[seriesRef] as GoodreadsSeries | undefined;
        
        if (!seriesObj) {
          console.log(`[Goodreads] Series reference not found: ${seriesRef}`);
          continue;
        }
        
        // Extract series ID from the URL (e.g., /series/196901-awaken-online -> 196901)
        const seriesIdMatch = seriesObj.webUrl.match(/\/series\/(\d+)/);
        const seriesId = seriesIdMatch ? seriesIdMatch[1] : seriesObj.id;
        
        console.log(`[Goodreads] Found series: ${seriesObj.title} #${position}`);
        
        return {
          seriesName: seriesObj.title,
          position,
          goodreadsSeriesId: seriesId,
          goodreadsSeriesUrl: seriesObj.webUrl,
        };
      }
    }
  }
  
  console.log(`[Goodreads] Book ${firstBookId} is not part of a series`);
  return null;
}

// Interface for series page React props
interface SeriesBookEntry {
  book: {
    bookId: string;
    title: string;
    bookTitleBare: string;
    publicationDate?: string;
    author: {
      id: number;
      name: string;
    };
  };
}

interface SeriesReactProps {
  series: SeriesBookEntry[];
  seriesHeaders: string[];
}

/**
 * Fetch all books in a series from Goodreads series page
 */
export async function fetchSeriesBooks(seriesUrl: string): Promise<SourceBook[]> {
  await rateLimit();
  
  console.log(`[Goodreads] Fetching series from: ${seriesUrl}`);
  
  const response = await withRetry(
    () => fetchWithTimeout(seriesUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: FETCH_TIMEOUT,
    }),
    { maxRetries: 2, baseDelay: 3000 }
  );
  
  if (!response.ok) {
    console.error(`[Goodreads] Series fetch failed: ${response.status}`);
    return [];
  }
  
  const html = await response.text();
  const books: SourceBook[] = [];
  const seenBookIds = new Set<string>();
  
  // Extract series data from ALL React SeriesList components (there may be multiple)
  const reactPropsMatches = html.matchAll(/data-react-class="ReactComponents\.SeriesList"[^>]*data-react-props="([^"]+)"/g);
  
  for (const reactPropsMatch of reactPropsMatches) {
    try {
      // Decode HTML entities and parse JSON
      const decodedProps = reactPropsMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
      
      const props: SeriesReactProps = JSON.parse(decodedProps);
      
      for (let i = 0; i < props.series.length; i++) {
        const entry = props.series[i];
        const header = props.seriesHeaders[i];
        
        // Skip if we've already seen this book (avoid duplicates)
        if (seenBookIds.has(entry.book.bookId)) {
          continue;
        }
        seenBookIds.add(entry.book.bookId);
        
        // Parse position from header (e.g., "Book 1", "Book 2.5")
        const posMatch = header?.match(/Book\s+([\d.]+)/i);
        const position = posMatch ? parseFloat(posMatch[1]) : undefined;
        
        // Extract year from publicationDate (e.g., "2016")
        const year = entry.book.publicationDate 
          ? parseInt(entry.book.publicationDate, 10)
          : undefined;
        
        books.push({
          title: entry.book.bookTitleBare || entry.book.title,
          author: entry.book.author?.name,
          position,
          yearPublished: year,
          sourceId: entry.book.bookId,
        });
      }
    } catch (error) {
      console.error('[Goodreads] Failed to parse React props:', error);
    }
  }
  
  // If we found books from React props, return them
  if (books.length > 0) {
    books.sort((a, b) => (a.position || 999) - (b.position || 999));
    console.log(`[Goodreads] Found ${books.length} books in series (from React props)`);
    return books;
  }
  
  // Fallback: Try __NEXT_DATA__ if available
  const nextData = extractNextData(html);
  if (nextData) {
    const apolloState = nextData.props.pageProps.apolloState;
    
    for (const key of Object.keys(apolloState)) {
      if (key.startsWith('Book:')) {
        const book = apolloState[key] as GoodreadsBook;
        if (book.title && book.bookSeries) {
          const seriesEntry = book.bookSeries[0];
          if (seriesEntry) {
            const author = book.primaryContributorEdge?.node?.name;
            const year = book.details?.publicationTime 
              ? new Date(book.details.publicationTime).getFullYear()
              : undefined;
            
            books.push({
              title: book.title,
              author: author,
              position: parseFloat(seriesEntry.userPosition) || undefined,
              yearPublished: year,
              sourceId: String(book.legacyId),
            });
          }
        }
      }
    }
    
    if (books.length > 0) {
      // Sort by position
      books.sort((a, b) => (a.position || 999) - (b.position || 999));
      console.log(`[Goodreads] Found ${books.length} books in series (from JSON)`);
      return books;
    }
  }
  
  // Fallback: Parse HTML directly (older Goodreads pages)
  console.log(`[Goodreads] Falling back to HTML parsing`);
  
  // Simple regex-based extraction
  const seriesBookMatches = html.matchAll(/<tr[^>]*itemtype="http:\/\/schema.org\/Book"[^>]*>[\s\S]*?<\/tr>/g);
  
  for (const match of seriesBookMatches) {
    const row = match[0];
    
    const titleMatch = row.match(/title="([^"]+)"/);
    const posMatch = row.match(/>(\d+(?:\.\d+)?)<\/span>/);
    const authorMatch = row.match(/class="authorName"[^>]*>([^<]+)</);
    
    if (titleMatch) {
      books.push({
        title: titleMatch[1],
        author: authorMatch?.[1]?.trim(),
        position: posMatch ? parseFloat(posMatch[1]) : undefined,
      });
    }
  }
  
  books.sort((a, b) => (a.position || 999) - (b.position || 999));
  console.log(`[Goodreads] Found ${books.length} books in series (from HTML)`);
  
  return books;
}

/**
 * Full series fetch - search for book, get series, fetch all books
 * Returns a SourceSeries with books populated
 */
export async function fetchSeries(bookTitle: string, author?: string): Promise<SourceSeries | null> {
  // First, search for the book and get its series
  const seriesInfo = await searchBookSeries(bookTitle, author);
  
  if (!seriesInfo) {
    return null;
  }
  
  // Then fetch all books in the series
  const books = await fetchSeriesBooks(seriesInfo.goodreadsSeriesUrl);
  
  return {
    name: seriesInfo.seriesName,
    books,
    sourceId: seriesInfo.goodreadsSeriesId,
  };
}

/**
 * Test the Goodreads scraper
 */
export async function testGoodreads(title: string, author?: string): Promise<void> {
  console.log('');
  console.log('=== GOODREADS SCRAPER TEST ===');
  console.log(`Searching for: "${title}"${author ? ` by ${author}` : ''}`);
  console.log('');
  
  const result = await fetchSeries(title, author);
  
  if (result) {
    console.log(`Series: ${result.name}`);
    console.log(`Total books: ${result.books.length}`);
    console.log('');
    console.log('Books:');
    for (const book of result.books.slice(0, 10)) {
      console.log(`  #${book.position || '?'}: ${book.title} - ${book.author || 'Unknown'}`);
    }
    if (result.books.length > 10) {
      console.log(`  ... and ${result.books.length - 10} more`);
    }
  } else {
    console.log('No series found');
  }
}
