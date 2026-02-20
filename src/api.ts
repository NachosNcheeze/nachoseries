/**
 * NachoSeries API Server
 * Simple HTTP API for querying series data
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { fork, ChildProcess } from 'child_process';
import { URL } from 'url';
import { fileURLToPath } from 'url';
import path from 'path';
import { 
  initDatabase, 
  closeDatabase, 
  getStats, 
  findSeriesByName, 
  searchSeries as dbSearchSeries,
  getSeriesWithBooks,
  getSeriesWithChildren,
  getChildSeries,
  getAllSeries,
  getBooksByGenre,
  countBooksByGenre,
  findSeriesForBook,
  findSeriesByBookTitle,
  saveSourceSeries,
  checkDatabaseHealth,
  unifiedSearch,
  lookupBookDescription,
  getDescriptionStats,
} from './database/db.js';
import { fetchSeries as fetchGoodreadsSeries } from './sources/goodreads.js';
import { initQuotaTable, getAllQuotas, getQuotaUsage, useQuota, secondsUntilReset } from './quotas.js';
import { olCircuitBreaker } from './circuitBreaker.js';

const PORT = parseInt(process.env.NACHOSERIES_PORT || '5057');
const startedAt = new Date().toISOString();

// CORS headers for cross-origin requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const requestStart = Date.now();

  // Log request (skip health checks to reduce noise)
  const isHealthCheck = path === '/health' || path === '/api/health';

  try {
    // Health check — verifies DB connectivity
    if (path === '/health' || path === '/api/health') {
      const dbHealth = checkDatabaseHealth();
      const uptimeMs = Date.now() - new Date(startedAt).getTime();
      const status = dbHealth.ok ? 'ok' : 'degraded';
      const httpStatus = dbHealth.ok ? 200 : 503;
      sendJSON(res, {
        status,
        service: 'nachoseries',
        uptime: Math.floor(uptimeMs / 1000),
        startedAt,
        database: dbHealth.details,
      }, httpStatus);
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

    // Unified search: series names + book titles
    if (path === '/api/search') {
      const query = url.searchParams.get('q');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      
      if (!query) {
        sendError(res, 'Missing query parameter: q');
        return;
      }
      
      const results = unifiedSearch(query, limit);
      sendJSON(res, {
        seriesMatches: results.seriesMatches,
        bookMatches: results.bookMatches,
        totalMatches: results.seriesMatches.length + results.bookMatches.length,
      });
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
      
      // Get full series with books and sub-series hierarchy
      const fullSeries = getSeriesWithChildren(series.id);
      sendJSON(res, { found: true, series: fullSeries });
      return;
    }

    // On-demand lookup: check local DB first, then Goodreads, cache result
    if (path === '/api/lookup') {
      const title = url.searchParams.get('title');
      const author = url.searchParams.get('author') || undefined;
      
      if (!title) {
        sendError(res, 'Missing query parameter: title');
        return;
      }
      
      console.log(`[API] Lookup request: "${title}"${author ? ` by ${author}` : ''}`);
      
      // Step 1: Check local database first
      const localResult = findSeriesByBookTitle(title, author);
      if (localResult) {
        console.log(`[API] Found in local DB: "${localResult.series.name}"`);
        const fullSeries = getSeriesWithBooks(localResult.series.id);
        sendJSON(res, { 
          found: true, 
          source: 'cache',
          series: fullSeries, 
          book: localResult.book 
        });
        return;
      }
      
      // Step 2: Not in local DB, try Goodreads
      console.log(`[API] Not in local DB, querying Goodreads...`);
      try {
        const goodreadsResult = await fetchGoodreadsSeries(title, author);
        
        if (goodreadsResult && goodreadsResult.books.length > 0) {
          // Save to database (cache it)
          const seriesId = saveSourceSeries(goodreadsResult, goodreadsResult.sourceId);
          
          // Return the newly cached series
          const fullSeries = getSeriesWithBooks(seriesId);
          const book = findSeriesByBookTitle(title, author);
          
          sendJSON(res, { 
            found: true, 
            source: 'goodreads',
            series: fullSeries, 
            book: book?.book || null 
          });
          return;
        }
        
        // Not found anywhere
        console.log(`[API] Not found on Goodreads either`);
        sendJSON(res, { found: false, source: 'none', series: null, book: null });
        return;
        
      } catch (error) {
        console.error(`[API] Goodreads lookup failed:`, error);
        sendJSON(res, { found: false, source: 'error', series: null, book: null, error: 'Goodreads lookup failed' });
        return;
      }
    }

    // Find series for a book by title/author (local DB only, no external lookup)
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

    // Look up a book description by title+author
    if (path === '/api/books/description') {
      const title = url.searchParams.get('title');
      const author = url.searchParams.get('author') || undefined;
      
      if (!title) {
        sendError(res, 'Missing query parameter: title');
        return;
      }
      
      const result = lookupBookDescription(title, author);
      if (!result) {
        sendJSON(res, { found: false, description: null });
        return;
      }
      
      sendJSON(res, { 
        found: true, 
        description: result.description,
        bookTitle: result.bookTitle,
        seriesName: result.seriesName,
      });
      return;
    }

    // Description enrichment stats
    if (path === '/api/books/description-stats') {
      const stats = getDescriptionStats();
      sendJSON(res, stats);
      return;
    }

    // Get series by ID
    if (path.startsWith('/api/series/')) {
      const id = path.replace('/api/series/', '');
      
      if (!id || id === 'search' || id === 'byName') {
        sendError(res, 'Invalid series ID');
        return;
      }
      
      const series = getSeriesWithChildren(parseInt(id));
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

    // --- Quota API ---

    // GET /api/quotas — get all quota statuses + circuit breaker state
    if (path === '/api/quotas' && req.method === 'GET') {
      const quotas = getAllQuotas();
      const resetIn = secondsUntilReset();
      const olBreaker = olCircuitBreaker.getStatus();
      sendJSON(res, { quotas, resetInSeconds: resetIn, circuitBreaker: { openLibrary: olBreaker } });
      return;
    }

    // POST /api/quotas/use?service=google-books&count=1 — record external usage (from NachoReads)
    if (path === '/api/quotas/use' && req.method === 'POST') {
      const service = url.searchParams.get('service');
      const count = parseInt(url.searchParams.get('count') || '1');
      if (!service) {
        sendError(res, 'Missing query parameter: service');
        return;
      }
      const allowed = useQuota(service, count);
      const updated = getQuotaUsage(service);
      sendJSON(res, { allowed, ...updated });
      return;
    }

    // GET /api/quotas/check?service=google-books — check if quota available (NachoReads pre-check)
    if (path === '/api/quotas/check' && req.method === 'GET') {
      const service = url.searchParams.get('service');
      if (!service) {
        sendError(res, 'Missing query parameter: service');
        return;
      }
      const quota = getQuotaUsage(service);
      sendJSON(res, quota);
      return;
    }

    sendError(res, 'Not found', 404);
  } catch (error) {
    console.error('[API] Error:', error);
    sendError(res, 'Internal server error', 500);
  } finally {
    if (!isHealthCheck) {
      const elapsed = Date.now() - requestStart;
      console.log(`[API] ${req.method} ${path} — ${res.statusCode} (${elapsed}ms)`);
    }
  }
}

export function startServer(): void {
  initDatabase();
  initQuotaTable();
  
  const server = createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                     NACHOSERIES API                            ║');
    console.log(`║                  Running on port ${PORT}                          ║`);
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Endpoints:');
    console.log('  GET /api/health              - Health check');
    console.log('  GET /api/stats               - Database statistics');
    console.log('  GET /api/lookup              - On-demand lookup (DB + Goodreads fallback)');
    console.log('  GET /api/series              - List all series (paginated)');
    console.log('  GET /api/search              - Unified search (series names + book titles)');
    console.log('  GET /api/series/search       - Search series by name');
    console.log('  GET /api/series/byName       - Get series by exact name');
    console.log('  GET /api/series/for-book     - Find series for a book title');
    console.log('  GET /api/series/:id          - Get series by ID (includes children & parent)');
    console.log('  GET /api/books/description   - Look up book description by title+author');
    console.log('  GET /api/books/description-stats - Description enrichment statistics');
    console.log('');

    // Auto-enrich: spawn enrichment process if AUTO_ENRICH env is set
    if (process.env.AUTO_ENRICH === 'true' || process.env.AUTO_ENRICH === '1') {
      spawnAutoEnrich();
    }
  });

  // Auto-enrich child process management
  let autoEnrichChild: ChildProcess | null = null;

  function spawnAutoEnrich() {
    // Resolve the index.js path relative to this file
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.join(thisDir, 'index.js');
    
    const args = ['auto-enrich'];
    // Pass through optional config from env
    if (process.env.AUTO_ENRICH_MODE === 'books-only') args.push('--books-only');
    if (process.env.AUTO_ENRICH_MODE === 'series-only') args.push('--series-only');
    if (process.env.AUTO_ENRICH_GENRE) args.push(`--genre=${process.env.AUTO_ENRICH_GENRE}`);
    
    console.log(`[API] Starting auto-enrich child process: node ${indexPath} ${args.join(' ')}`);
    
    autoEnrichChild = fork(indexPath, args, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env },
    });
    
    autoEnrichChild.on('exit', (code, signal) => {
      console.log(`[API] Auto-enrich process exited (code=${code}, signal=${signal})`);
      autoEnrichChild = null;

      // Auto-restart after 60s unless it was a clean exit (code 0) or intentional kill
      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        console.log('[API] Auto-enrich will restart in 60 seconds...');
        setTimeout(() => {
          if (!autoEnrichChild) spawnAutoEnrich();
        }, 60000);
      }
    });
    
    autoEnrichChild.on('error', (err) => {
      console.error('[API] Auto-enrich process error:', err.message);
      autoEnrichChild = null;
    });
  }

  // Graceful shutdown (SIGINT for terminal, SIGTERM for Docker)
  const shutdown = (signal: string) => {
    console.log(`\n[API] Shutting down (${signal})...`);
    // Kill auto-enrich child if running
    if (autoEnrichChild) {
      console.log('[API] Stopping auto-enrich child process...');
      autoEnrichChild.kill('SIGTERM');
      autoEnrichChild = null;
    }
    server.close(() => {
      closeDatabase();
      console.log('[API] Shutdown complete');
      process.exit(0);
    });
    // Force exit after 10s if connections are hanging
    setTimeout(() => {
      console.error('[API] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Crash handlers
  process.on('uncaughtException', (error) => {
    console.error('[API] UNCAUGHT EXCEPTION:', error);
    shutdown('uncaughtException');
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error('[API] UNHANDLED REJECTION:', reason);
    // Don't exit on unhandled rejections — log and continue
  });
}

// Run if called directly
if (process.argv[1]?.endsWith('api.js') || process.argv[1]?.endsWith('api.ts')) {
  startServer();
}
