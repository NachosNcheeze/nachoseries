/**
 * ISFDB Source Fetcher
 * Internet Speculative Fiction Database - traditional HTML scraping
 * 
 * ISFDB is a comprehensive database of speculative fiction.
 * Unlike LibraryThing, it uses server-side rendering so we can scrape directly.
 */

import * as cheerio from 'cheerio';
import { config } from '../config.js';
import type { SourceBook, SourceSeries, SourceResult } from '../types.js';

const BASE_URL = 'https://isfdb.org';

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 1000 / config.rateLimit.isfdb;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

/**
 * Search for a series on ISFDB
 */
async function searchSeries(seriesName: string): Promise<{ id: string; name: string } | null> {
  await rateLimit();
  
  const query = encodeURIComponent(seriesName);
  const url = `${BASE_URL}/cgi-bin/se.cgi?arg=${query}&type=Series`;
  
  console.log(`[ISFDB] Searching for series: ${seriesName}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  // Check if we got a direct series page (title contains "Series:")
  const pageTitle = $('title').text();
  if (pageTitle.startsWith('Series:')) {
    // Direct match - extract series ID from edit link
    const editLink = $('a[href*="editseries.cgi"]').attr('href');
    if (editLink) {
      const match = editLink.match(/editseries\.cgi\?(\d+)/);
      if (match) {
        const seriesNameFromPage = $('h2').text().replace('Series: ', '').trim();
        return { id: match[1], name: seriesNameFromPage };
      }
    }
  }
  
  // Multiple results - look for exact or best match
  const results: Array<{ id: string; name: string }> = [];
  
  // ISFDB search results show series links
  $('a[href*="pe.cgi"]').each((_, el) => {
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/pe\.cgi\?(\d+)/);
    if (match && name) {
      results.push({ id: match[1], name });
    }
  });
  
  if (results.length === 0) {
    return null;
  }
  
  // Try to find exact match first
  const exactMatch = results.find(r => 
    r.name.toLowerCase() === seriesName.toLowerCase()
  );
  if (exactMatch) return exactMatch;
  
  // Otherwise return first result
  return results[0];
}

/**
 * Search for multiple series matching a keyword
 * Returns all series from search results
 */
export async function searchSeriesKeyword(keyword: string, maxResults = 100): Promise<Array<{ id: string; name: string }>> {
  await rateLimit();
  
  const query = encodeURIComponent(keyword);
  const url = `${BASE_URL}/cgi-bin/se.cgi?arg=${query}&type=Series`;
  
  console.log(`[ISFDB] Searching series with keyword: ${keyword}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const results: Array<{ id: string; name: string }> = [];
  
  // Check if we got a direct series page (single result)
  const pageTitle = $('title').text();
  if (pageTitle.startsWith('Series:')) {
    const editLink = $('a[href*="editseries.cgi"]').attr('href');
    if (editLink) {
      const match = editLink.match(/editseries\.cgi\?(\d+)/);
      if (match) {
        const seriesNameFromPage = $('h2').text().replace('Series: ', '').trim();
        results.push({ id: match[1], name: seriesNameFromPage });
      }
    }
    return results;
  }
  
  // Multiple results - collect all series links
  $('a[href*="pe.cgi"]').each((_, el) => {
    if (results.length >= maxResults) return;
    
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/pe\.cgi\?(\d+)/);
    if (match && name) {
      // Avoid duplicates
      if (!results.find(r => r.id === match[1])) {
        results.push({ id: match[1], name });
      }
    }
  });
  
  console.log(`[ISFDB] Found ${results.length} series for keyword: ${keyword}`);
  return results;
}

/**
 * Fetch series details from ISFDB series page
 */
