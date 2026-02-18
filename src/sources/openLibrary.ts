/**
 * Open Library Source Fetcher
 * Uses Open Library API for series data and book description fallback.
 * 
 * API docs: https://openlibrary.org/dev/docs/api/books
 * - Search: /search.json?q=TITLE&fields=key,title,author_name
 * - Works:  /works/OL_ID.json → has 'description' field
 * - Editions: /books/OL_ID.json → sometimes has 'description' field
 * 
 * Descriptions may be a plain string or { type: "/type/text", value: "..." }
 */

import { config } from '../config.js';
import { fetchWithTimeout, withRetry } from '../utils/resilience.js';
import { olCircuitBreaker, CircuitBreaker } from '../circuitBreaker.js';
import type { SourceBook, SourceSeries, SourceResult } from '../types.js';

const USER_AGENT = 'NachoSeries/0.1.0 (Book Enrichment; Series Indexer)';
const FETCH_TIMEOUT = 10000;

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 1000 / config.rateLimit.openLibrary;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

/**
 * Check circuit breaker before making OL requests.
 * If circuit is open, waits for cooldown and retries.
 * Returns false if circuit is open (caller should skip OL).
 */
export function isOLAvailable(): boolean {
  return olCircuitBreaker.allowRequest();
}

/**
 * Wrap a fetch to OL with circuit breaker tracking.
 * Distinguishes infra failures (5xx, timeouts) from data misses (404, empty results).
 */
async function olFetch(url: string, options?: { timeout?: number }): Promise<Response> {
  if (!olCircuitBreaker.allowRequest()) {
    throw new OLCircuitOpenError();
  }

  try {
    const resp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: options?.timeout ?? FETCH_TIMEOUT,
    });

    if (CircuitBreaker.isHttpFailure(resp.status)) {
      olCircuitBreaker.recordFailure();
    } else {
      olCircuitBreaker.recordSuccess();
    }

    return resp;
  } catch (error) {
    if (CircuitBreaker.isInfraFailure(error)) {
      olCircuitBreaker.recordFailure();
    }
    throw error;
  }
}

/** Thrown when OL circuit breaker is open — not an infra failure, just "skip me" */
export class OLCircuitOpenError extends Error {
  constructor() {
    super('Open Library circuit breaker is open');
    this.name = 'OLCircuitOpenError';
  }
}

interface OpenLibraryWork {
  key: string;
  title: string;
  authors?: Array<{ author: { key: string } }>;
  series?: Array<{ name: string; position?: string }>;
  first_publish_date?: string;
  covers?: number[];
}

interface OpenLibrarySearchResult {
  docs: Array<{
    key: string;
    title: string;
    author_name?: string[];
    first_publish_year?: number;
    series?: string[];
  }>;
}

/**
 * Fetch series data from Open Library
 * Note: Open Library doesn't have a direct series API, so we search and aggregate
 */
export async function fetchSeries(seriesName: string): Promise<SourceResult> {
  try {
    await rateLimit();
    
    // Search for books in the series
    const query = encodeURIComponent(`"${seriesName}"`);
    const url = `https://openlibrary.org/search.json?q=${query}&fields=key,title,author_name,first_publish_year,series&limit=100`;
    
    console.log(`[OpenLibrary] Fetching series: ${seriesName}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NachoSeries/0.1.0 (Series Indexer; mailto:your@email.com)',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json() as OpenLibrarySearchResult;
    
    if (!data.docs || data.docs.length === 0) {
      return {
        source: 'openlibrary',
        series: null,
        raw: data,
        error: 'No results found',
      };
    }
    
    // Filter to books that actually match the series
    const seriesBooks = data.docs.filter(doc => {
      // Check if the series field matches
      if (doc.series?.some(s => 
        s.toLowerCase().includes(seriesName.toLowerCase()) ||
        seriesName.toLowerCase().includes(s.toLowerCase())
      )) {
        return true;
      }
      // Check if title contains series name (fallback)
      return doc.title.toLowerCase().includes(seriesName.toLowerCase());
    });
    
    if (seriesBooks.length === 0) {
      return {
        source: 'openlibrary',
        series: null,
        raw: data,
        error: 'No matching series books found',
      };
    }
    
    // Convert to our format
    const books: SourceBook[] = seriesBooks.map((doc, index) => ({
      title: doc.title,
      position: index + 1, // Open Library doesn't reliably provide position
      author: doc.author_name?.[0],
      yearPublished: doc.first_publish_year,
      sourceId: doc.key,
    }));
    
    // Get most common author
    const authorCounts: Record<string, number> = {};
    for (const doc of seriesBooks) {
      if (doc.author_name?.[0]) {
        const author = doc.author_name[0];
        authorCounts[author] = (authorCounts[author] || 0) + 1;
      }
    }
    const seriesAuthor = Object.entries(authorCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    
    const series: SourceSeries = {
      name: seriesName,
      author: seriesAuthor,
      books,
    };
    
    return {
      source: 'openlibrary',
      series,
      raw: data,
    };
  } catch (error) {
    console.error(`[OpenLibrary] Error fetching ${seriesName}:`, error);
    return {
      source: 'openlibrary',
      series: null,
      raw: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Fetch detailed work info by Open Library key
 */
export async function fetchWork(workKey: string): Promise<OpenLibraryWork | null> {
  try {
    await rateLimit();
    
    const url = `https://openlibrary.org${workKey}.json`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
      },
    });
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json() as OpenLibraryWork;
  } catch (error) {
    console.error(`[OpenLibrary] Error fetching work ${workKey}:`, error);
    return null;
  }
}

