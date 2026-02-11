/**
 * NachoSeries API Server
 * Simple HTTP API for querying series data
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { 
  initDatabase, 
  closeDatabase, 
  getStats, 
  findSeriesByName, 
  searchSeries as dbSearchSeries,
  getSeriesWithBooks,
  getAllSeries,
  getBooksByGenre,
  countBooksByGenre,
  findSeriesForBook
} from './database/db.js';

const PORT = parseInt(process.env.NACHOSERIES_PORT || '5057');

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify({ error: message }));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // Health check
    if (path === '/health' || path === '/api/health') {
      sendJSON(res, { status: 'ok', service: 'nachoseries' });
      return;
    }

    // Stats
    if (path === '/api/stats') {
      const stats = getStats();
      sendJSON(res, stats);
      return;
    }

    // Search series by name
    if (path === '/api/series/search') {
      const query = url.searchParams.get('q');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      
      if (!query) {
        sendError(res, 'Missing query parameter: q');
        return;
      }
      
      const results = dbSearchSeries(query, limit);
      sendJSON(res, { results, count: results.length });
      return;
    }

    // Get series by exact name
    if (path === '/api/series/byName') {
      const name = url.searchParams.get('name');
      
      if (!name) {
        sendError(res, 'Missing query parameter: name');
        return;
      }
      
      const series = findSeriesByName(name);
      if (!series) {
        sendJSON(res, { found: false, series: null });
        return;
      }
      
      // Get full series with books
      const fullSeries = getSeriesWithBooks(series.id);
      sendJSON(res, { found: true, series: fullSeries });
      return;
    }



    // Find series for a book by title/author
    if (path === '/api/series/for-book') {
      const title = url.searchParams.get('title');
      const author = url.searchParams.get('author') || undefined;
      
      if (!title) {
        sendError(res, 'Missing query parameter: title');
        return;
      }
      
      const result = findSeriesForBook(title, author);
      if (!result) {
        sendJSON(res, { found: false, series: null, book: null });
        return;
      }
      
      sendJSON(res, { found: true, series: result.series, book: result.book });
      return;
    }

    // Get series by ID
    if (path.startsWith('/api/series/')) {
      const id = path.replace('/api/series/', '');
      
      if (!id || id === 'search' || id === 'byName') {
        sendError(res, 'Invalid series ID');
        return;
      }
      
      const series = getSeriesWithBooks(parseInt(id));
      if (!series) {
        sendError(res, 'Series not found', 404);
        return;
      }
      
      sendJSON(res, series);
      return;
    }

    // List all series (paginated)
    if (path === '/api/series') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const genre = url.searchParams.get('genre') || undefined;
      
      const series = getAllSeries(limit, offset, genre);
      const stats = getStats();
      
      sendJSON(res, { 
        series, 
        count: series.length,
        total: stats.totalSeries,
        offset,
        limit
      });
      return;
    }

    // 404 for unknown routes

    // Get books by genre (for series browsing - returns books with series info)
    if (path === '/api/books/genre') {
      const genre = url.searchParams.get('genre');
      const limit = parseInt(url.searchParams.get('limit') || '48');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
      if (!genre) {
        sendError(res, 'Missing query parameter: genre');
        return;
      }
      
      const results = getBooksByGenre(genre, limit, offset);
      const total = countBooksByGenre(genre);
      
      sendJSON(res, { 
        books: results,
        count: results.length,
        total,
        offset,
        limit,
        hasMore: offset + results.length < total
      });
      return;
    }

    sendError(res, 'Not found', 404);
  } catch (error) {
    console.error('[API] Error:', error);
    sendError(res, 'Internal server error', 500);
  }
}

export function startServer(): void {
  initDatabase();
  
  const server = createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                     NACHOSERIES API                            ║');
    console.log(`║                  Running on port ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  GET /api/health         - Health check');
    console.log('  GET /api/stats          - Database statistics');
    console.log('  GET /api/series         - List all series (paginated)');
    console.log('  GET /api/series/search  - Search series by name');
    console.log('  GET /api/series/byName  - Get series by exact name');
    console.log('  GET /api/series/:id     - Get series by ID');
    console.log('');
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close();
    closeDatabase();
    process.exit(0);
  });
}

// Run if called directly
if (process.argv[1]?.endsWith('api.js') || process.argv[1]?.endsWith('api.ts')) {
  startServer();
}
