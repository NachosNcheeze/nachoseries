/**
 * iTunes Search API Integration
 *
 * Used as a third-tier fallback for book descriptions after Google Books and
 * Open Library. iTunes is especially strong for self-published LitRPG/Progression
 * Fantasy titles that have audiobook editions but may be missing from Google
 * Books and Open Library.
 *
 * API docs: https://developer.apple.com/library/archive/documentation/AudioVideo/
 *           Conceptual/iTuneSearchAPI/Searching.html
 *
 * Key facts:
 * - Rate limit: ~20 requests/minute (Apple's guideline)
 * - Returns HTML-formatted descriptions (need to strip tags)
 * - Searches audiobooks first (richer descriptions), then ebooks
 * - No auth required
 */

import { fetchWithTimeout, withRetry } from '../utils/resilience.js';

const BASE_URL = 'https://itunes.apple.com/search';
const USER_AGENT = 'NachoSeries/0.1.0 (Book Enrichment)';
const FETCH_TIMEOUT = 10000;

// Rate limiter — Apple says ~20 req/min ≈ 1 req/3s, be conservative
let lastRequest = 0;
const MIN_INTERVAL = 3000; // 3 seconds between requests

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

// iTunes result shapes
interface ITunesSearchResult {
  resultCount: number;
  results: ITunesItem[];
}

interface ITunesItem {
  // Common
  artistName?: string;
  description?: string;
  releaseDate?: string;
  // Audiobook fields
  collectionName?: string;
  collectionId?: number;
  // Ebook fields
  trackName?: string;
  trackId?: number;
  // Media type
  kind?: string;         // "ebook"
  wrapperType?: string;  // "audiobook" | "track"
}

/**
 * Strip HTML tags and decode common HTML entities from an iTunes description.
 */
function cleanHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Get the display title for an iTunes result (audiobooks use collectionName,
 * ebooks use trackName).
 */
function getTitle(item: ITunesItem): string {
  return item.collectionName || item.trackName || '';
}

/**
 * Score an iTunes result against the expected title and author.
 * Returns -1 if the result should be rejected outright.
 */
function scoreResult(item: ITunesItem, title: string, author?: string): number {
  const itemTitle = getTitle(item).toLowerCase().replace(/[^\w\s]/g, '');
  const normalizedTitle = title.toLowerCase().replace(/[^\w\s]/g, '');

  let score = 0;

  // iTunes audiobook titles often have suffixes like "(Unabridged)" and series
  // info like "Warformed: Stormweaver, Book 1". Strip those for comparison.
  const cleanItemTitle = itemTitle
    .replace(/\s*\(unabridged\)/g, '')
    .replace(/\s*\(abridged\)/g, '')
    .trim();

  // Title matching
  if (cleanItemTitle === normalizedTitle) {
    score += 10;
  } else if (cleanItemTitle.startsWith(normalizedTitle) || normalizedTitle.startsWith(cleanItemTitle)) {
    score += 7;
  } else if (cleanItemTitle.includes(normalizedTitle) || normalizedTitle.includes(cleanItemTitle)) {
    score += 4;
  } else {
    return -1; // Title doesn't match at all
  }

  // Has substantial description
  if (item.description && item.description.length > 50) {
    score += 5;
  }

  // Author matching
  if (author && item.artistName) {
    const authorLower = author.toLowerCase();
    const authorLast = authorLower.split(/\s+/).pop() || authorLower;
    const artistLower = item.artistName.toLowerCase();
    const artistNames = artistLower.split(/\s*[&,]\s*/); // "A & B" → ["a", "b"]

    const authorMatches = artistNames.some(a => {
      const aLast = a.trim().split(/\s+/).pop() || a.trim();
      return a.includes(authorLower) || authorLower.includes(a.trim()) || aLast === authorLast;
    });

    if (authorMatches) {
      score += 4;
    } else {
      return -1; // Wrong author
    }
  }

  return score;
}

/**
 * Search iTunes for a specific media type and return the best matching
 * description.
 */
async function searchMedia(
  term: string,
  media: 'audiobook' | 'ebook',
  title: string,
  author?: string,
): Promise<{ description: string; source: string } | null> {
  await rateLimit();

  const params = new URLSearchParams({
    term,
    media,
    limit: '5',
    country: 'US',
  });

  const url = `${BASE_URL}?${params.toString()}`;

  try {
    const response = await withRetry(
      () => fetchWithTimeout(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: FETCH_TIMEOUT,
      }),
      {
        maxRetries: 2,
        baseDelay: 3000,
        retryOn: (err) => {
          if (!(err instanceof Error)) return false;
          const m = err.message.toLowerCase();
          return m.includes('econnrefused') || m.includes('econnreset') ||
                 m.includes('etimedout') || m.includes('aborted') || m.includes('fetch failed');
        },
      }
    );

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        console.warn(`[iTunes] Rate limited (${response.status}), skipping`);
        return null;
      }
      return null;
    }

    const data = await response.json() as ITunesSearchResult;
    if (!data.results || data.results.length === 0) return null;

    // Find best matching result
    let bestItem: ITunesItem | null = null;
    let bestScore = 0;

    for (const item of data.results) {
      const s = scoreResult(item, title, author);
      if (s > bestScore) {
        bestScore = s;
        bestItem = item;
      }
    }

    if (!bestItem || !bestItem.description || bestItem.description.length < 30) {
      return null;
    }

    const cleaned = cleanHtml(bestItem.description);
    if (cleaned.length < 30) return null;

    const id = bestItem.collectionId || bestItem.trackId || 'unknown';
    return {
      description: cleaned,
      source: `itunes-${media}:${id}`,
    };
  } catch (error) {
    console.error(`[iTunes] Error searching "${term}" (${media}):`,
      error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Search iTunes for a book description.
 *
 * Strategy:
 * 1. Search audiobooks first (richer descriptions for self-published titles)
 * 2. Fall back to ebooks if audiobook search misses
 *
 * Returns null if no description is found.
 */
export async function searchBookDescription(
  title: string,
  author?: string,
): Promise<{ description: string; source: string } | null> {
  // Build search term: title + author for better matching
  const term = author ? `${title} ${author}` : title;

  // Try audiobooks first — they tend to have the best descriptions
  const audioResult = await searchMedia(term, 'audiobook', title, author);
  if (audioResult) return audioResult;

  // Fall back to ebooks
  const ebookResult = await searchMedia(term, 'ebook', title, author);
  if (ebookResult) return ebookResult;

  return null;
}
