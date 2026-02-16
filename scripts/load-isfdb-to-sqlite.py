#!/usr/bin/env python3
"""
Load ISFDB MySQL dump into a local SQLite database for fast querying.

This is a ONE-TIME loader. Run it once after downloading a new ISFDB dump,
then use import-isfdb-dump.py against the resulting SQLite DB.

Usage:
    python3 scripts/load-isfdb-to-sqlite.py <dump_file> [output.db]

    dump_file   Path to the ISFDB MySQL dump (latin1 encoded)
    output.db   Output SQLite path (default: /tmp/isfdb.db)

Example:
    python3 scripts/load-isfdb-to-sqlite.py \
        /tmp/isfdb-backup/cygdrive/c/ISFDB/Backups/backup-MySQL-55-2026-02-14

Tables loaded (only what import-isfdb-dump.py needs):
    series, titles, canonical_author, authors, pub_content, pubs
"""

import sys
import re
import sqlite3
import time
from pathlib import Path

DEFAULT_OUTPUT = "/tmp/isfdb.db"

# Tables we need and their CREATE statements (simplified from MySQL schema)
TABLES = {
    'series': """
        CREATE TABLE IF NOT EXISTS series (
            series_id     INTEGER PRIMARY KEY,
            series_title  TEXT,
            series_parent INTEGER,
            series_type   TEXT,
            series_parent_position INTEGER,
            series_note_id INTEGER
        )
    """,
    'titles': """
        CREATE TABLE IF NOT EXISTS titles (
            title_id        INTEGER PRIMARY KEY,
            title_title     TEXT,
            title_translator INTEGER,
            title_synopsis  INTEGER,
            note_id         INTEGER,
            series_id       INTEGER,
            title_seriesnum TEXT,
            title_copyright TEXT,
            title_storylen  TEXT,
            title_ttype     TEXT,
            title_wikipedia TEXT,
            title_views     INTEGER,
            title_parent    INTEGER,
            title_rating    REAL,
            title_annualviews INTEGER,
            title_ctl       INTEGER,
            title_language  INTEGER,
            title_seriesnum_2 TEXT,
            title_non_genre TEXT,
            title_graphic   TEXT,
            title_nvz       TEXT,
            title_jvn       TEXT,
            title_content   INTEGER
        )
    """,
    'canonical_author': """
        CREATE TABLE IF NOT EXISTS canonical_author (
            ca_id     INTEGER PRIMARY KEY,
            title_id  INTEGER,
            author_id INTEGER,
            ca_status INTEGER
        )
    """,
    'authors': """
        CREATE TABLE IF NOT EXISTS authors (
            author_id        INTEGER PRIMARY KEY,
            author_canonical TEXT,
            author_legalname TEXT,
            author_birthplace TEXT,
            author_birthdate  TEXT,
            author_deathdate  TEXT,
            note_id           INTEGER,
            author_wikipedia  TEXT,
            author_views      INTEGER,
            author_imdb       TEXT,
            author_marque     TEXT,
            author_image      TEXT,
            author_annualviews INTEGER,
            author_lastname   TEXT,
            author_language   INTEGER,
            author_note       INTEGER
        )
    """,
    'pub_content': """
        CREATE TABLE IF NOT EXISTS pub_content (
            pubc_id   INTEGER PRIMARY KEY,
            title_id  INTEGER,
            pub_id    INTEGER,
            pubc_page TEXT
        )
    """,
    'pubs': """
        CREATE TABLE IF NOT EXISTS pubs (
            pub_id       INTEGER PRIMARY KEY,
            pub_title    TEXT,
            pub_tag      TEXT,
            pub_year     TEXT,
            publisher_id INTEGER,
            pub_pages    TEXT,
            pub_ptype    TEXT,
            pub_ctype    TEXT,
            pub_isbn     TEXT,
            pub_frontimage TEXT,
            pub_price    TEXT,
            note_id      INTEGER,
            pub_series_id INTEGER,
            pub_series_num TEXT,
            pub_catalog  TEXT
        )
    """,
}

# Indexes to create after loading (speeds up import-isfdb-dump.py queries)
INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_series_title ON series(series_title)",
    "CREATE INDEX IF NOT EXISTS idx_series_parent ON series(series_parent)",
    "CREATE INDEX IF NOT EXISTS idx_titles_series_id ON titles(series_id)",
    "CREATE INDEX IF NOT EXISTS idx_titles_ttype ON titles(title_ttype)",
    "CREATE INDEX IF NOT EXISTS idx_titles_parent ON titles(title_parent)",
    "CREATE INDEX IF NOT EXISTS idx_ca_title_id ON canonical_author(title_id)",
    "CREATE INDEX IF NOT EXISTS idx_ca_author_id ON canonical_author(author_id)",
    "CREATE INDEX IF NOT EXISTS idx_pc_title_id ON pub_content(title_id)",
    "CREATE INDEX IF NOT EXISTS idx_pc_pub_id ON pub_content(pub_id)",
]

# Column counts per table (for validation)
TABLE_COL_COUNTS = {
    'series': 6,
    'titles': 23,
    'canonical_author': 4,
    'authors': 16,
    'pub_content': 4,
    'pubs': 15,
}


