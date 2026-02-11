/**
 * NachoSeries Database Operations
 * SQLite database for series data
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

/**
 * Initialize database connection and schema
 */
export function initDatabase(): Database.Database {
  if (db) return db;
  
  db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // Run schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  
  console.log(`[NachoSeries] Database initialized at ${config.database.path}`);
  return db;
}

/**
 * Get database instance
 */
export function getDb(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// =============================================================================
// Series Operations
// =============================================================================

export interface SeriesRecord {
  id: string;
  name: string;
  name_normalized: string;
  author: string | null;
  author_normalized: string | null;
  genre: string | null;
  total_books: number | null;
  year_start: number | null;
  year_end: number | null;
  description: string | null;
  confidence: number;
  verified: boolean;
  last_verified: string | null;
  librarything_id: string | null;
  openlibrary_key: string | null;
  isfdb_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeriesBookRecord {
  id: string;
  series_id: string;
  position: number | null;
  title: string;
  title_normalized: string;
  author: string | null;
  year_published: number | null;
  ebook_known: boolean;
  audiobook_known: boolean;
  openlibrary_key: string | null;
  librarything_id: string | null;
  audible_asin: string | null;
  isbn: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/**
 * Normalize text for matching (lowercase, remove punctuation)
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Insert or update a series
 */
export function upsertSeries(series: Partial<SeriesRecord> & { name: string }): string {
  const db = getDb();
  const id = series.id || randomUUID();
  const normalized = normalizeText(series.name);
  const authorNorm = series.author ? normalizeText(series.author) : null;
  
  const stmt = db.prepare(`
    INSERT INTO series (
      id, name, name_normalized, author, author_normalized, genre,
      total_books, year_start, year_end, description, confidence,
      verified, last_verified, librarything_id, openlibrary_key, isfdb_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      name_normalized = excluded.name_normalized,
      author = COALESCE(excluded.author, author),
      author_normalized = COALESCE(excluded.author_normalized, author_normalized),
      genre = COALESCE(excluded.genre, genre),
      total_books = COALESCE(excluded.total_books, total_books),
      year_start = COALESCE(excluded.year_start, year_start),
      year_end = COALESCE(excluded.year_end, year_end),
      description = COALESCE(excluded.description, description),
      confidence = CASE WHEN excluded.confidence > confidence THEN excluded.confidence ELSE confidence END,
      librarything_id = COALESCE(excluded.librarything_id, librarything_id),
      openlibrary_key = COALESCE(excluded.openlibrary_key, openlibrary_key),
      isfdb_id = COALESCE(excluded.isfdb_id, isfdb_id),
      updated_at = datetime('now')
  `);
  
  stmt.run(
    id,
    series.name,
    normalized,
    series.author || null,
    authorNorm,
    series.genre || null,
    series.total_books || null,
    series.year_start || null,
    series.year_end || null,
    series.description || null,
    series.confidence || 0,
    series.verified ? 1 : 0,
    series.last_verified || null,
    series.librarything_id || null,
    series.openlibrary_key || null,
    series.isfdb_id || null
  );
  
  return id;
}

/**
 * Find series by name (fuzzy match)
 */
export function findSeriesByName(name: string): SeriesRecord | null {
  const db = getDb();
  const normalized = normalizeText(name);
  
  const stmt = db.prepare(`
    SELECT * FROM series
    WHERE name_normalized = ?
    LIMIT 1
  `);
  
  const result = stmt.get(normalized) as SeriesRecord | undefined;
  return result || null;
}

/**
 * Get all series for a genre
 */
export function getSeriesByGenre(genre: string, limit = 100): SeriesRecord[] {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM series
    WHERE genre = ?
    ORDER BY confidence DESC, total_books DESC
    LIMIT ?
  `);
  
  return stmt.all(genre, limit) as SeriesRecord[];
}

/**
 * Get series needing verification
 */
export function getSeriesNeedingVerification(limit = 50): SeriesRecord[] {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM series
    WHERE confidence < ? AND verified = 0
    ORDER BY confidence ASC
    LIMIT ?
  `);
  
  return stmt.all(config.confidence.autoAccept, limit) as SeriesRecord[];
}

// =============================================================================
// Series Book Operations
// =============================================================================

/**
 * Insert or update a book in a series
 */
export function upsertSeriesBook(book: Partial<SeriesBookRecord> & { series_id: string; title: string }): string {
  const db = getDb();
  const id = book.id || randomUUID();
  const normalized = normalizeText(book.title);
  
  const stmt = db.prepare(`
    INSERT INTO series_book (
      id, series_id, position, title, title_normalized, author,
      year_published, ebook_known, audiobook_known,
      openlibrary_key, librarything_id, audible_asin, isbn, confidence
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      position = COALESCE(excluded.position, position),
      title = excluded.title,
      title_normalized = excluded.title_normalized,
      author = COALESCE(excluded.author, author),
      year_published = COALESCE(excluded.year_published, year_published),
      ebook_known = MAX(ebook_known, excluded.ebook_known),
      audiobook_known = MAX(audiobook_known, excluded.audiobook_known),
      openlibrary_key = COALESCE(excluded.openlibrary_key, openlibrary_key),
      librarything_id = COALESCE(excluded.librarything_id, librarything_id),
      audible_asin = COALESCE(excluded.audible_asin, audible_asin),
      isbn = COALESCE(excluded.isbn, isbn),
      confidence = CASE WHEN excluded.confidence > confidence THEN excluded.confidence ELSE confidence END,
      updated_at = datetime('now')
  `);
  
  stmt.run(
    id,
    book.series_id,
    book.position || null,
    book.title,
    normalized,
    book.author || null,
    book.year_published || null,
    book.ebook_known ? 1 : 0,
    book.audiobook_known ? 1 : 0,
    book.openlibrary_key || null,
    book.librarything_id || null,
    book.audible_asin || null,
    book.isbn || null,
    book.confidence || 0
  );
  
  return id;
}

/**
 * Get all books in a series
 */
export function getBooksInSeries(seriesId: string): SeriesBookRecord[] {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT * FROM series_book
    WHERE series_id = ?
    ORDER BY position ASC NULLS LAST
  `);
  
  return stmt.all(seriesId) as SeriesBookRecord[];
}

// =============================================================================
// Source Data Operations
// =============================================================================

/**
 * Store raw source data for a series
 */
export function storeSourceData(
  seriesId: string,
  source: string,
  rawData: unknown,
  bookCount: number
): void {
  const db = getDb();
  const id = randomUUID();
  
  const stmt = db.prepare(`
    INSERT INTO source_data (id, series_id, source, raw_data, book_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      raw_data = excluded.raw_data,
      book_count = excluded.book_count,
      fetched_at = datetime('now')
  `);
  
  stmt.run(id, seriesId, source, JSON.stringify(rawData), bookCount);
}

// =============================================================================
// Statistics
// =============================================================================

export interface DatabaseStats {
  totalSeries: number;
  totalBooks: number;
  verifiedSeries: number;
  seriesByGenre: Record<string, number>;
  avgConfidence: number;
}

/**
 * Get database statistics
 */
export function getStats(): DatabaseStats {
  const db = getDb();
  
  const totalSeries = (db.prepare('SELECT COUNT(*) as count FROM series').get() as { count: number }).count;
  const totalBooks = (db.prepare('SELECT COUNT(*) as count FROM series_book').get() as { count: number }).count;
  const verifiedSeries = (db.prepare('SELECT COUNT(*) as count FROM series WHERE verified = 1').get() as { count: number }).count;
  const avgConfidence = (db.prepare('SELECT AVG(confidence) as avg FROM series').get() as { avg: number | null }).avg || 0;
  
  const genreCounts = db.prepare(`
    SELECT genre, COUNT(*) as count FROM series
    WHERE genre IS NOT NULL
    GROUP BY genre
  `).all() as Array<{ genre: string; count: number }>;
  
  const seriesByGenre: Record<string, number> = {};
  for (const row of genreCounts) {
    seriesByGenre[row.genre] = row.count;
  }
  
  return {
    totalSeries,
    totalBooks,
    verifiedSeries,
    seriesByGenre,
    avgConfidence,
  };
}

/**
 * Search series by name (partial match)
 */
export function searchSeries(query: string, limit = 20): SeriesRecord[] {
  const db = getDb();
  const normalizedQuery = `%${normalizeText(query)}%`;
  
  const stmt = db.prepare(`
    SELECT * FROM series 
    WHERE name_normalized LIKE ?
    ORDER BY confidence DESC, total_books DESC
    LIMIT ?
  `);
  
  return stmt.all(normalizedQuery, limit) as SeriesRecord[];
}

/**
 * Get series with all its books
 */
export function getSeriesWithBooks(seriesId: number | string): { series: SeriesRecord; books: SeriesBookRecord[] } | null {
  const db = getDb();
  
  const seriesStmt = db.prepare('SELECT * FROM series WHERE id = ?');
  const series = seriesStmt.get(seriesId) as SeriesRecord | undefined;
  
  if (!series) {
    return null;
  }
  
  const books = getBooksInSeries(series.id);
  
  return { series, books };
}

/**
 * Get all series with optional filtering and pagination
 */
export function getAllSeries(limit = 50, offset = 0, genre?: string): SeriesRecord[] {
  const db = getDb();
  
  let sql = 'SELECT * FROM series';
  const params: (string | number)[] = [];
  
  if (genre) {
    sql += ' WHERE genre = ?';
    params.push(genre);
  }
  
  sql += ' ORDER BY confidence DESC, total_books DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as SeriesRecord[];
}

/**
 * Get books by genre with their series info (for genre browsing)
 */
export function getBooksByGenre(genre: string, limit = 48, offset = 0): Array<{ book: SeriesBookRecord; series: SeriesRecord }> {
  const db = getDb();
  
  const stmt = db.prepare(`
    SELECT 
      b.*,
      s.id as s_id,
      s.name as s_name,
      s.name_normalized as s_name_normalized,
      s.author as s_author,
      s.author_normalized as s_author_normalized,
      s.genre as s_genre,
      s.total_books as s_total_books,
      s.year_start as s_year_start,
      s.year_end as s_year_end,
      s.description as s_description,
      s.confidence as s_confidence,
      s.verified as s_verified,
      s.isfdb_id as s_isfdb_id,
      s.librarything_id as s_librarything_id,
      s.openlibrary_key as s_openlibrary_key
    FROM series_book b
    JOIN series s ON b.series_id = s.id
    WHERE s.genre = ?
    ORDER BY s.confidence DESC, s.name ASC, b.position ASC
    LIMIT ? OFFSET ?
  `);
  
  const rows = stmt.all(genre, limit, offset) as any[];
  
  return rows.map(row => ({
    book: {
      id: row.id,
      series_id: row.series_id,
      position: row.position,
      title: row.title,
      title_normalized: row.title_normalized,
      author: row.author,
      year_published: row.year_published,
      ebook_known: row.ebook_known,
      audiobook_known: row.audiobook_known,
      openlibrary_key: row.openlibrary_key,
      librarything_id: row.librarything_id,
      audible_asin: row.audible_asin,
      isbn: row.isbn,
      confidence: row.confidence,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as SeriesBookRecord,
    series: {
      id: row.s_id,
      name: row.s_name,
      name_normalized: row.s_name_normalized,
      author: row.s_author,
      author_normalized: row.s_author_normalized,
      genre: row.s_genre,
      total_books: row.s_total_books,
      year_start: row.s_year_start,
      year_end: row.s_year_end,
      description: row.s_description,
      confidence: row.s_confidence,
      verified: row.s_verified,
      isfdb_id: row.s_isfdb_id,
      librarything_id: row.s_librarything_id,
      openlibrary_key: row.s_openlibrary_key,
    } as SeriesRecord,
  }));
}

/**
 * Count total books in a genre
 */
export function countBooksByGenre(genre: string): number {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM series_book b
    JOIN series s ON b.series_id = s.id
    WHERE s.genre = ?
  `);
  return (stmt.get(genre) as { count: number }).count;
}

/**
 * Find series containing a book by title (and optionally author)
 * Returns the series info and book position if found
 */
export function findSeriesForBook(
  title: string, 
  author?: string
): { series: SeriesRecord; book: SeriesBookRecord } | null {
  const db = getDb();
  const normalizedTitle = normalizeText(title);
  
  // Try exact title match first
  let stmt = db.prepare(`
    SELECT 
      b.*,
      s.id as s_id,
      s.name as s_name,
      s.name_normalized as s_name_normalized,
      s.author as s_author,
      s.author_normalized as s_author_normalized,
      s.genre as s_genre,
      s.total_books as s_total_books,
      s.year_start as s_year_start,
      s.year_end as s_year_end,
      s.description as s_description,
      s.confidence as s_confidence,
      s.verified as s_verified,
      s.isfdb_id as s_isfdb_id,
      s.librarything_id as s_librarything_id,
      s.openlibrary_key as s_openlibrary_key
    FROM series_book b
    JOIN series s ON b.series_id = s.id
    WHERE b.title_normalized = ?
    ORDER BY s.confidence DESC
    LIMIT 1
  `);
  
  let row = stmt.get(normalizedTitle) as any;
  
  // If not found and author provided, try fuzzy title + author match
  if (!row && author) {
    const normalizedAuthor = normalizeText(author);
    stmt = db.prepare(`
      SELECT 
        b.*,
        s.id as s_id,
        s.name as s_name,
        s.name_normalized as s_name_normalized,
        s.author as s_author,
        s.author_normalized as s_author_normalized,
        s.genre as s_genre,
        s.total_books as s_total_books,
        s.year_start as s_year_start,
        s.year_end as s_year_end,
        s.description as s_description,
        s.confidence as s_confidence,
        s.verified as s_verified,
        s.isfdb_id as s_isfdb_id,
        s.librarything_id as s_librarything_id,
        s.openlibrary_key as s_openlibrary_key
      FROM series_book b
      JOIN series s ON b.series_id = s.id
      WHERE b.title_normalized LIKE ?
        AND (b.author LIKE ? OR s.author_normalized LIKE ?)
      ORDER BY s.confidence DESC
      LIMIT 1
    `);
    row = stmt.get(`%${normalizedTitle}%`, `%${normalizedAuthor}%`, `%${normalizedAuthor}%`) as any;
  }
  
  // Still not found, try fuzzy title only
  if (!row) {
    stmt = db.prepare(`
      SELECT 
        b.*,
        s.id as s_id,
        s.name as s_name,
        s.name_normalized as s_name_normalized,
        s.author as s_author,
        s.author_normalized as s_author_normalized,
        s.genre as s_genre,
        s.total_books as s_total_books,
        s.year_start as s_year_start,
        s.year_end as s_year_end,
        s.description as s_description,
        s.confidence as s_confidence,
        s.verified as s_verified,
        s.isfdb_id as s_isfdb_id,
        s.librarything_id as s_librarything_id,
        s.openlibrary_key as s_openlibrary_key
      FROM series_book b
      JOIN series s ON b.series_id = s.id
      WHERE b.title_normalized LIKE ?
      ORDER BY s.confidence DESC
      LIMIT 1
    `);
    row = stmt.get(`%${normalizedTitle}%`) as any;
  }
  
  if (!row) return null;
  
  return {
    book: {
      id: row.id,
      series_id: row.series_id,
      position: row.position,
      title: row.title,
      title_normalized: row.title_normalized,
      author: row.author,
      year_published: row.year_published,
      ebook_known: row.ebook_known,
      audiobook_known: row.audiobook_known,
      openlibrary_key: row.openlibrary_key,
      librarything_id: row.librarything_id,
      audible_asin: row.audible_asin,
      isbn: row.isbn,
      confidence: row.confidence,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as SeriesBookRecord,
    series: {
      id: row.s_id,
      name: row.s_name,
      name_normalized: row.s_name_normalized,
      author: row.s_author,
      author_normalized: row.s_author_normalized,
      genre: row.s_genre,
      total_books: row.s_total_books,
      year_start: row.s_year_start,
      year_end: row.s_year_end,
      description: row.s_description,
      confidence: row.s_confidence,
      verified: row.s_verified,
      isfdb_id: row.s_isfdb_id,
      librarything_id: row.s_librarything_id,
      openlibrary_key: row.s_openlibrary_key,
    } as SeriesRecord,
  };
}
