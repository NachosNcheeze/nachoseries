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
let db = null;
/**
 * Initialize database connection and schema
 */
export function initDatabase() {
    if (db)
        return db;
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
export function getDb() {
    if (!db) {
        return initDatabase();
    }
    return db;
}
/**
 * Close database connection
 */
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
}
/**
 * Normalize text for matching (lowercase, remove punctuation)
 */
export function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Insert or update a series
 */
export function upsertSeries(series) {
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
    stmt.run(id, series.name, normalized, series.author || null, authorNorm, series.genre || null, series.total_books || null, series.year_start || null, series.year_end || null, series.description || null, series.confidence || 0, series.verified ? 1 : 0, series.last_verified || null, series.librarything_id || null, series.openlibrary_key || null, series.isfdb_id || null);
    return id;
}
/**
 * Find series by name (fuzzy match)
 */
export function findSeriesByName(name) {
    const db = getDb();
    const normalized = normalizeText(name);
    const stmt = db.prepare(`
    SELECT * FROM series
    WHERE name_normalized = ?
    LIMIT 1
  `);
    const result = stmt.get(normalized);
    return result || null;
}
/**
 * Get all series for a genre
 */
export function getSeriesByGenre(genre, limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT * FROM series
    WHERE genre = ?
    ORDER BY confidence DESC, total_books DESC
    LIMIT ?
  `);
    return stmt.all(genre, limit);
}
/**
 * Get series needing verification
 */
export function getSeriesNeedingVerification(limit = 50) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT * FROM series
    WHERE confidence < ? AND verified = 0
    ORDER BY confidence ASC
    LIMIT ?
  `);
    return stmt.all(config.confidence.autoAccept, limit);
}
// =============================================================================
// Series Book Operations
// =============================================================================
/**
 * Insert or update a book in a series
 */
export function upsertSeriesBook(book) {
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
    stmt.run(id, book.series_id, book.position || null, book.title, normalized, book.author || null, book.year_published || null, book.ebook_known ? 1 : 0, book.audiobook_known ? 1 : 0, book.openlibrary_key || null, book.librarything_id || null, book.audible_asin || null, book.isbn || null, book.confidence || 0);
    return id;
}
/**
 * Get all books in a series
 */
export function getBooksInSeries(seriesId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT * FROM series_book
    WHERE series_id = ?
    ORDER BY position ASC NULLS LAST
  `);
    return stmt.all(seriesId);
}
// =============================================================================
// Source Data Operations
// =============================================================================
/**
 * Store raw source data for a series
 */
export function storeSourceData(seriesId, source, rawData, bookCount) {
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
/**
 * Get database statistics
 */
export function getStats() {
    const db = getDb();
    const totalSeries = db.prepare('SELECT COUNT(*) as count FROM series').get().count;
    const totalBooks = db.prepare('SELECT COUNT(*) as count FROM series_book').get().count;
    const verifiedSeries = db.prepare('SELECT COUNT(*) as count FROM series WHERE verified = 1').get().count;
    const avgConfidence = db.prepare('SELECT AVG(confidence) as avg FROM series').get().avg || 0;
    const genreCounts = db.prepare(`
    SELECT genre, COUNT(*) as count FROM series
    WHERE genre IS NOT NULL
    GROUP BY genre
  `).all();
    const seriesByGenre = {};
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
//# sourceMappingURL=db.js.map