def parse_mysql_value(val_str):
    """Parse a MySQL value from an INSERT statement."""
    val_str = val_str.strip()
    if val_str == 'NULL':
        return None
    if val_str.startswith("'") and val_str.endswith("'"):
        inner = val_str[1:-1]
        inner = inner.replace("\\'", "'")
        inner = inner.replace("\\\\", "\\")
        inner = inner.replace("\\n", "\n")
        inner = inner.replace("\\r", "\r")
        inner = inner.replace("\\t", "\t")
        return inner
    try:
        if '.' in val_str:
            return float(val_str)
        return int(val_str)
    except ValueError:
        return val_str


def parse_mysql_tuples(line):
    """Parse MySQL INSERT VALUES into list of tuples."""
    values_match = re.search(r'VALUES\s+', line, re.IGNORECASE)
    if not values_match:
        return []

    data = line[values_match.end():]
    data = data.rstrip().rstrip(';').rstrip()

    tuples = []
    i = 0
    while i < len(data):
        if data[i] == '(':
            i += 1
            values = []
            current = ''
            in_string = False
            escape_next = False

            while i < len(data):
                ch = data[i]

                if escape_next:
                    current += ch
                    escape_next = False
                    i += 1
                    continue

                if ch == '\\' and in_string:
                    current += ch
                    escape_next = True
                    i += 1
                    continue

                if ch == "'" and not escape_next:
                    if in_string:
                        in_string = False
                        current += ch
                    else:
                        in_string = True
                        current += ch
                    i += 1
                    continue

                if in_string:
                    current += ch
                    i += 1
                    continue

                if ch == ',':
                    values.append(parse_mysql_value(current))
                    current = ''
                    i += 1
                    continue
                elif ch == ')':
                    values.append(parse_mysql_value(current))
                    tuples.append(values)
                    i += 1
                    break
                else:
                    current += ch
                    i += 1
                    continue
        else:
            i += 1

    return tuples


def detect_table(line):
    """Detect which table an INSERT INTO line targets. Returns table name or None."""
    m = re.match(r"INSERT INTO\s+`(\w+)`", line)
    if m:
        return m.group(1)
    return None


def load_dump(dump_path, output_path):
    """Parse the ISFDB dump and load target tables into SQLite."""
    start_time = time.time()

    # Remove existing DB
    out = Path(output_path)
    if out.exists():
        out.unlink()

    db = sqlite3.connect(output_path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA cache_size=-200000")  # 200MB cache
    cursor = db.cursor()

    # Create tables
    for name, ddl in TABLES.items():
        cursor.execute(ddl)
    db.commit()

    target_tables = set(TABLES.keys())
    row_counts = {t: 0 for t in target_tables}
    lines_scanned = 0

    print(f"📂 Loading ISFDB dump: {dump_path}")
    print(f"📦 Output: {output_path}")
    print(f"📋 Tables: {', '.join(sorted(target_tables))}")
    print()

    with open(dump_path, 'r', encoding='latin1') as f:
        for line in f:
            lines_scanned += 1

            if lines_scanned % 500000 == 0:
                elapsed = time.time() - start_time
                total_rows = sum(row_counts.values())
                print(f"  ... {lines_scanned:,} lines scanned, {total_rows:,} rows loaded ({elapsed:.0f}s)")

            if not line.startswith('INSERT INTO'):
                continue

            table = detect_table(line)
            if table not in target_tables:
                continue

            tuples = parse_mysql_tuples(line)
            expected_cols = TABLE_COL_COUNTS[table]
            placeholders = ','.join(['?'] * expected_cols)

            batch = []
            for t in tuples:
                # Pad or truncate to expected column count
                if len(t) < expected_cols:
                    t.extend([None] * (expected_cols - len(t)))
                elif len(t) > expected_cols:
                    t = t[:expected_cols]
                batch.append(t)

            if batch:
                try:
                    cursor.executemany(
                        f"INSERT OR IGNORE INTO {table} VALUES ({placeholders})",
                        batch
                    )
                    row_counts[table] += len(batch)
                except Exception as e:
                    print(f"  ⚠️  Error inserting into {table}: {e}")
                    # Try row by row
                    for row in batch:
                        try:
                            cursor.execute(
                                f"INSERT OR IGNORE INTO {table} VALUES ({placeholders})",
                                row
                            )
                            row_counts[table] += 1
                        except Exception:
                            pass

            # Commit periodically
            if lines_scanned % 100000 == 0:
                db.commit()

    db.commit()

    # Create indexes
    print("\n🔧 Creating indexes...")
    for idx_sql in INDEXES:
        cursor.execute(idx_sql)
    db.commit()

    elapsed = time.time() - start_time

    print(f"\n{'=' * 60}")
    print(f"✅ ISFDB SQLite database ready: {output_path}")
    print(f"   Time: {elapsed:.1f}s")
    print(f"   Size: {out.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"\n   Row counts:")
    for table in sorted(row_counts):
        print(f"     {table:20s} {row_counts[table]:>10,}")
    print(f"     {'TOTAL':20s} {sum(row_counts.values()):>10,}")
    print(f"{'=' * 60}")

    db.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    dump_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT

    if not Path(dump_path).exists():
        print(f"Error: Dump file not found: {dump_path}")
        sys.exit(1)

    load_dump(dump_path, output_path)


if __name__ == '__main__':
    main()
