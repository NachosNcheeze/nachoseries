/**
 * Goodreads List Scraper
 * Scrapes series data from Goodreads curated lists
 * 
 * This imports popular series from curated Goodreads lists to expand
 * our catalog for genres not well-covered by ISFDB.
 */

import type { SourceBook, SourceSeries } from '../types.js';
import { fetchSeriesBooks, searchBookSeries } from './goodreads.js';

const BASE_URL = 'https://www.goodreads.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 2000; // 2 seconds between requests

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

// Genre to Goodreads list mappings
// Format: { genre: [list URLs] }
// Each list can have multiple pages (up to 15), we fetch first 3 by default
export const GENRE_LISTS: Record<string, string[]> = {
  romance: [
    '/list/show/397.Best_Paranormal_Romance_Series',
    '/list/show/12362.All_Time_Favorite_Romance_Novels',
    '/list/show/26547.Best_Contemporary_Romance',
    '/list/show/10762.Best_Book_Boyfriends',
    '/list/show/19106.MUST_READS_',
    '/list/show/5932.Best_Adult_Romance',
    '/list/show/225.Best_Paranormal_Fantasy_Romances',
    '/list/show/7691.Best_Dark_Romance',
    '/list/show/3670.Best_Erotic_Romance',
    '/list/show/4416.Best_Romantic_Suspense',
    '/list/show/21195.Best_Slow_Burn_Romance',
    '/list/show/37.Best_Love_Stories',
  ],
  mystery: [
    '/list/show/11.Best_Crime_Mystery_Books',
    '/list/show/24.Best_Mysteries',
    '/list/show/538.Best_Mystery_Series',
    '/list/show/2122.Best_Detective_Series',
    '/list/show/135.Best_Cozy_Mysteries',
    '/list/show/541.Best_Twists',
    '/list/show/18346.All_Time_Awesome_Books',
    '/list/show/2491.Must_Read_Books_Different_Genres',
    '/list/show/1046.I_Like_Serial_Killers',
    '/list/show/2953.Best_Nordic_Noir',
  ],
  thriller: [
    '/list/show/5.Best_Thrillers',
    '/list/show/109.Best_Thrillers_Ever',
    '/list/show/5162.Best_Suspense_Thriller',
    '/list/show/1294.Best_Psychological_Thrillers',
    '/list/show/47.Best_Serial_Killer_Books',
    '/list/show/541.Best_Twists',
    '/list/show/4416.Best_Romantic_Suspense',
    '/list/show/3308.Best_Legal_Thrillers',
    '/list/show/2669.Books_With_Heroes_Heroines_Who_Are_Assassins',
    '/list/show/15729.Best_Action_Adventure_Thrillers',
  ],
  biography: [
    '/list/show/45.Best_Biographies',
    '/list/show/51.Best_Memoirs',
    '/list/show/281.Best_Memoir_Biography_Autobiography',
    '/list/show/184.Memoirs_by_Women',
    '/list/show/3034.Best_Music_Books',
    '/list/show/1185.Best_Presidential_Biographies',
  ],
  history: [
    '/list/show/1362.Best_History_Books',
    '/list/show/1686.Best_World_History_Books',
    '/list/show/163.Best_Historical_Fiction',
    '/list/show/15.Best_World_War_II_Books',
    '/list/show/62.Best_Feminist_Books',
    '/list/show/20170.Best_True_Crime_History_Books_nonfiction_',
    '/list/show/1840.Best_Post_Apocalyptic_Fiction',
    '/list/show/292.Best_American_History_Books',
  ],
  'true-crime': [
    '/list/show/1422.Best_True_Crime',
    '/list/show/14429.Non_fiction_books_about_Serial_Killers',
    '/list/show/20170.Best_True_Crime_History_Books_nonfiction_',
    '/list/show/122942.Murderino_Reading_List_',
    '/list/show/18866.Kids_Teens_who_kill',
  ],
  'self-help': [
    '/list/show/2787.Best_Self_Help_Books',
    '/list/show/264.Books_That_Will_Change_Your_Life',
    '/list/show/18645.Best_Books_That_Grow_You',
    '/list/show/22543.Best_Inspirational_Self_Help',
    '/list/show/23281.Most_Helpful_Personal_Professional_Self_Help_Books',
    '/list/show/10738.Bestsellers_Self_Help_That_Renew_Recharge_Rejuvenate',
    '/list/show/18042.Best_Self_Help_Spiritual_Motivational_Law_of_Attraction_Books',
  ],
  fiction: [
    '/list/show/264.Books_That_Will_Change_Your_Life',
    '/list/show/1.Best_Books_Ever',
    '/list/show/43.Best_Dystopian_and_Post_Apocalyptic_Fiction',
    '/list/show/3.Best_Science_Fiction_Fantasy_Books',
    '/list/show/211.Best_Time_Travel_Fiction',
    '/list/show/25529.Best_Unknown_but_must_be_Known_books_',
    '/list/show/2700.Science_Fiction_and_Fantasy_Must_Reads',
  ],
  horror: [
    '/list/show/135.Best_Horror_Novels',
    '/list/show/930.Best_Stephen_King_Books',
    '/list/show/1230.Best_Gothic_Books_of_All_Time',
    '/list/show/129.Best_Adult_Vampire_Books',
    '/list/show/1046.I_Like_Serial_Killers',
  ],
  fantasy: [
    '/list/show/3.Best_Science_Fiction_Fantasy_Books',
    '/list/show/50.Best_Epic_Fantasy',
    '/list/show/261.Urban_Fantasy',
    '/list/show/1023.Best_Strong_Female_Fantasy_Novels',
    '/list/show/2700.Science_Fiction_and_Fantasy_Must_Reads',
    '/list/show/12325.S_L_Top_100_Science_Fiction_Fantasy_Titles',
    '/list/show/225.Best_Paranormal_Fantasy_Romances',
  ],
  scifi: [
    '/list/show/3.Best_Science_Fiction_Fantasy_Books',
    '/list/show/19341.Best_Science_Fiction',
    '/list/show/1010.Best_Space_Opera_Science_Fiction',
    '/list/show/1127.Excellent_Space_Opera',
    '/list/show/1301.Best_Science_Fiction_With_a_Female_Protagonist',
    '/list/show/1840.Best_Post_Apocalyptic_Fiction',
    '/list/show/12325.S_L_Top_100_Science_Fiction_Fantasy_Titles',
  ],
};

