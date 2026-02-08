/**
 * LibraryThing Source Fetcher
 * Scrapes series data from LibraryThing (no quota limit)
 * Uses FlareSolverr to bypass Cloudflare protection
 */
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { fetchWithFlaresolverr, checkFlareSolverr } from './flareSolverr.js';
// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 1000 / config.rateLimit.librarything;
async function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastRequest;
    if (elapsed < MIN_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
    }
    lastRequest = Date.now();
}
// Cache FlareSolverr availability
let flareSolverrAvailable = null;
/**
 * Check if we can use FlareSolverr
 */
async function canUseFlareSolverr() {
    if (flareSolverrAvailable === null) {
        flareSolverrAvailable = await checkFlareSolverr();
        console.log(`[LibraryThing] FlareSolverr available: ${flareSolverrAvailable}`);
    }
    return flareSolverrAvailable;
}
/**
 * Fetch series data from LibraryThing series page
 */
export async function fetchSeries(seriesName) {
    try {
        await rateLimit();
        // LibraryThing series URL format
        const encodedName = encodeURIComponent(seriesName.replace(/\s+/g, '_'));
        const url = `https://www.librarything.com/series/${encodedName}`;
        console.log(`[LibraryThing] Fetching series: ${seriesName}`);
        let html;
        // Try FlareSolverr first (needed for Cloudflare)
        if (await canUseFlareSolverr()) {
            const result = await fetchWithFlaresolverr(url);
            if (!result) {
                return {
                    source: 'librarything',
                    series: null,
                    raw: null,
                    error: 'FlareSolverr request failed',
                };
            }
            if (result.status === 404) {
                return {
                    source: 'librarything',
                    series: null,
                    raw: null,
                    error: 'Series not found',
                };
            }
            html = result.html;
        }
        else {
            // Fallback to direct fetch (unlikely to work due to Cloudflare)
            console.warn('[LibraryThing] FlareSolverr not available, trying direct fetch...');
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
            });
            if (!response.ok) {
                if (response.status === 404) {
                    return {
                        source: 'librarything',
                        series: null,
                        raw: null,
                        error: 'Series not found',
                    };
                }
                throw new Error(`HTTP ${response.status} - Cloudflare blocking likely, need FlareSolverr`);
            }
            html = await response.text();
        }
        const series = parseSeriesPage(html, seriesName);
        return {
            source: 'librarything',
            series,
            raw: { url, bookCount: series?.books.length },
        };
    }
    catch (error) {
        console.error(`[LibraryThing] Error fetching ${seriesName}:`, error);
        return {
            source: 'librarything',
            series: null,
            raw: null,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
/**
 * Parse LibraryThing series page HTML
 */
function parseSeriesPage(html, seriesName) {
    const $ = cheerio.load(html);
    const books = [];
    // LibraryThing series pages have books in a table or list
    // The structure varies, so we try multiple selectors
    // Try table format first
    $('table.lt_table tr, table.worksinseries tr').each((_, row) => {
        const $row = $(row);
        // Skip header rows
        if ($row.find('th').length > 0)
            return;
        // Extract position (usually first column)
        const positionText = $row.find('td').first().text().trim();
        const position = parsePosition(positionText);
        // Extract title (usually in a link)
        const $titleLink = $row.find('a[href*="/work/"]').first();
        const title = $titleLink.text().trim();
        // Extract author if available
        const authorText = $row.find('td').eq(2).text().trim() ||
            $row.find('.author, .by').text().trim();
        const author = cleanAuthor(authorText);
        // Extract work ID from URL
        const href = $titleLink.attr('href') || '';
        const workIdMatch = href.match(/\/work\/(\d+)/);
        const sourceId = workIdMatch ? workIdMatch[1] : undefined;
        if (title) {
            books.push({
                title,
                position,
                author,
                sourceId,
            });
        }
    });
    // Try list format if table didn't work
    if (books.length === 0) {
        $('.serieswork, .work-container, li.work').each((index, el) => {
            const $el = $(el);
            const positionText = $el.find('.position, .seriesnum, .number').text().trim() ||
                $el.find('[class*="position"]').text().trim();
            const position = parsePosition(positionText) || (index + 1);
            const $titleLink = $el.find('a[href*="/work/"]').first();
            const title = $titleLink.text().trim() || $el.find('.title').text().trim();
            const author = $el.find('.author, .by').text().replace(/^by\s*/i, '').trim();
            const href = $titleLink.attr('href') || '';
            const workIdMatch = href.match(/\/work\/(\d+)/);
            const sourceId = workIdMatch ? workIdMatch[1] : undefined;
            if (title) {
                books.push({
                    title,
                    position,
                    author: author || undefined,
                    sourceId,
                });
            }
        });
    }
    // Try generic extraction as last resort
    if (books.length === 0) {
        // Look for any links to works
        $('a[href*="/work/"]').each((index, el) => {
            const $el = $(el);
            const title = $el.text().trim();
            // Skip navigation links, headers, etc
            if (title.length < 3 || title.length > 200)
                return;
            if (/^(previous|next|more|see all|view)/i.test(title))
                return;
            const href = $el.attr('href') || '';
            const workIdMatch = href.match(/\/work\/(\d+)/);
            const sourceId = workIdMatch ? workIdMatch[1] : undefined;
            // Avoid duplicates
            if (books.some(b => b.sourceId === sourceId))
                return;
            books.push({
                title,
                position: index + 1,
                sourceId,
            });
        });
    }
    if (books.length === 0) {
        return null;
    }
    // Sort by position
    books.sort((a, b) => (a.position || 999) - (b.position || 999));
    // Extract series author (most common author in books)
    const authorCounts = {};
    for (const book of books) {
        if (book.author) {
            authorCounts[book.author] = (authorCounts[book.author] || 0) + 1;
        }
    }
    const seriesAuthor = Object.entries(authorCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
        name: seriesName,
        author: seriesAuthor,
        books,
    };
}
/**
 * Parse position from text (handles "1", "Book 1", "1.", "1.5", etc)
 */
function parsePosition(text) {
    if (!text)
        return undefined;
    // Extract number from text
    const match = text.match(/(\d+(?:\.\d+)?)/);
    if (match) {
        return parseFloat(match[1]);
    }
    return undefined;
}
/**
 * Clean author name
 */
function cleanAuthor(text) {
    if (!text)
        return undefined;
    // Remove common prefixes
    let cleaned = text
        .replace(/^by\s+/i, '')
        .replace(/^\s*,\s*/, '')
        .trim();
    if (cleaned.length < 2)
        return undefined;
    return cleaned;
}
/**
 * Search for series by genre on LibraryThing
 * Returns list of series names to fetch individually
 */
export async function searchSeriesByGenre(genre, limit = 50) {
    try {
        await rateLimit();
        // LibraryThing tag/genre pages
        const encodedGenre = encodeURIComponent(genre);
        const url = `https://www.librarything.com/tag/${encodedGenre}`;
        console.log(`[LibraryThing] Searching genre: ${genre}`);
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const html = await response.text();
        const $ = cheerio.load(html);
        const seriesNames = [];
        // Look for series links on the page
        $('a[href*="/series/"]').each((_, el) => {
            const name = $(el).text().trim();
            if (name && name.length > 2 && !seriesNames.includes(name)) {
                seriesNames.push(name);
            }
        });
        return seriesNames.slice(0, limit);
    }
    catch (error) {
        console.error(`[LibraryThing] Error searching genre ${genre}:`, error);
        return [];
    }
}
//# sourceMappingURL=librarything.js.map