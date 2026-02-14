/**
 * Goodreads Shelf Scraper
 * Scrapes series data from Goodreads genre shelf/tag pages
 * 
 * Unlike goodreadsList.ts which scrapes curated "best of" lists,
 * this scrapes community-tagged shelves (e.g. /shelf/show/litrpg)
 * which have much broader coverage including indie/self-pub titles.
 * 
 * Part of Combo 1 (Layer 2): Bulk genre expansion via Goodreads shelves.
 */

import type { SourceSeries, SourceBook } from '../types.js';

const BASE_URL = 'https://www.goodreads.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 2500; // 2.5 seconds between requests (be respectful)

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

// Shelf name → NachoSeries genre mapping
// Goodreads shelves are community-tagged, so one genre maps to multiple shelf names
export const GENRE_SHELF_MAP: Record<string, string[]> = {
  'litrpg': [
    'litrpg',
    'lit-rpg',
    'gamelit',
    'game-lit',
    'progression-fantasy',
    'cultivation',
    'dungeon-core',
    'system-apocalypse',
    'vrmmo',
    'wuxia',
    'xianxia',
  ],
  'post-apocalyptic': [
    'post-apocalyptic',
    'post-apocalypse',
    'apocalyptic',
    'dystopian',
    'dystopia',
    'survival',
    'zombie',
    'zombies',
    'emp',
    'nuclear-war',
  ],
  'fantasy': [
    'epic-fantasy',
    'high-fantasy',
    'dark-fantasy',
    'urban-fantasy',
    'sword-and-sorcery',
    'grimdark',
    'fantasy-romance',
    'romantasy',
  ],
  'science-fiction': [
    'space-opera',
    'military-sci-fi',
    'military-science-fiction',
    'cyberpunk',
    'hard-science-fiction',
    'hard-sf',
    'first-contact',
    'generation-ship',
    'colony-ship',
    'time-travel',
  ],
  'horror': [
    'horror',
    'supernatural-horror',
    'cosmic-horror',
    'gothic-horror',
    'paranormal',
  ],
};

export interface ShelfBook {
  title: string;
  author: string;
  bookId: string;
  rating?: number;
  seriesInfo?: {
    name: string;
    position: number;
  };
}

/**
 * Parse a Goodreads shelf page to extract books
 * Shelf pages use a different layout than list pages
 */