/**
 * Search for series in a genre
 */
export async function searchSeriesByGenre(genre: string, limit = 50): Promise<string[]> {
  try {
    await rateLimit();
    
    // Open Library subject search
    const url = `https://openlibrary.org/subjects/${genre}.json?limit=${limit}`;
    
    console.log(`[OpenLibrary] Searching genre: ${genre}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json() as {
      works?: Array<{
        title: string;
        series?: string[];
      }>;
    };
    
    // Extract unique series names
    const seriesNames = new Set<string>();
    
    for (const work of data.works || []) {
      if (work.series) {
        for (const s of work.series) {
          seriesNames.add(s);
        }
      }
    }
    
    return Array.from(seriesNames).slice(0, limit);
  } catch (error) {
    console.error(`[OpenLibrary] Error searching genre ${genre}:`, error);
    return [];
  }
}

// =============================================================================
// Book Description Fallback
// =============================================================================

/**
 * Extract description text from Open Library's description field.
 * It can be either a plain string or { type: "/type/text", value: "..." }
 */
function extractDescription(desc: unknown): string | null {
  if (!desc) return null;
  if (typeof desc === 'string') return desc.trim();
  if (typeof desc === 'object' && desc !== null && 'value' in desc) {
    const val = (desc as { value: unknown }).value;
    if (typeof val === 'string') return val.trim();
  }
  return null;
}

/**
 * Clean up an Open Library description:
 * - Strip source citations like "([source])" at the end
 * - Remove "----------" separators sometimes appended
 * - Trim trailing whitespace
 */
function cleanDescription(raw: string): string {
  let desc = raw
    .replace(/\r\n/g, '\n')
    .replace(/\(?\[source\][\)\.]?\s*$/i, '')
    .replace(/-{5,}[\s\S]*$/, '')          // cut off "-----" separators + anything after
    .replace(/\s+$/, '');
  return desc;
}

interface OLSearchDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
}

/**
 * Search Open Library for a book and return its description.
 * 
 * Flow:
 * 1. Search by title (+ optional author) to get the work key
 * 2. Fetch the work JSON for a description
 * 3. If the work lacks a description, fetch the first edition
 * 
 * Returns null if no description is found.
 */
export async function searchBookDescription(
  title: string,
  author?: string,
): Promise<{ description: string; source: string } | null> {
  try {
    // --- Step 1: Search for the book ---
    await rateLimit();

    let query = encodeURIComponent(title);
    if (author) {
      query += `+${encodeURIComponent(author)}`;
    }
    const searchUrl = `https://openlibrary.org/search.json?q=${query}&fields=key,title,author_name,first_publish_year&limit=5`;

    const searchResp = await olFetch(searchUrl);

    if (!searchResp.ok) {
      console.error(`[OpenLibrary] Search HTTP ${searchResp.status}`);
      return null;
    }

    const searchData = await searchResp.json() as { docs?: OLSearchDoc[] };
    if (!searchData.docs || searchData.docs.length === 0) return null;

    // Pick best match: prefer title + author match
    const normalizedTitle = title.toLowerCase().replace(/[^\w\s]/g, '');
    let bestDoc: OLSearchDoc | null = null;
    let bestScore = -1;

    for (const doc of searchData.docs) {
      let score = 0;
      const docTitle = doc.title.toLowerCase().replace(/[^\w\s]/g, '');

      if (docTitle === normalizedTitle) {
        score += 10;
      } else if (docTitle.includes(normalizedTitle) || normalizedTitle.includes(docTitle)) {
        score += 5;
      } else {
        continue; // title doesn't match at all — skip
      }

      if (author && doc.author_name) {
        const authorLower = author.toLowerCase();
        const authorLast = authorLower.split(/\s+/).pop() || authorLower;
        const matches = doc.author_name.some(a => {
          const la = a.toLowerCase();
          const laLast = la.split(/\s+/).pop() || la;
          return la.includes(authorLower) || authorLower.includes(la) || laLast === authorLast;
        });
        if (matches) score += 4;
        else continue; // wrong author — skip
      }

      if (score > bestScore) {
        bestScore = score;
        bestDoc = doc;
      }
    }

    if (!bestDoc) return null;

    // --- Step 2: Fetch the work for description ---
    await rateLimit();
    const workUrl = `https://openlibrary.org${bestDoc.key}.json`;
    const workResp = await olFetch(workUrl);

    if (workResp.ok) {
      const work = await workResp.json() as Record<string, unknown>;
      const desc = extractDescription(work.description);
      if (desc && desc.length > 30) {
        return {
          description: cleanDescription(desc),
          source: `openlibrary:${bestDoc.key}`,
        };
      }
    }

    // --- Step 3: Fetch editions for description ---
    await rateLimit();
    const editionsUrl = `https://openlibrary.org${bestDoc.key}/editions.json`;
    const edResp = await olFetch(editionsUrl);

    if (edResp.ok) {
      const edData = await edResp.json() as { entries?: Array<Record<string, unknown>> };
      if (edData.entries) {
        for (const edition of edData.entries) {
          const desc = extractDescription(edition.description);
          if (desc && desc.length > 30) {
            return {
              description: cleanDescription(desc),
              source: `openlibrary:${edition.key || bestDoc.key}`,
            };
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`[OpenLibrary] Error searching "${title}":`, error instanceof Error ? error.message : error);
    return null;
  }
}
