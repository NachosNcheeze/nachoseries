/**
 * Open Library Source Fetcher
 * Uses Open Library API for series data
 */
import { config } from '../config.js';
// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 1000 / config.rateLimit.openLibrary;
async function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastRequest;
    if (elapsed < MIN_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
    }
    lastRequest = Date.now();
}
/**
 * Fetch series data from Open Library
 * Note: Open Library doesn't have a direct series API, so we search and aggregate
 */
export async function fetchSeries(seriesName) {
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
        const data = await response.json();
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
            if (doc.series?.some(s => s.toLowerCase().includes(seriesName.toLowerCase()) ||
                seriesName.toLowerCase().includes(s.toLowerCase()))) {
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
        const books = seriesBooks.map((doc, index) => ({
            title: doc.title,
            position: index + 1, // Open Library doesn't reliably provide position
            author: doc.author_name?.[0],
            yearPublished: doc.first_publish_year,
            sourceId: doc.key,
        }));
        // Get most common author
        const authorCounts = {};
        for (const doc of seriesBooks) {
            if (doc.author_name?.[0]) {
                const author = doc.author_name[0];
                authorCounts[author] = (authorCounts[author] || 0) + 1;
            }
        }
        const seriesAuthor = Object.entries(authorCounts)
            .sort((a, b) => b[1] - a[1])[0]?.[0];
        const series = {
            name: seriesName,
            author: seriesAuthor,
            books,
        };
        return {
            source: 'openlibrary',
            series,
            raw: data,
        };
    }
    catch (error) {
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
export async function fetchWork(workKey) {
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
        return await response.json();
    }
    catch (error) {
        console.error(`[OpenLibrary] Error fetching work ${workKey}:`, error);
        return null;
    }
}
/**
 * Search for series in a genre
 */
export async function searchSeriesByGenre(genre, limit = 50) {
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
        const data = await response.json();
        // Extract unique series names
        const seriesNames = new Set();
        for (const work of data.works || []) {
            if (work.series) {
                for (const s of work.series) {
                    seriesNames.add(s);
                }
            }
        }
        return Array.from(seriesNames).slice(0, limit);
    }
    catch (error) {
        console.error(`[OpenLibrary] Error searching genre ${genre}:`, error);
        return [];
    }
}
//# sourceMappingURL=openLibrary.js.map