function parseShelfPage(html: string): ShelfBook[] {
  const books: ShelfBook[] = [];
  
  // Goodreads shelf pages have books in <div class="elementList">
  // with anchors containing the title and a bookTitle class
  // Try multiple parsing strategies
  
  // Strategy 1: Look for leftAlignedImage pattern (shelf layout)
  const bookBlocks = html.split(/class="leftAlignedImage"/);
  
  for (let i = 1; i < bookBlocks.length; i++) {
    const block = bookBlocks[i];
    
    // Extract book ID and title from the book link
    const titleMatch = block.match(/\/book\/show\/(\d+)[^"]*"[^>]*>([^<]+)/);
    if (!titleMatch) continue;
    
    const bookId = titleMatch[1];
    let fullTitle = titleMatch[2].trim();
    
    // Extract author
    const authorMatch = block.match(/class="authorName"[^>]*>(?:<span[^>]*>)?([^<]+)/);
    if (!authorMatch) continue;
    
    const author = authorMatch[1].trim();
    
    // Extract series info from title: "(Series Name, #1)"
    let seriesInfo: ShelfBook['seriesInfo'];
    const seriesMatch = fullTitle.match(/\(([^,()]+?)(?:,\s*#|\s*#|,\s*Book\s*)(\d+(?:\.\d+)?)\)\s*$/);
    
    if (seriesMatch) {
      seriesInfo = {
        name: seriesMatch[1].trim(),
        position: parseFloat(seriesMatch[2]),
      };
      // Remove series info from title
      fullTitle = fullTitle.replace(/\s*\([^()]+#\d+(?:\.\d+)?\)\s*$/, '').trim();
    }
    
    // Extract rating if available
    const ratingMatch = block.match(/(?:avg rating|minirating)[^>]*>[\s\S]*?([\d.]+)\s*avg/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;
    
    books.push({
      title: fullTitle,
      author,
      bookId,
      rating,
      seriesInfo,
    });
  }
  
  // Strategy 2: If strategy 1 got nothing, try tableList pattern
  if (books.length === 0) {
    const rows = html.split(/<tr itemscope|<div class="elementList"/);
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      
      const bookMatch = row.match(/\/book\/show\/(\d+)/);
      if (!bookMatch) continue;
      
      // Try multiple title extraction patterns
      const titlePatterns = [
        /class="bookTitle"[^>]*>\s*(?:<span[^>]*>)?([^<]+)/,
        /itemprop=['"]name['"][^>]*>([^<]+)/,
        /\/book\/show\/\d+[^"]*"[^>]*>([^<]+)/,
      ];
      
      let fullTitle = '';
      for (const pattern of titlePatterns) {
        const match = row.match(pattern);
        if (match) {
          fullTitle = match[1].trim();
          break;
        }
      }
      if (!fullTitle) continue;
      
      const authorMatch = row.match(/class="authorName"[^>]*>(?:<span[^>]*>)?([^<]+)/);
      if (!authorMatch) continue;
      
      const bookId = bookMatch[1];
      const author = authorMatch[1].trim();
      
      let seriesInfo: ShelfBook['seriesInfo'];
      const seriesMatch = fullTitle.match(/\(([^,()]+?)(?:,\s*#|\s*#|,\s*Book\s*)(\d+(?:\.\d+)?)\)\s*$/);
      
      if (seriesMatch) {
        seriesInfo = {
          name: seriesMatch[1].trim(),
          position: parseFloat(seriesMatch[2]),
        };
        fullTitle = fullTitle.replace(/\s*\([^()]+#\d+(?:\.\d+)?\)\s*$/, '').trim();
      }
      
      books.push({
        title: fullTitle,
        author,
        bookId,
        seriesInfo,
      });
    }
  }
  
  return books;
}

/**
 * Fetch a single shelf page
 */
async function fetchShelfPage(shelf: string, page: number = 1): Promise<ShelfBook[]> {
  await rateLimit();
  
  const url = `${BASE_URL}/shelf/show/${shelf}?page=${page}`;
  console.log(`[GoodreadsShelves] Fetching: ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: { 
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    
    if (!response.ok) {
      console.error(`[GoodreadsShelves] Failed to fetch shelf: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // Check for redirect, empty page, or blocked
    if (html.length < 5000 || html.includes('You are being redirected')) {
      console.warn(`[GoodreadsShelves] Page appears empty or redirected`);
      return [];
    }
    
    if (html.includes('Please sign in') || html.includes('Goodreads requires JavaScript')) {
      console.warn(`[GoodreadsShelves] Blocked or requires sign-in`);
      return [];
    }
    
    return parseShelfPage(html);
  } catch (error) {
    console.error(`[GoodreadsShelves] Error fetching ${url}:`, error);
    return [];
  }
}

/**
 * Scrape a Goodreads shelf and extract unique series
 * Returns a map of series name → { name, books[] }
 */
export async function scrapeShelf(
  shelf: string, 
  maxPages: number = 5,
  onProgress?: (page: number, booksFound: number, seriesFound: number) => void
): Promise<Map<string, { name: string; author: string; books: ShelfBook[] }>> {
  const allBooks: ShelfBook[] = [];
  
  for (let page = 1; page <= maxPages; page++) {
    const books = await fetchShelfPage(shelf, page);
    
    if (books.length === 0) {
      console.log(`[GoodreadsShelves] No more results on page ${page}, stopping.`);
      break;
    }
    
    allBooks.push(...books);
    
    const seriesCount = new Set(allBooks.filter(b => b.seriesInfo).map(b => b.seriesInfo!.name.toLowerCase())).size;
    onProgress?.(page, allBooks.length, seriesCount);
    console.log(`[GoodreadsShelves] Page ${page}: ${books.length} books (${allBooks.length} total, ${seriesCount} unique series)`);
    
    // If we got significantly fewer than expected, probably last page
    if (books.length < 30) break;
  }
  
  // Group by series
  const seriesMap = new Map<string, { name: string; author: string; books: ShelfBook[] }>();
  
  for (const book of allBooks) {
    if (book.seriesInfo) {
      const key = book.seriesInfo.name.toLowerCase();
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          name: book.seriesInfo.name,
          author: book.author,
          books: [],
        });
      }
      seriesMap.get(key)!.books.push(book);
    }
  }
  
  console.log(`[GoodreadsShelves] Shelf "${shelf}": ${allBooks.length} books, ${seriesMap.size} unique series`);
  return seriesMap;
}

/**
 * Scrape all shelves for a genre and return unique series names
 * This is the main entry point for Layer 2 of Combo 1
 */
export async function discoverSeriesFromShelves(
  genre: string,
  maxPagesPerShelf: number = 5,
  onProgress?: (shelf: string, seriesCount: number) => void
): Promise<Array<{ name: string; author: string }>> {
  const shelves = GENRE_SHELF_MAP[genre];
  if (!shelves) {
    console.error(`[GoodreadsShelves] No shelves configured for genre: ${genre}`);
    console.log(`[GoodreadsShelves] Available genres: ${Object.keys(GENRE_SHELF_MAP).join(', ')}`);
    return [];
  }
  
  console.log(`\n[GoodreadsShelves] Discovering ${genre} series from ${shelves.length} shelves...`);
  
  const allSeries = new Map<string, { name: string; author: string }>();
  
  for (const shelf of shelves) {
    console.log(`\n[GoodreadsShelves] ── Shelf: ${shelf} ──`);
    
    const seriesFromShelf = await scrapeShelf(shelf, maxPagesPerShelf);
    
    for (const [key, data] of seriesFromShelf) {
      if (!allSeries.has(key)) {
        allSeries.set(key, { name: data.name, author: data.author });
      }
    }
    
    onProgress?.(shelf, allSeries.size);
    console.log(`[GoodreadsShelves] Running total: ${allSeries.size} unique series`);
    
    // Delay between shelves
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  console.log(`\n[GoodreadsShelves] Total unique series for ${genre}: ${allSeries.size}`);
  return Array.from(allSeries.values());
}

// CLI test
if (process.argv[2] === 'test-shelf') {
  const shelf = process.argv[3] || 'litrpg';
  const pages = parseInt(process.argv[4] || '2');
  console.log(`Testing shelf scrape: ${shelf} (${pages} pages)`);
  
  scrapeShelf(shelf, pages).then(series => {
    console.log(`\nFound ${series.size} unique series:`);
    for (const [, data] of Array.from(series.entries()).slice(0, 20)) {
      console.log(`  - ${data.name} by ${data.author} (${data.books.length} books on shelf)`);
    }
    if (series.size > 20) {
      console.log(`  ... and ${series.size - 20} more`);
    }
  });
}