interface ListBook {
  title: string;
  author: string;
  bookId: string;
  seriesInfo?: {
    name: string;
    position: number;
  };
}

/**
 * Extract book info from a Goodreads list page
 */
function parseListPage(html: string): ListBook[] {
  const books: ListBook[] = [];
  
  // Split by table rows - each book is in a <tr itemscope itemtype="http://schema.org/Book">
  const rows = html.split('<tr itemscope itemtype="http://schema.org/Book">');
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    
    // Extract book ID from /book/show/ID
    const bookMatch = row.match(/\/book\/show\/(\d+)/);
    if (!bookMatch) continue;
    
    // Extract title from itemprop='name' role='heading'
    const titleMatch = row.match(/itemprop='name' role='heading'[^>]*>([^<]+)/);
    if (!titleMatch) continue;
    
    // Extract author from span itemprop="name" inside authorName anchor
    const authorMatch = row.match(/class="authorName"[^>]*>[^<]*<span itemprop="name">([^<]+)/);
    if (!authorMatch) continue;
    
    const bookId = bookMatch[1];
    const fullTitle = titleMatch[1].trim();
    const author = authorMatch[1].trim();
    
    // Try to extract series info from title
    // Patterns: "(Series Name, #1)", "(Series, Book 1)", "(Series #1)"
    const seriesMatch = fullTitle.match(/\(([^,()]+?)(?:,\s*#|\s*#|,\s*Book\s*)(\d+(?:\.\d+)?)\)\s*$/);
    
    let title = fullTitle;
    let seriesInfo: { name: string; position: number } | undefined;
    
    if (seriesMatch) {
      seriesInfo = {
        name: seriesMatch[1].trim(),
        position: parseFloat(seriesMatch[2]),
      };
      // Remove series info from title
      title = fullTitle.replace(/\s*\([^()]+#\d+(?:\.\d+)?\)\s*$/, '').trim();
    }
    
    books.push({
      title,
      author,
      bookId,
      seriesInfo,
    });
  }
  
  return books;
}

/**
 * Fetch a single page from a Goodreads list
 */
async function fetchListPage(listUrl: string, page: number = 1): Promise<ListBook[]> {
  await rateLimit();
  
  const baseUrl = listUrl.startsWith('http') ? listUrl : `${BASE_URL}${listUrl}`;
  const fullUrl = page > 1 ? `${baseUrl}?page=${page}` : baseUrl;
  console.log(`[GoodreadsList] Fetching: ${fullUrl}`);
  
  const response = await fetch(fullUrl, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  
  if (!response.ok) {
    console.error(`[GoodreadsList] Failed to fetch list: ${response.status}`);
    return [];
  }
  
  const html = await response.text();
  
  // Check for redirect or empty page
  if (html.length < 5000 || html.includes('You are being redirected')) {
    console.warn(`[GoodreadsList] Page appears empty or redirected`);
    return [];
  }
  
  return parseListPage(html);
}

/**
 * Fetch a Goodreads list and extract unique series (with pagination)
 */
export async function fetchList(listUrl: string, maxPages: number = 3): Promise<Map<string, { name: string; genre: string; books: ListBook[] }>> {
  const allBooks: ListBook[] = [];
  
  // Fetch pages
  for (let page = 1; page <= maxPages; page++) {
    const books = await fetchListPage(listUrl, page);
    if (books.length === 0) break; // No more pages
    allBooks.push(...books);
    console.log(`[GoodreadsList] Page ${page}: ${books.length} books`);
    
    // If we got less than 100, there's probably no more pages
    if (books.length < 100) break;
  }
  
  console.log(`[GoodreadsList] Total: ${allBooks.length} books`);
  
  // Group by series
  const seriesMap = new Map<string, { name: string; genre: string; books: ListBook[] }>();
  
  for (const book of allBooks) {
    if (book.seriesInfo) {
      const key = book.seriesInfo.name.toLowerCase();
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          name: book.seriesInfo.name,
          genre: '', // Will be set by caller
          books: [],
        });
      }
      seriesMap.get(key)!.books.push(book);
    }
  }
  
  console.log(`[GoodreadsList] Found ${seriesMap.size} unique series`);
  return seriesMap;
}

/**
 * Import series from all lists for a given genre
 */
export async function importGenre(genre: string): Promise<SourceSeries[]> {
  const lists = GENRE_LISTS[genre];
  if (!lists) {
    console.error(`[GoodreadsList] No lists configured for genre: ${genre}`);
    return [];
  }
  
  console.log(`\n[GoodreadsList] Importing ${genre} from ${lists.length} lists...`);
  
  const allSeries = new Map<string, SourceSeries>();
  
  for (const listUrl of lists) {
    const seriesFromList = await fetchList(listUrl);
    
    for (const [key, seriesData] of seriesFromList) {
      if (!allSeries.has(key)) {
        // Convert to SourceSeries format
        const books: SourceBook[] = seriesData.books.map(book => ({
          title: book.title,
          author: book.author,
          position: book.seriesInfo?.position,
          year: undefined,
          isbn: undefined,
        }));
        
        // Sort by position
        books.sort((a, b) => (a.position || 999) - (b.position || 999));
        
        allSeries.set(key, {
          name: seriesData.name,
          author: books[0]?.author || '',
          books,
          sourceId: `goodreads-list-${key}`,
        });
      } else {
        // Merge books from this list
        const existing = allSeries.get(key)!;
        const existingPositions = new Set(existing.books.map(b => b.position));
        
        for (const book of seriesData.books) {
          if (!existingPositions.has(book.seriesInfo?.position)) {
            existing.books.push({
              title: book.title,
              author: book.author,
              position: book.seriesInfo?.position,
            });
          }
        }
        
        // Re-sort
        existing.books.sort((a, b) => (a.position || 999) - (b.position || 999));
      }
    }
  }
  
  console.log(`[GoodreadsList] Total unique series for ${genre}: ${allSeries.size}`);
  return Array.from(allSeries.values());
}

/**
 * Import all genres configured in GENRE_LISTS
 */
export async function importAllGenres(): Promise<Map<string, SourceSeries[]>> {
  const results = new Map<string, SourceSeries[]>();
  
  for (const genre of Object.keys(GENRE_LISTS)) {
    console.log(`\n========================================`);
    console.log(`Importing genre: ${genre}`);
    console.log(`========================================`);
    
    const series = await importGenre(genre);
    results.set(genre, series);
    
    // Longer delay between genres to be respectful
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  return results;
}

// CLI test
if (process.argv[2] === 'test') {
  const genre = process.argv[3] || 'romance';
  console.log(`Testing import for genre: ${genre}`);
  
  importGenre(genre).then(series => {
    console.log(`\nImported ${series.length} series:`);
    for (const s of series.slice(0, 10)) {
      console.log(`  - ${s.name} by ${s.author} (${s.books.length} books)`);
    }
    if (series.length > 10) {
      console.log(`  ... and ${series.length - 10} more`);
    }
  });
}
