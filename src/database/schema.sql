-- Boundless Database Schema
-- Series database for Bookarr

-- Series table
CREATE TABLE IF NOT EXISTS series (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,        -- lowercase, no punctuation for matching
  author          TEXT,
  author_normalized TEXT,
  genre           TEXT,
  total_books     INTEGER,
  year_start      INTEGER,
  year_end        INTEGER,
  description     TEXT,
  
  -- Confidence and verification
  confidence      REAL DEFAULT 0.0,     -- 0.0-1.0
  verified        INTEGER DEFAULT 0,    -- boolean
  last_verified   TEXT,                 -- ISO datetime
  
  -- External IDs
  librarything_id TEXT,
  openlibrary_key TEXT,
  isfdb_id        TEXT,
  
  -- Hierarchy (self-referencing parent)
  parent_series_id TEXT,              -- FK to series(id) for sub-series

  -- Timestamps
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  
  FOREIGN KEY (parent_series_id) REFERENCES series(id) ON DELETE SET NULL
);

-- Books in series
CREATE TABLE IF NOT EXISTS series_book (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL,
  position        REAL,                 -- Supports 1.5 for novellas
  title           TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  author          TEXT,
  year_published  INTEGER,
  
  -- Format availability
  ebook_known     INTEGER DEFAULT 0,    -- boolean
  audiobook_known INTEGER DEFAULT 0,    -- boolean
  
  -- Description (enriched from Google Books)
  description     TEXT,
  description_checked_at TEXT,   -- When we last tried to find a description
  
  -- External IDs
  openlibrary_key TEXT,
  librarything_id TEXT,
  audible_asin    TEXT,
  isbn            TEXT,
  
  -- Confidence
  confidence      REAL DEFAULT 0.0,
  
  -- Timestamps
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  UNIQUE(series_id, title_normalized)
);

-- Source data tracking (raw data from each source)
CREATE TABLE IF NOT EXISTS source_data (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL,
  source          TEXT NOT NULL,        -- 'librarything', 'openlibrary', 'isfdb', 'talpa'
  raw_data        TEXT,                 -- JSON blob
  book_count      INTEGER,
  fetched_at      TEXT DEFAULT (datetime('now')),
  
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);

-- Discrepancy log (for Talpa resolution)
CREATE TABLE IF NOT EXISTS discrepancy (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL,
  field           TEXT NOT NULL,        -- 'book_count', 'book_order', 'title', etc.
  source_a        TEXT NOT NULL,
  value_a         TEXT,
  source_b        TEXT NOT NULL,
  value_b         TEXT,
  resolved        INTEGER DEFAULT 0,    -- boolean
  resolution      TEXT,                 -- 'a', 'b', 'manual', or resolved value
  resolved_by     TEXT,                 -- 'talpa', 'manual'
  created_at      TEXT DEFAULT (datetime('now')),
  resolved_at     TEXT,
  
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);

-- Crawl history
CREATE TABLE IF NOT EXISTS crawl_log (
  id              TEXT PRIMARY KEY,
  genre           TEXT,
  started_at      TEXT DEFAULT (datetime('now')),
  completed_at    TEXT,
  series_found    INTEGER DEFAULT 0,
  series_added    INTEGER DEFAULT 0,
  series_updated  INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'running'  -- 'running', 'completed', 'failed'
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_series_name ON series(name_normalized);
CREATE INDEX IF NOT EXISTS idx_series_author ON series(author_normalized);
CREATE INDEX IF NOT EXISTS idx_series_genre ON series(genre);
CREATE INDEX IF NOT EXISTS idx_series_confidence ON series(confidence);
CREATE INDEX IF NOT EXISTS idx_series_book_series ON series_book(series_id);
CREATE INDEX IF NOT EXISTS idx_series_book_position ON series_book(series_id, position);
CREATE INDEX IF NOT EXISTS idx_source_data_series ON source_data(series_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_unresolved ON discrepancy(resolved) WHERE resolved = 0;
CREATE INDEX IF NOT EXISTS idx_series_parent ON series(parent_series_id);