async function fetchSeriesPage(seriesId: string): Promise<SourceSeries | null> {
  await rateLimit();
  
  const url = `${BASE_URL}/cgi-bin/pe.cgi?${seriesId}`;
  console.log(`[ISFDB] Fetching series page: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  // Get series name from header
  const seriesName = $('h2').first().text().replace('Series: ', '').trim();
  if (!seriesName) {
    return null;
  }
  
  // Extract author - appears in book entries as "by Author"
  let author: string | undefined;
  
  // Parse books from the series listing
  const books: SourceBook[] = [];
  
  // Get the content area - books are in nested lists within ContentBox divs
  const contentBoxes = $('#content .ContentBox');
  
  contentBoxes.each((boxIndex, box) => {
    const $box = $(box);
    
    // Look for li elements that have a title link with italic class
    $box.find('li').each((_, el) => {
      const $li = $(el);
      
      // Check if this li has a title link (class="italic" and href contains title.cgi)
      const titleLink = $li.find('> a.italic[href*="title.cgi"], > a[class*="italic"][href*="title.cgi"]');
      if (titleLink.length === 0) return;
      
      // Get the text content before the link (should be the position number)
      const liText = $li.clone().children().remove().end().text().trim();
      const positionMatch = liText.match(/^(\d+(?:\.\d+)?)/);
      const position = positionMatch ? parseFloat(positionMatch[1]) : undefined;
      
      // Skip if no position (likely a subseries header)
      if (position === undefined) return;
      
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      const titleId = href?.match(/title\.cgi\?(\d+)/)?.[1];
      
      // Get year from the bold tag that contains a 4-digit year
      const boldTags = $li.find('> b');
      let year: number | undefined;
      boldTags.each((_, b) => {
        const bText = $(b).text();
        const yearMatch = bText.match(/^(\d{4})$/);
        if (yearMatch) {
          year = parseInt(yearMatch[1]);
        }
      });
      
      // Get author if not already found (only first author link, avoid translations)
      if (!author) {
        const authorLink = $li.find('a[href*="ea.cgi"]').first();
        if (authorLink.length) {
          const authorText = authorLink.text().trim();
          // Skip if it contains non-ASCII characters (likely a translation)
          if (/^[\x00-\x7F]+$/.test(authorText)) {
            author = authorText;
          }
        }
      }
      
      // Skip short fiction marked with [SF]
      const typeMarker = $li.text();
      if (typeMarker.includes('[SF]')) {
        return;
      }
      
      books.push({
        title,
        position,
        yearPublished: year,
        sourceId: titleId,
        author,
      });
    });
  });
  
  // Deduplicate books by title
  const uniqueBooks = books.reduce((acc, book) => {
    const existing = acc.find(b => b.title === book.title);
    if (!existing) {
      acc.push(book);
    }
    return acc;
  }, [] as SourceBook[]);
  
  // Sort by position
  uniqueBooks.sort((a, b) => {
    if (a.position === undefined && b.position === undefined) return 0;
    if (a.position === undefined) return 1;
    if (b.position === undefined) return -1;
    return a.position - b.position;
  });
  
  console.log(`[ISFDB] Parsed ${uniqueBooks.length} books from HTML`);
  
  return {
    name: seriesName,
    author,
    books: uniqueBooks,
    sourceId: seriesId,
  };
}

/**
 * Fetch series by ID directly
 */
export async function fetchSeriesById(seriesId: string): Promise<SourceResult> {
  try {
    const series = await fetchSeriesPage(seriesId);
    
    if (!series) {
      return {
        source: 'isfdb',
        series: null,
        raw: { seriesId },
        error: 'Failed to parse series page',
      };
    }
    
    return {
      source: 'isfdb',
      series,
      raw: { seriesId },
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      source: 'isfdb',
      series: null,
      raw: null,
      error: message,
    };
  }
}

/**
 * Main entry point - fetch series data from ISFDB
 */
export async function fetchSeries(seriesName: string): Promise<SourceResult> {
  try {
    // First search for the series
    const searchResult = await searchSeries(seriesName);
    
    if (!searchResult) {
      return {
        source: 'isfdb',
        series: null,
        raw: null,
        error: 'Series not found',
      };
    }
    
    console.log(`[ISFDB] Found series: ${searchResult.name} (ID: ${searchResult.id})`);
    
    // Fetch the full series page
    const series = await fetchSeriesPage(searchResult.id);
    
    if (!series) {
      return {
        source: 'isfdb',
        series: null,
        raw: { searchResult },
        error: 'Failed to parse series page',
      };
    }
    
    console.log(`[ISFDB] Found ${series.books.length} books in series`);
    
    return {
      source: 'isfdb',
      series,
      raw: { searchResult },
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[ISFDB] Error: ${message}`);
    return {
      source: 'isfdb',
      series: null,
      raw: null,
      error: message,
    };
  }
}

/**
 * Genre search keywords for crawling
 * These map our genres to ISFDB search terms
 */
export const genreKeywords: Record<string, string[]> = {
  'litrpg': ['litrpg', 'gamelit', 'dungeon core', 'cultivation'],
  'fantasy': ['epic fantasy series', 'high fantasy', 'urban fantasy series', 'sword and sorcery'],
  'science-fiction': ['space opera', 'hard science fiction', 'military sf series', 'cyberpunk'],
  'post-apocalyptic': ['post-apocalyptic', 'apocalyptic', 'dystopian series'],
};

/**
 * Browse series by genre using keyword searches
 */
export async function browseSeriesByGenre(genre: string): Promise<Array<{ id: string; name: string }>> {
  const keywords = genreKeywords[genre] || [genre];
  const allSeries: Array<{ id: string; name: string }> = [];
  const seenIds = new Set<string>();
  
  for (const keyword of keywords) {
    const results = await searchSeriesKeyword(keyword, 50);
    
    for (const series of results) {
      if (!seenIds.has(series.id)) {
        seenIds.add(series.id);
        allSeries.push(series);
      }
    }
    
    // Be nice to ISFDB
    await rateLimit();
  }
  
  console.log(`[ISFDB] Total unique series for genre "${genre}": ${allSeries.length}`);
  return allSeries;
}
