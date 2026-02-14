# NachoSeries Architecture

> **Last Updated:** 2026-02-13  
> **Version:** 0.1.0  
> **Stack:** TypeScript · Node.js · SQLite (better-sqlite3) · Raw HTTP Server

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Database Schema & Storage](#3-database-schema--storage)
4. [Data Sources](#4-data-sources)
5. [Scaling Strategy (Combo 1)](#5-scaling-strategy-combo-1)
6. [Genre Detection Pipeline](#6-genre-detection-pipeline)
7. [Confidence Scoring & Reconciliation](#7-confidence-scoring--reconciliation)
8. [API Layer](#8-api-layer)
9. [CLI Commands & Operations](#9-cli-commands--operations)
10. [Data Quality & Accuracy](#10-data-quality--accuracy)
11. [Resilience & Error Handling](#11-resilience--error-handling)
12. [Integration with NachoReads](#12-integration-with-nachoreads)
13. [Current Database Statistics](#13-current-database-statistics)
14. [Known Limitations](#14-known-limitations)
15. [File Reference](#15-file-reference)

---

## 1. System Overview

NachoSeries is a **standalone book series database service** that aggregates, reconciles, and serves book series data to NachoReads. It operates as an independent service (not containerized) running on port **5057**, providing a REST API for series lookups, genre browsing, and on-demand enrichment.

### Core Design Principles

- **Multi-source aggregation**: Pulls data from ISFDB (primary), Goodreads (on-demand + shelves), Goodreads curated lists (genre expansion), Google Books (enrichment), seed files (curated series names), and Open Library (genre lookup).
- **Three-layer scaling strategy (Combo 1)**: Layer 1 = Curated seed files → Goodreads lookup; Layer 2 = Goodreads shelf scraping → bulk discovery; Layer 3 = Google Books API → descriptions, ISBNs, metadata enrichment.
- **Confidence scoring**: Every series and book has a confidence value (0.0–2.0+) reflecting data reliability.
- **On-demand caching**: When NachoReads queries for a book not in the local DB, NachoSeries fetches from Goodreads, caches it, and returns the result — future requests are served from cache.
- **English-only**: All series pass through a language filter to maintain an English-only database.
- **Genre-tagged**: Series are tagged with genres through a multi-strategy pipeline (ISFDB tags → name analysis → Open Library subjects).

### High-Level Architecture

```
┌─────────────┐          ┌──────────────────────────────────────────────────┐
│  NachoReads │ ──HTTP──▶│                  NachoSeries                      │
│  (Frontend) │          │               API Server :5057                    │
└─────────────┘          │                                                  │
                         │  ┌─────────┐   ┌──────────────────────────────┐  │
                         │  │ SQLite   │   │       Data Sources           │  │
                         │  │ Database │   │  ┌──────────┐ ┌──────────┐  │  │
                         │  │ (43 MB)  │   │  │  ISFDB   │ │Goodreads │  │  │
                         │  │          │   │  │ (primary)│ │(on-demand)│  │  │
                         │  │ 18,840+  │   │  ├──────────┤ ├──────────┤  │  │
                         │  │ series   │   │  │Goodreads │ │  Google  │  │  │
                         │  │ 93,700+  │   │  │ Shelves  │ │  Books   │  │  │
                         │  │ books    │   │  │(discover)│ │ (enrich) │  │  │
                         │  │          │   │  ├──────────┤ ├──────────┤  │  │
                         │  │ Desc: ✅ │   │  │  Seed    │ │  Open    │  │  │
                         │  │          │   │  │  Files   │ │ Library  │  │  │
                         │  └─────────┘   │  └──────────┘ └──────────┘  │  │
                         │                 └──────────────────────────────┘  │
                         └──────────────────────────────────────────────────┘
```

---

## 2. Technology Stack

| Component       | Technology                                             |
| --------------- | ------------------------------------------------------ |
| Language        | TypeScript (ES modules, Node.js)                       |
| Database        | SQLite via `better-sqlite3` (synchronous, WAL mode)    |
| HTTP Server     | Raw Node.js `http.createServer()` — no Express         |
| HTML Parsing    | `cheerio` (for ISFDB and Goodreads scraping)           |
| Fuzzy Matching  | `string-similarity` (Dice coefficient)                 |
| Cloudflare      | FlareSolverr proxy (for Cloudflare-protected sites)    |
| Language Filter | Custom regex-based detection in `languageFilter.ts`    |
| Build           | TypeScript compiler (`tsc`) → ES modules               |

### Key Configuration (`src/config.ts`)

| Setting               | Value                                                |
| --------------------- | ---------------------------------------------------- |
| Database Path         | `./data/nachoseries.db` (relative to project root)   |
| Target Genres         | science-fiction, litrpg, fantasy, post-apocalyptic   |
| Year Range            | 2000–present                                         |
| Auto-Accept Threshold | ≥ 0.90 confidence                                    |
| Manual Review         | 0.70–0.89 confidence                                 |
| ISFDB Rate Limit      | 1 request/second                                     |
| Open Library Rate     | 5 requests/second                                    |
| Goodreads Rate        | 2 seconds between requests                           |
| Goodreads Shelf Rate  | 2.5 seconds between requests                         |
| Google Books Rate     | 200ms between requests (5 req/sec, no API key needed) |
| FlareSolverr URL      | `http://flaresolverr:8191/v1` (60s timeout)          |

---

## 3. Database Schema & Storage

**File:** `data/nachoseries.db` (SQLite, WAL journal mode, foreign keys enabled)  
**Current Size:** 43 MB

### Tables

#### `series` — Core Series Metadata

| Column             | Type    | Description                                     |
| ------------------ | ------- | ----------------------------------------------- |
| `id`               | TEXT PK | UUID                                            |
| `name`             | TEXT    | Series name (e.g., "The Stormlight Archive")    |
| `name_normalized`  | TEXT    | Lowercase, no punctuation, for matching         |
| `author`           | TEXT    | Primary author                                  |
| `author_normalized`| TEXT    | Normalized author name                          |
| `genre`            | TEXT    | Assigned genre (nullable)                       |
| `total_books`      | INTEGER | Book count                                      |
| `year_start`       | INTEGER | Earliest book publication year                  |
| `year_end`         | INTEGER | Latest book publication year                    |
| `description`      | TEXT    | Series description (populated via Google Books enrichment) |
| `confidence`       | REAL    | Data confidence score (0.0–2.0+)                |
| `verified`         | INTEGER | Boolean: cross-source verified                  |
| `isfdb_id`         | TEXT    | ISFDB series ID                                 |
| `openlibrary_key`  | TEXT    | Open Library work key                           |
| `librarything_id`  | TEXT    | LibraryThing series ID                          |

#### `series_book` — Individual Books Within a Series

| Column           | Type    | Description                                       |
| ---------------- | ------- | ------------------------------------------------- |
| `id`             | TEXT PK | UUID                                              |
| `series_id`      | TEXT FK | References `series.id`                             |
| `position`       | REAL    | Reading order (REAL for novellas like 1.5, 2.5)    |
| `title`          | TEXT    | Book title                                        |
| `title_normalized`| TEXT   | Normalized for matching                           |
| `author`         | TEXT    | Book author (may differ from series author)       |
| `year_published`  | INTEGER | Publication year                                  |
| `ebook_known`     | INTEGER | Boolean: known to exist as ebook                  |
| `audiobook_known` | INTEGER | Boolean: known to exist as audiobook              |
| `isbn`           | TEXT    | ISBN-10 or ISBN-13 (populated via Google Books enrichment) |
| `confidence`     | REAL    | Book-level confidence                             |

#### `source_data` — Raw Source Preservation

| Column      | Type | Description                                        |
| ----------- | ---- | -------------------------------------------------- |
| `id`        | TEXT PK | UUID                                            |
| `series_id` | TEXT FK | References `series.id`                           |
| `source`    | TEXT | Source name (e.g., 'isfdb', 'goodreads')            |
| `data`      | TEXT | Raw JSON blob of original source response           |
| `book_count`| INTEGER | Book count at time of fetch                      |

#### `discrepancy` — Conflict Tracking

Logs conflicts between data sources for manual or automated resolution.

| Column       | Type | Description                                        |
| ------------ | ---- | -------------------------------------------------- |
| `series_id`  | TEXT FK | References `series.id`                          |
| `field`      | TEXT | Conflicting field name                              |
| `source_a/b` | TEXT | Source names                                        |
| `value_a/b`  | TEXT | Conflicting values                                 |
| `resolved`   | INTEGER | Boolean                                          |
| `resolution` | TEXT | 'a', 'b', 'manual', or resolved value              |

#### `crawl_log` — Crawl History

Tracks each crawl job's results, duration, and status.

### Indexes

```sql
idx_series_name          ON series(name_normalized)
idx_series_author        ON series(author_normalized)
idx_series_genre         ON series(genre)
idx_series_confidence    ON series(confidence)
idx_series_book_series   ON series_book(series_id)
idx_series_book_position ON series_book(series_id, position)
idx_source_data_series   ON source_data(series_id)
idx_discrepancy_unresolved ON discrepancy(resolved) WHERE resolved = 0
```

---

## 4. Data Sources

### 4.1 ISFDB (Primary — Bulk Crawling)

**File:** `src/sources/isfdb.ts` (821 lines)  
**Role:** Primary data source for speculative fiction (sci-fi, fantasy, horror)

ISFDB (Internet Speculative Fiction Database) is a community-maintained database of speculative fiction. NachoSeries scrapes it via HTTP, parsing HTML with cheerio.

#### How It Works

1. **Search** (`searchSeries`): Queries `https://isfdb.org/cgi-bin/se.cgi?arg=<name>&type=Series` to find series by name.
2. **Fetch Series Page** (`fetchSeriesPage`): Parses `https://isfdb.org/cgi-bin/pe.cgi?<id>` to extract:
   - Series name and author
   - All book titles, positions, publication years, authors
   - Tags/categories for genre detection
   - Skips short fiction entries (marked with `[SF]`)
3. **Deduplication**: Removes duplicate book titles (different editions) keeping the earliest year.
4. **Browse by Genre** (`browseSeriesByGenre`): Searches ISFDB for genre-specific keywords, returning series references for batch processing.
5. **Author Discovery** (`discoverSeriesFromAuthors`): Fetches popular ISFDB authors, then crawls their series pages to discover new series.
6. **Range Scanning** (`scanSeriesRange`): Sequentially scans ISFDB series IDs (pe.cgi?1, pe.cgi?2, ...) to discover series not found through keyword search.

#### Rate Limiting

- 1 request per second enforced via `rateLimit()` function
- Respectful User-Agent header

#### Strengths & Weaknesses

| ✅ Strengths                        | ❌ Weaknesses                             |
| ----------------------------------- | ----------------------------------------- |
| Comprehensive for sci-fi/fantasy    | Speculative fiction only — weak on romance, mystery, thriller |
| Structured data (positions, years)  | HTML scraping (brittle to layout changes) |
| Community-maintained, high accuracy | No API — must scrape                       |
| Tags for genre detection            | Limited metadata (no descriptions, ISBNs)  |

---

### 4.2 Goodreads (On-Demand Lookup)

**File:** `src/sources/goodreads.ts` (384 lines)  
**Role:** On-demand fallback when a book isn't found in the local database

Goodreads is used for **reactive enrichment** — when NachoReads asks for a book not in the local DB, NachoSeries queries Goodreads, caches the result, and returns it.

#### How It Works

1. **Search Book** (`searchBookSeries`): Searches Goodreads for a book title, extracts series info from the page's `__NEXT_DATA__` JSON blob (Next.js server-rendered data).
2. **Fetch Series Books** (`fetchSeriesBooks`): Given a series URL, extracts the full book list using 3 fallback strategies:
   - **Strategy 1:** Parse React `SeriesList` component props from inline script tags
   - **Strategy 2:** Extract from `__NEXT_DATA__` JSON
   - **Strategy 3:** Regex fallback on raw HTML
3. **Fetch Series** (`fetchSeries`): Orchestrates search → fetch → normalize into `SourceSeries` format.

#### Rate Limiting

- 2-second minimum interval between requests
- Browser-like User-Agent header

#### Key Detail: Caching

When a Goodreads lookup succeeds, the series is saved to the local SQLite database via `saveSourceSeries()`. All future requests for any book in that series are served from cache. This means the Goodreads source is **self-optimizing** — the more queries NachoReads makes, the fewer external requests are needed.

---

### 4.3 Goodreads Curated Lists (Genre Expansion)

**File:** `src/sources/goodreadsList.ts` (374 lines)  
**Role:** Batch import of series from hand-curated Goodreads lists to expand genre coverage beyond ISFDB's speculative fiction focus.

#### How It Works

1. **Curated List URLs**: Hardcoded mapping of genre → array of Goodreads list URLs. Currently covers:
   - romance (12 lists), mystery (10), thriller (10), biography (6), history (8), true-crime (5), self-help (7), fiction (7), horror (5), fantasy (7), scifi (7)
2. **Page Parsing** (`parseListPage`): Extracts books from list pages using schema.org `<tr>` markup. Parses series info from title patterns like `(Series Name, #1)`.
3. **Pagination**: Fetches up to 3 pages per list (configurable), ~100 books per page.
4. **Series Grouping**: Groups extracted books by series name, merges duplicates across lists.
5. **Import Pipeline** (`importGenre`): Processes all lists for a genre → deduplicates → returns `SourceSeries[]`.

#### Genres Covered

This is the **only source for non-speculative genres** (romance, mystery, thriller, biography, etc.). ISFDB has essentially zero data for these genres.

---

### 4.4 Goodreads Shelves (Bulk Genre Discovery)

**File:** `src/sources/goodreadsShelves.ts` (~360 lines)  
**Role:** Layer 2 of Combo 1 — Scrape community-tagged Goodreads shelves for bulk series discovery in genres poorly covered by ISFDB.

#### How It Works

1. **Genre-to-Shelf Mapping** (`GENRE_SHELF_MAP`): Each genre maps to multiple shelf names to maximize coverage:
   - `litrpg` → `['litrpg', 'lit-rpg', 'gamelit', 'progression-fantasy', 'cultivation', 'dungeon-core', 'system-apocalypse', 'wuxia', 'xianxia']`
   - `post-apocalyptic` → `['post-apocalyptic', 'apocalyptic', 'dystopian', 'survival', 'emp', 'zombie-apocalypse']`
   - `fantasy` → `['epic-fantasy', 'urban-fantasy', 'sword-and-sorcery', 'dark-fantasy', 'fantasy-romance']`
   - etc.
2. **Shelf Scraping** (`scrapeShelf`): Fetches `goodreads.com/shelf/show/<shelf-name>` and extracts book/series info from HTML using two parsing strategies:
   - **Strategy 1:** Parse `leftAlignedImage` blocks for title, author, and series info
   - **Strategy 2:** Fallback to `tableList`/`elementList` page structures
   Series names are extracted from title patterns like `(Series Name, #1)`.
3. **Pagination**: Fetches up to `maxPages` per shelf (default 5), ~50 books per page.
4. **Deduplication**: Merges results across all shelves for a genre using case-insensitive series name keys.
5. **Discovery Pipeline** (`discoverSeriesFromShelves`): Orchestrates multi-shelf scraping → dedup → returns unique `{ name, author }[]`.

#### Rate Limiting

- 2.5-second minimum interval between requests
- 3-second delay between different shelves

#### Strengths & Weaknesses

| ✅ Strengths                        | ❌ Weaknesses                             |
| ----------------------------------- | ----------------------------------------- |
| Covers genres ISFDB misses (LitRPG, romance) | Community-tagged = some noise      |
| No API key required                 | Goodreads page structure can change        |
| Discovers series ISFDB would never find | Rate limited, slow for many shelves   |
| Multi-shelf per genre for breadth   | May require sign-in for some shelves       |

---

### 4.5 Seed Files (Curated Series Lists)

**Files:** `data/seeds/*.txt`  
**Role:** Layer 1 of Combo 1 — Manually curated lists of series names for targeted genre coverage.

#### How It Works

1. **Seed Files**: Plain text files in `data/seeds/`, one series name per line. Lines starting with `#` are section headers/comments.
2. **Import Pipeline** (`runSeedImport`): For each name in a seed file:
   - Check if already in local DB → skip if exists
   - Language filter → skip if non-English
   - Goodreads on-demand lookup → fetch full series data
   - Save to DB with genre tag
3. **Genre Mapping**: Seed file names map to canonical genres:
   - `litrpg.txt` → litrpg
   - `post-apocalyptic.txt` → post-apocalyptic  
   - `fantasy-supplemental.txt` → fantasy
   - `science-fiction-supplemental.txt` → science-fiction

#### Current Seed Files

| File | Series Count | Description |
| ---- | ------------ | ----------- |
| `litrpg.txt` | 168 unique | Dungeon Crawler Carl, Cradle, progression fantasy, wuxia/xianxia, dungeon core |
| `post-apocalyptic.txt` | 138 unique | Classics (The Stand), zombie, EMP/grid-down, pandemic, system apocalypse |
| `fantasy-supplemental.txt` | 150+ | Epic, urban, romantasy, sword & sorcery, dark fantasy, progression |
| `science-fiction-supplemental.txt` | 150+ | Space opera, military, cyberpunk, hard sci-fi, time travel, first contact |

#### Strengths & Weaknesses

| ✅ Strengths                        | ❌ Weaknesses                             |
| ----------------------------------- | ----------------------------------------- |
| Curated = high accuracy for target genre | Manual maintenance required          |
| Covers niche subgenres precisely    | Ambiguous names may match wrong Goodreads series |
| Fast to add new genres              | Relies on Goodreads for actual data        |
| Section headers for organization    | Standalone novels in list won't be found   |

---

### 4.6 Google Books API (Enrichment)

**File:** `src/sources/googleBooks.ts` (~295 lines)  
**Role:** Layer 3 of Combo 1 — Enrich existing series with descriptions, ISBNs, and additional metadata.

#### How It Works

1. **Book Search** (`searchBook`): Queries `googleapis.com/books/v1/volumes` with `intitle:` and `inauthor:` filters. Scores results using:
   - Title similarity (exact: +10, partial: +5)
   - Has description > 50 chars (+5)
   - Has ISBN (+2)
   - Is English (+3)
   - Author match (+4)
2. **Series Description** (`getSeriesDescription`): Tries up to 3 books from a series, then the series name itself, looking for a quality description.
3. **HTML Cleanup**: Strips HTML tags from Google Books descriptions, converts `<br>` to newlines, decodes entities.
4. **Enrichment Output** (`BookEnrichment` interface):
   - `description`: Cleaned text description
   - `isbn10`, `isbn13`: Industry identifiers
   - `categories`: Google's subject categories
   - `pageCount`, `averageRating`, `ratingsCount`
   - `coverUrl`: Thumbnail image URL (HTTPS)
   - `publishedDate`, `language`, `googleBooksId`

#### Rate Limiting

- 200ms between requests (5 req/sec)
- No API key required (uses public endpoint)
- Backs off 10 seconds on 429 rate limit responses

#### Strengths & Weaknesses

| ✅ Strengths                        | ❌ Weaknesses                             |
| ----------------------------------- | ----------------------------------------- |
| No API key or authentication needed | Descriptions are per-book, not per-series  |
| Fast (5 req/sec)                    | Search relevance can be hit-or-miss        |
| Rich metadata (ISBN, ratings, pages)| Not all books have descriptions            |
| No scraping — official REST API     | English language restriction via `langRestrict` |

---

### 4.7 Open Library (Genre Lookup Only)

**File:** `src/sources/genreLookup.ts` (~265 lines)  
**Role:** Genre detection for untagged series by looking up book subjects.

Open Library is **not** used for series data. It's used exclusively to determine a series' genre when ISFDB tags and name analysis fail.

#### How It Works

1. **Search**: Queries `openlibrary.org/search.json?q=<title>&fields=key,title,subject`
2. **Subject Mapping**: Maps Open Library subjects to genres using a weighted scoring system (`SUBJECT_GENRE_MAP`):
   - "science fiction" → science-fiction (weight: 90)
   - "epic fantasy" → fantasy (weight: 90)
   - "dragons" → fantasy (weight: 80)
   - "imaginary places" → fantasy (weight: 50)
   - etc.
3. **Confidence Threshold**: Only accepts results with a score ≥ 50
4. **Series Lookup**: Tries up to 3 books from a series until a confident genre match is found.

---

### 4.8 LibraryThing (Experimental — Mostly Unused)

**File:** `src/sources/librarything.ts`  
**Role:** Experimental secondary source, mostly non-functional due to JavaScript rendering requirements.

LibraryThing requires JavaScript execution to render content. While the FlareSolverr integration was built to handle this, LibraryThing is not actively used for data collection.

---

## 5. Scaling Strategy (Combo 1)

NachoSeries uses a **three-layer scaling strategy** (nicknamed "Combo 1") to achieve comprehensive series coverage beyond what ISFDB alone provides. This is critical for genres like LitRPG, post-apocalyptic, and romance that ISFDB doesn't track well.

### Layer Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: Seed Files (Curated Precision)                            │
│  ─────────────────────────────────────                              │
│  data/seeds/*.txt → Goodreads on-demand lookup → DB with genre tag  │
│  CLI: import-seeds <genre> --save                                   │
│  Speed: ~4s per new series (Goodreads rate limit)                   │
│  Coverage: 600+ curated series across 4 genre files                 │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Goodreads Shelf Scraping (Bulk Discovery)                 │
│  ──────────────────────────────────────────────                     │
│  Goodreads /shelf/show/<tag> → extract series names → Goodreads     │
│  on-demand lookup → DB with genre tag                               │
│  CLI: import-shelves <genre> --save --pages=N                       │
│  Speed: ~2.5s per shelf page + ~4s per new series                   │
│  Coverage: Unlimited (community-tagged, multi-shelf per genre)      │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Google Books Enrichment (Metadata Quality)                │
│  ────────────────────────────────────────────────                   │
│  Existing DB series → Google Books API → descriptions, ISBNs,       │
│  ratings, cover URLs → UPDATE series/books in DB                    │
│  CLI: enrich --descriptions --isbns --limit=N --genre=GENRE         │
│  Speed: ~200ms per book (5 req/sec, no API key)                     │
│  Coverage: Any series already in DB                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Workflow

1. **Run seed imports first** (highest precision, known-good names):
   ```bash
   npm start -- import-seeds litrpg --save
   npm start -- import-seeds post-apocalyptic --save
   npm start -- import-seeds fantasy-supplemental --save
   npm start -- import-seeds science-fiction-supplemental --save
   ```

2. **Run shelf imports second** (discovers series not in seed files):
   ```bash
   npm start -- import-shelves litrpg --save --pages=5
   npm start -- import-shelves post-apocalyptic --save --pages=5
   ```

3. **Enrich with descriptions/ISBNs last** (improves metadata quality):
   ```bash
   npm start -- enrich --descriptions --limit=500
   npm start -- enrich --isbns --limit=500
   ```

### Why Three Layers?

| Concern | Layer 1 (Seeds) | Layer 2 (Shelves) | Layer 3 (Google Books) |
| ------- | --------------- | ----------------- | ---------------------- |
| **Accuracy** | ★★★★★ (hand-curated) | ★★★☆☆ (community-tagged) | ★★★★☆ (official API) |
| **Coverage** | ★★★☆☆ (finite lists) | ★★★★★ (community scale) | N/A (enrichment only) |
| **Speed** | ~4s per series | ~2.5s + 4s per series | ~200ms per book |
| **Cost** | Zero (text files) | Zero (scraping) | Zero (no API key) |
| **Maintenance** | Manual curation | Automatic (shelf tags) | Automatic |

---

## 6. Genre Detection Pipeline

Genre detection is a **multi-strategy pipeline** that runs in order, stopping at the first confident match:

```
Series arrives untagged
        │
        ▼
┌─── Strategy 1: ISFDB Tag Mapping ────────────────────────┐
│  If ISFDB tags are available:                             │
│  Score each tag against GENRE_TAG_MAP                     │
│  - Exact match: +2 points                                │
│  - Contains match: +1 point                              │
│  Highest-scoring genre wins (min 2 points required)       │
│  Example: tags ["SF", "Space Opera"] → science-fiction    │
└───────────────────────────────────────────────────────────┘
        │ (no match?)
        ▼
┌─── Strategy 2: Name Analysis (guessGenreFromName) ───────┐
│  Regex patterns matched against series name:              │
│  - /\blitrpg\b/i → litrpg                               │
│  - /\bspace\s*opera\b/i → science-fiction                │
│  - /\bzombie\b/i → post-apocalyptic                     │
│  - /\bdragon\b/i → fantasy                              │
│  ~50 patterns across 8 genres                            │
└───────────────────────────────────────────────────────────┘
        │ (no match?)
        ▼
┌─── Strategy 3: Open Library Subject Lookup ──────────────┐
│  Search Open Library by book title + author               │
│  Map returned subjects to genres via SUBJECT_GENRE_MAP    │
│  Score-based: accepts ≥ 50 confidence                     │
│  Tries up to 3 books from the series                     │
│  Rate limited: 5 req/sec                                 │
└───────────────────────────────────────────────────────────┘
        │ (no match?)
        ▼
    Series remains untagged (3,835 series currently)
```

### ISFDB Tag Map (`GENRE_TAG_MAP`)

The tag map is a comprehensive pattern-matching system in `isfdb.ts`. Each genre has a list of exact and contains-match patterns:

```typescript
'science-fiction': {
  exact: ['SF', 'Science Fiction', 'Hard SF', 'Soft SF', 'Space Opera', ...],
  contains: ['science fiction', 'sci-fi', 'space', 'cyberpunk', ...]
}
'fantasy': {
  exact: ['Fantasy', 'High Fantasy', 'Dark Fantasy', 'Urban Fantasy', ...],
  contains: ['fantasy', 'magic', 'dragon', 'wizard', ...]
}
// ... 8 genres total
```

---

## 7. Confidence Scoring & Reconciliation

### Confidence Scores

Every series and book gets a confidence score:

| Score Range | Meaning                                          |
| ----------- | ------------------------------------------------ |
| 2.0+        | Verified — cross-source confirmed (198 series)   |
| 0.90–1.99   | Auto-accepted — high confidence from single source |
| 0.70–0.89   | Needs review — discrepancies detected            |
| 0.50–0.69   | Low confidence — limited data                    |
| < 0.50      | Very low — should not be served                  |

### Reconciliation Engine (`src/reconciler/matcher.ts`)

When data is available from multiple sources, the reconciler compares them:

1. **Title Matching**: Uses `string-similarity` (Dice coefficient) with 0.85 threshold for matching titles between sources.
2. **Book Count Comparison**: Checks if both sources report the same number of books.
3. **Order Verification**: Confirms books appear in the same sequence.
4. **Author Comparison**: Fuzzy-matches author names (0.80 threshold).

#### Confidence Calculation

```
Confidence = (Book Count Match × 0.25)
           + (Title Match Ratio × 0.50)
           + (Order Match × 0.15)
           + (Base × 0.10)
           - (Discrepancy Count × 0.05)
```

#### Discrepancy Tracking

When sources disagree, discrepancies are logged to the `discrepancy` table with:
- Which field conflicts (book_count, book_order, title, author, position)
- Values from each source
- Resolution status and method

### Series Merging

`mergeSeries()` combines data from two sources:
- Prefers the primary source's name and metadata
- Adds books from the secondary source that don't exist in the primary (fuzzy title matching at 0.85)
- Re-sorts by position after merge

---

## 8. API Layer

**File:** `src/api.ts` (294 lines)  
**Server:** Raw Node.js `http.createServer()` on port 5057  
**CORS:** Fully open (`*`) for cross-origin requests

### Endpoints

| Endpoint                  | Method | Description                                          |
| ------------------------- | ------ | ---------------------------------------------------- |
| `/api/health`             | GET    | Health check → `{ status: "ok" }`                    |
| `/api/stats`              | GET    | Database statistics (total series, books, by genre)   |
| `/api/lookup`             | GET    | **On-demand lookup**: DB → Goodreads fallback → cache |
| `/api/series`             | GET    | List all series (paginated, optional genre filter)    |
| `/api/series/search`      | GET    | Search series by name (fuzzy)                        |
| `/api/series/byName`      | GET    | Get series by exact name                             |
| `/api/series/for-book`    | GET    | Find which series a book belongs to (local DB only)   |
| `/api/series/:id`         | GET    | Get a specific series with all books                 |
| `/api/books/genre`        | GET    | Get books by genre (for NachoReads genre browsing)    |

### Key Endpoint: `/api/lookup`

This is the most important endpoint — it enables **self-growing data**:

```
Client: GET /api/lookup?title=Awaken+Online&author=Travis+Bagwell
                │
                ▼
     ┌──── Local DB Search ────┐
     │ findSeriesByBookTitle()  │
     │ 3-tier matching:        │
     │  1. Exact title+author  │
     │  2. Author + fuzzy title│
     │  3. Fuzzy title only    │
     └────────────────────────┘
          │              │
       Found          Not Found
          │              │
          ▼              ▼
       Return     ┌── Goodreads ──┐
       cached     │ fetchSeries() │
       result     │ search + parse│
                  └───────┬───────┘
                          │
                     ┌────┴────┐
                  Found    Not Found
                     │         │
                     ▼         ▼
               Save to DB   Return
               + return     { found: false }
```

### Key Endpoint: `/api/books/genre`

Powers NachoReads' "Browse Series by Genre" feature:

```
GET /api/books/genre?genre=litrpg&limit=48&offset=0
```

Returns books from `series_book` JOINed with `series`, filtered by genre, with series metadata attached. Supports pagination via `limit` and `offset`.

---

## 9. CLI Commands & Operations

**Entry point:** `src/index.ts` (1313 lines)  
**Usage:** `npx ts-node src/index.ts <command> [options]`

### Data Collection Commands

| Command                         | Description                                              |
| ------------------------------- | -------------------------------------------------------- |
| `crawl [genre] --save`          | Crawl ISFDB for a genre (keyword search → fetch details) |
| `discover authors --save`       | Crawl popular ISFDB authors to find their series         |
| `discover scan --limit=N --save`| Scan ISFDB series IDs sequentially                       |
| `discover seed --save`          | Import from hardcoded known-series list                  |
| `import-lists [genre] --save`   | Import from Goodreads curated lists                      |
| `import-seeds [genre] --save`   | **NEW** Import from seed text files via Goodreads lookup |
| `import-shelves [genre] --save` | **NEW** Discover series from Goodreads genre shelves     |
| `discover-all`                  | **NEW** Automated full scan: seeds → shelves → enrichment |
| `save [series-name]`            | Fetch and save a single series from ISFDB                |

### Enrichment Commands

| Command                                 | Description                                        |
| --------------------------------------- | -------------------------------------------------- |
| `enrich --descriptions --limit=N`       | **NEW** Add descriptions from Google Books API     |
| `enrich --isbns --limit=N`              | **NEW** Add ISBNs from Google Books API            |
| `enrich --descriptions --genre=GENRE`   | **NEW** Enrich only series of a specific genre     |

### Tagging Commands

| Command               | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `tag [genre]`         | Tag untagged series using regex patterns on names          |
| `retag --limit=N`     | Re-fetch ISFDB tags for untagged series, apply genre map   |
| `autotag`             | Tag ALL untagged series from name analysis (fast, offline) |
| `booktag --limit=N`   | Tag series by looking up books in Open Library subjects    |

### Maintenance Commands

| Command                | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `status`               | Show database stats, service health, configuration        |
| `test [series-name]`   | Test fetch a series from all sources, compare results     |
| `verify`               | Re-verify existing series against ISFDB for accuracy      |
| `cleanup --confirm`    | Remove non-English series (dry-run by default)            |
| `daily`                | Automated daily job: discover → autotag → retag           |
| `serve` / `api`        | Start the HTTP API server                                |

### Daily Automated Job

The `daily` command runs a 3-phase pipeline:

1. **Phase 1**: Discover new series from 50 popular ISFDB authors (`--save`)
2. **Phase 2**: Auto-tag all untagged series from name analysis (instant, no network)
3. **Phase 3**: Re-fetch ISFDB tags for up to 100 remaining untagged series

Reports before/after stats including new series added and genre breakdown changes.

### Full Automated Discovery

The `discover-all` command runs the complete Combo 1 pipeline autonomously:

```bash
npm start -- discover-all [--pages=N] [--skip-seeds] [--skip-shelves] [--skip-enrich]
```

1. **Phase 1 (Seeds)**: Imports ALL seed files in `data/seeds/`, skipping existing series
2. **Phase 2 (Shelves)**: Scrapes Goodreads shelves for ALL genres in `GENRE_SHELF_MAP`
3. **Phase 3a (Descriptions)**: Enriches ALL series missing descriptions via Google Books (batches of 500, loops until done)
4. **Phase 3b (ISBNs)**: Enriches ALL books missing ISBNs via Google Books (batches of 500, loops until done)

Features:
- **Respects all rate limits** (Goodreads: ~4s/lookup, Shelves: ~2.5s/page, Google Books: ~200ms/req)
- **Skip flags** to resume or run partial passes (`--skip-seeds`, `--skip-shelves`, `--skip-enrich`)
- **Progress reporting** with ETA, rate, and phase breakdown
- **Marks failed lookups** with `[none]`/`none` placeholders to avoid re-processing
- **No limit**: processes everything available — runs until there's nothing left to discover

---

## 10. Data Quality & Accuracy

### How Accuracy Is Maintained

1. **Cross-source comparison**: When data exists from ISFDB + Open Library (or other sources), the reconciler compares book counts, titles, order, and authors. Discrepancies are logged.

2. **Confidence thresholds**: Only data meeting the 0.70+ confidence threshold is considered reliable. Data below 0.50 is suspect.

3. **Known series validation**: A hardcoded `knownSeries.ts` file contains manually verified series data (name, author, book count). The `test` command compares source results against this ground truth.

4. **Language filtering**: `languageFilter.ts` detects and removes non-English series using regex patterns for CJK characters, Cyrillic, Arabic, and other scripts.

5. **Deduplication**: ISFDB results are deduplicated by title (keeping earliest publication year). Series are matched by normalized name before insertion.

6. **Verification cycle**: The `verify` command re-fetches series from ISFDB to detect book count changes, ensuring the database stays current.

### Accuracy Weak Points

- **Genre accuracy**: Tag-based detection is strong for well-tagged ISFDB series but fails for untagged or ambiguously tagged series. Name-based fallback catches obvious cases but misses subtle genre assignments.
- **Single-source reliance**: Most series (18,638 out of 18,836) have medium confidence (0.50–0.99) from a single source. Only 198 have been cross-source verified.
- **Goodreads scraping fragility**: Goodreads frequently changes its page structure. The 3-fallback strategy in `fetchSeriesBooks()` mitigates this but is inherently brittle.
- **No descriptions or ISBNs**: These fields exist in the schema but are largely unpopulated (enrichment via Google Books is new).

---

## 11. Resilience & Error Handling

### Process Lifecycle

| Feature | CLI (`index.ts`) | API (`api.ts`) | Docker |
| ------- | ----------------- | -------------- | ------ |
| **SIGINT handling** | ✅ via `registerCleanup()` | ✅ graceful server close | N/A |
| **SIGTERM handling** | ✅ via `registerCleanup()` | ✅ graceful server close | Sends SIGTERM |
| **uncaughtException** | ✅ logs + exits(1) | ✅ logs + exits(1) | Restart policy |
| **unhandledRejection** | ✅ logs + exits(1) | ✅ logs (continues) | N/A |
| **DB cleanup on exit** | ✅ auto-close via cleanup | ✅ auto-close via cleanup | N/A |
| **Force exit timeout** | N/A | 10s after signal | Docker grace period |

### Health Checks

**API endpoint:** `GET /api/health` (or `/health`)

Returns 200 when healthy, 503 when degraded:
```json
{
  "status": "ok",
  "service": "nachoseries",
  "uptime": 3600,
  "startedAt": "2026-02-13T20:17:49.652Z",
  "database": {
    "seriesCount": 18847,
    "journalMode": "wal",
    "path": "./data/nachoseries.db"
  }
}
```

**Docker HEALTHCHECK**: Runs every 30s, 3 retries before marking unhealthy. Uses Node.js `fetch()` to hit the health endpoint and verifies `status === 'ok'`.

### Network Resilience

| Feature | Implementation |
| ------- | -------------- |
| **Fetch timeout** | All HTTP requests timeout after 10-20s via `fetchWithTimeout()` (AbortController) |
| **Retry with backoff** | Goodreads (2 retries, 3s base) and Google Books (3 retries, 2s base) via `withRetry()` |
| **Exponential backoff** | Delay doubles per attempt with ±10% jitter to avoid thundering herd |
| **Retryable errors** | ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failures, 429/502/503/504 |
| **Circuit breaker** | Available via `CircuitBreaker` class (5 failures → 60s pause → half-open test) |
| **Rate limiters** | Per-module: Goodreads 2s, Google Books 200ms, ISFDB 1s, OpenLibrary 200ms |

### Database Resilience

| Feature | Implementation |
| ------- | -------------- |
| **WAL mode** | Enables concurrent reads during writes |
| **Busy timeout** | `PRAGMA busy_timeout = 5000` — waits 5s on lock instead of instant SQLITE_BUSY |
| **Init error handling** | try/catch around `new Database()` + schema execution — logs and throws |
| **Foreign keys** | `PRAGMA foreign_keys = ON` — prevents orphaned records |

### Error Visibility

- **API request logging**: Every non-health request logs method, path, status code, and response time (e.g., `[API] GET /api/stats — 200 (174ms)`).
- **Batch error logging**: `discover-all` logs individual errors (first 5 per batch, then suppresses to avoid flooding). Error counts always shown in summaries.
- **Enrichment placeholders**: Failed description lookups are marked `[none]`, failed ISBN lookups are marked `none` — prevents re-processing on subsequent runs.

### Utility Module: `src/utils/resilience.ts`

Exports:
- `fetchWithTimeout(url, options)` — fetch with AbortController timeout
- `withRetry(fn, options)` — exponential backoff wrapper
- `CircuitBreaker` class — fail-fast when a service is down
- `registerCleanup(fn)` — register shutdown hooks for SIGTERM/SIGINT/crashes

---

## 12. Integration with NachoReads

NachoReads communicates with NachoSeries through a dedicated client service (`nachoreads/backend/src/services/nachoSeries.ts`).

### How NachoReads Uses NachoSeries

1. **Series Discovery** (`/api/lookup`): When a user looks at a book, NachoReads asks "is this book part of a series?" NachoSeries checks its local DB, falls back to Goodreads if needed, caches the result.

2. **Genre Browsing** (`/api/books/genre`): The "Browse Series by Genre" feature fetches paginated book lists from NachoSeries, then enriches with cover art from:
   - **Ebooks**: Google Books API (fast, no rate limits)
   - **Audiobooks**: iTunes Search API

3. **Series Search** (`/api/series/search`): Direct name-based search for series.

4. **Book-to-Series** (`/api/series/for-book`): Local-only lookup to find which series a book belongs to.

### Data Flow for Genre Browsing

```
User selects "LitRPG" genre in NachoReads
    │
    ▼
NachoReads → GET nachoseries:5057/api/books/genre?genre=litrpg&limit=48
    │
    ▼
NachoSeries returns 48 books with series info (title, author, position, series name)
    │
    ▼
NachoReads enriches each book with cover art:
  - Ebooks: Google Books API → direct cover URL
  - Audiobooks: iTunes Search API → artwork URL
    │
    ▼
Results displayed in SeriesGenre.tsx grid view
```

---

## 13. Current Database Statistics

*As of 2026-02-13 (post Combo 1 initial import)*

| Metric             | Value                         |
| ------------------ | ----------------------------- |
| **Database size**  | ~43 MB                        |
| **Total series**   | 18,840+ (growing via seed imports) |
| **Total books**    | 93,700+ (avg 5.0 books/series) |
| **With genre**     | ~15,005 (79.6%)               |
| **Without genre**  | ~3,835 (20.4%)                |
| **Verified (2.0+)**| 198 (1.1%)                    |
| **Medium (0.5–0.99)**| ~18,640 (98.9%)             |
| **Descriptions**   | ~5+ (being populated via Google Books enrichment) |
| **ISBNs**          | 0 (Google Books enrichment available but not yet batch-run) |
| **Authors populated**| 92,361 books (98.6%)         |

### Genre Breakdown

| Genre            | Series Count | Notes                                          |
| ---------------- | ------------ | ---------------------------------------------- |
| fantasy          | 5,514        | Strongest coverage (ISFDB native)              |
| science-fiction  | 4,085        | Strong (ISFDB + merged scifi label)            |
| horror           | 2,278        | Good (ISFDB + Goodreads lists)                 |
| romance          | 1,130        | Goodreads lists only (not in ISFDB)            |
| post-apocalyptic | 459          | Growing via seed imports                       |
| thriller         | 414          | Goodreads lists only                           |
| mystery          | 342          | Goodreads lists only                           |
| fiction          | 256          | Generic — ideally re-tagged to specific genres  |
| history          | 156          | Goodreads lists only                           |
| litrpg           | 119+         | Growing via seed imports (168 in seed file)     |
| biography        | 108          | Goodreads lists only                           |
| self-help        | 77           | Goodreads lists only                           |
| true-crime       | 63           | Goodreads lists only                           |
| *(untagged)*     | ~3,835       | Need genre detection                           |

> **Note:** The "scifi" label (441 series) was merged into "science-fiction" on 2026-02-13.
> The `goodreadsList.ts` genre key was also updated from `scifi` → `science-fiction` to prevent recurrence.

---

## 14. Known Limitations

### Data Coverage

1. ~~**LitRPG severely undercovered**~~: **MITIGATED** — Seed file has 168 curated LitRPG series being imported via Combo 1. Goodreads shelf scraping covers `litrpg`, `lit-rpg`, `gamelit`, `progression-fantasy`, `cultivation`, `dungeon-core` shelves.
2. ~~**"scifi" vs "science-fiction" split**~~: **FIXED** (2026-02-13) — 441 rows merged via SQL UPDATE, `goodreadsList.ts` key updated.
3. **3,835 untagged series** (20.4%): No genre assigned. May include valuable series invisible to genre browsing.
4. ~~**No descriptions**~~: **MITIGATED** — Google Books enrichment (`enrich --descriptions`) now populates descriptions. Initial batch of 5 litrpg series enriched. Full batch enrichment pending.
5. **ISBNs mostly unpopulated**: Google Books enrichment can populate ISBNs (`enrich --isbns`) but hasn't been batch-run yet.

### Technical Limitations

6. **Goodreads scraping fragility**: Goodreads is a moving target. Page structure changes can break all 3 fallback strategies simultaneously.
7. ~~**No bulk Goodreads crawling**~~: **FIXED** — Two new bulk discovery mechanisms: `import-shelves` scrapes community-tagged shelves; `import-seeds` processes curated name lists via Goodreads on-demand lookup.
8. **ISFDB genre bias**: ISFDB is inherently biased toward speculative fiction. Non-spec-fic genres rely on Goodreads curated lists and seed files.
9. **Single-threaded crawling**: All crawling is sequential with rate limiting. A full ISFDB scan of 10,000 series takes ~3 hours at 1 req/sec. Seed imports are ~4s per new series (Goodreads lookup time).
10. **No background scheduling**: The `daily` command must be triggered manually or via external cron. There's no built-in scheduler.
11. **Ambiguous seed names**: Generic names in seed files (e.g., "Underworld", "Chrysalis") may match wrong series on Goodreads search. The Goodreads scraper picks the first result's series, which isn't always the intended one. Adding author names to seed files would mitigate this (future improvement).

---

## 15. File Reference

```
src/
├── index.ts              # CLI entry point (~2240 lines) — all commands + functions
├── api.ts                # HTTP API server (~294 lines) — health check, request logging
├── config.ts             # Configuration constants (72 lines)
├── types.ts              # TypeScript interfaces (126 lines)
│
├── database/
│   ├── db.ts             # SQLite CRUD operations (~840 lines) — busy timeout, health check
│   └── schema.sql        # Table definitions + indexes (114 lines)
│
├── sources/
│   ├── isfdb.ts          # ISFDB scraper (821 lines) — primary source
│   ├── goodreads.ts      # Goodreads scraper (~384 lines) — timeout + retry
│   ├── goodreadsList.ts  # Goodreads list importer (374 lines) — curated lists
│   ├── goodreadsShelves.ts # Goodreads shelf scraper (~360 lines) — bulk discovery
│   ├── googleBooks.ts    # Google Books enrichment (~310 lines) — timeout + retry
│   ├── genreLookup.ts    # Open Library genre detection (265 lines)
│   ├── openLibrary.ts    # Open Library series data (mostly unused)
│   ├── librarything.ts   # LibraryThing (experimental, mostly broken)
│   └── flareSolverr.ts   # Cloudflare bypass proxy client
│
├── reconciler/
│   └── matcher.ts        # Cross-source comparison (295 lines)
│
├── utils/
│   ├── languageFilter.ts # English-only filtering
│   └── resilience.ts     # Fetch timeout, retry, circuit breaker, crash handlers [NEW]
│
└── data/
    └── knownSeries.ts    # Ground-truth validation data

data/
└── seeds/                # Curated series name lists [NEW]
    ├── litrpg.txt                      # 168 unique series (LitRPG, progression fantasy)
    ├── post-apocalyptic.txt            # 138 unique series (post-apoc, zombie, EMP)
    ├── fantasy-supplemental.txt        # 150+ series (epic, urban, romantasy, dark)
    └── science-fiction-supplemental.txt # 150+ series (space opera, military, cyberpunk)
```

---

*This document is a living reference. Update it when making architectural changes to NachoSeries.*
