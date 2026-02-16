#!/usr/bin/env python3
"""
Import specific series from an ISFDB SQLite database into NachoSeries.

Requires: First run load-isfdb-to-sqlite.py to create the ISFDB SQLite DB.

Usage:
    python3 scripts/import-isfdb-dump.py <isfdb_db_or_dump> [--genre=GENRE] [--dry-run] <series_name1> [series_name2 ...]

Arguments:
    isfdb_db_or_dump   Path to ISFDB SQLite DB (/tmp/isfdb.db) or MySQL dump file.
                       If a .db file is given, queries it directly (fast, <1s).
                       If a dump file is given, parses it line-by-line (slow, ~90s).

Options:
    --genre=GENRE   Set genre on all imported series (e.g. litrpg, fantasy, post-apocalyptic)
    --dry-run       Show what would be imported without making database changes

Example:
    # Fast (after running load-isfdb-to-sqlite.py):
    python3 scripts/import-isfdb-dump.py /tmp/isfdb.db --genre=litrpg "Cradle" "Dungeon Crawler Carl"

    # Slow (direct dump parsing, no loader needed):
    python3 scripts/import-isfdb-dump.py /tmp/isfdb-backup/.../backup-MySQL-55-2026-02-14 --genre=litrpg "Cradle"
"""

import sys
import re
import sqlite3
import uuid
import json
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────

NACHOSERIES_DB = Path(__file__).parent.parent / "data" / "nachoseries.db"

# Title types to include (excludes COLLECTION to avoid duplicates)
INCLUDED_TITLE_TYPES = {'NOVEL', 'NOVELLA', 'SHORTFICTION'}


# ── Helpers ────────────────────────────────────────────────────────────────

def normalize(text):
    """Normalize a string for matching — must match NachoSeries normalizeText().
    Logic: lowercase, remove non-word/non-space chars, collapse whitespace, trim."""
    if not text:
        return ''
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def extract_year(date_str):
    """Extract year from ISFDB date string (YYYY-MM-DD or YYYY-00-00)."""
    if not date_str:
        return None
    try:
        year = int(str(date_str)[:4])
        return year if year > 0 else None
    except (ValueError, TypeError):
        return None


# ══════════════════════════════════════════════════════════════════════════
# SQLite-based queries (fast path — used when given a .db file)
# ══════════════════════════════════════════════════════════════════════════

class ISFDBSqlite:
    """Query ISFDB data from the pre-loaded SQLite database."""

    def __init__(self, db_path):
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row

    def close(self):
        self.db.close()

    def find_series_ids(self, target_names):
        """Find ISFDB series IDs for the given series names."""
        target_lower = {name.lower(): name for name in target_names}
        found = {}

        print(f"\n🔍 Searching for {len(target_names)} series in ISFDB database...")

        placeholders = ','.join(['?'] * len(target_names))
        lower_names = [n.lower() for n in target_names]
        rows = self.db.execute(
            f"SELECT * FROM series WHERE LOWER(series_title) IN ({placeholders})",
            lower_names
        ).fetchall()

        for row in rows:
            title = row['series_title']
            if title and title.lower() in target_lower:
                orig = target_lower[title.lower()]
                found[orig] = {
                    'series_id': row['series_id'],
                    'series_title': row['series_title'],
                    'series_parent': row['series_parent'],
                    'series_type': row['series_type'],
                    'series_parent_position': row['series_parent_position'],
                    'series_note_id': row['series_note_id'],
                }

        return found

    def find_parent_series(self, parent_ids):
        """Find parent series by their IDs."""
        parents = {}
        if not parent_ids:
            return parents

        placeholders = ','.join(['?'] * len(parent_ids))
        rows = self.db.execute(
            f"SELECT * FROM series WHERE series_id IN ({placeholders})",
            list(parent_ids)
        ).fetchall()

        for row in rows:
            parents[row['series_id']] = {
                'series_id': row['series_id'],
                'series_title': row['series_title'],
                'series_parent': row['series_parent'],
            }

        return parents

    def find_sub_series(self, parent_ids):
        """Find all sub-series that have one of the parent_ids as their parent."""
        sub = {}
        if not parent_ids:
            return sub

        placeholders = ','.join(['?'] * len(parent_ids))
        rows = self.db.execute(
            f"SELECT * FROM series WHERE series_parent IN ({placeholders})",
            list(parent_ids)
        ).fetchall()

        for row in rows:
            pid = row['series_parent']
            if pid not in sub:
                sub[pid] = []
            sub[pid].append({
                'series_id': row['series_id'],
                'series_title': row['series_title'],
                'series_parent': row['series_parent'],
                'series_parent_position': row['series_parent_position'],
            })

        return sub

    def find_titles_for_series(self, series_ids):
        """Find all titles belonging to the given series IDs."""
        titles = {}
        title_ids = set()

        print(f"\n📚 Searching for titles in {len(series_ids)} series...")

        placeholders = ','.join(['?'] * len(series_ids))
        type_placeholders = ','.join(['?'] * len(INCLUDED_TITLE_TYPES))
        rows = self.db.execute(
            f"""SELECT * FROM titles 
                WHERE series_id IN ({placeholders}) 
                AND title_ttype IN ({type_placeholders})
                AND (title_parent = 0 OR title_parent IS NULL)""",
            list(series_ids) + list(INCLUDED_TITLE_TYPES)
        ).fetchall()

        for row in rows:
            sid = row['series_id']
            if sid not in titles:
                titles[sid] = []
            titles[sid].append({
                'title_id': row['title_id'],
                'title': row['title_title'],
                'series_id': sid,
                'seriesnum': row['title_seriesnum'],
                'copyright': row['title_copyright'],
                'ttype': row['title_ttype'],
            })
            title_ids.add(row['title_id'])

        return titles, title_ids

    def find_authors_for_titles(self, title_ids):
        """Find author IDs for the given title IDs."""
        title_to_author = {}
        needed_author_ids = set()

        print(f"\n👤 Searching for authors of {len(title_ids)} titles...")

        title_list = list(title_ids)
        for i in range(0, len(title_list), 900):
            batch = title_list[i:i+900]
            placeholders = ','.join(['?'] * len(batch))
            rows = self.db.execute(
                f"SELECT title_id, author_id FROM canonical_author WHERE title_id IN ({placeholders})",
                batch
            ).fetchall()

            for row in rows:
                title_to_author[row['title_id']] = row['author_id']
                needed_author_ids.add(row['author_id'])

        return title_to_author, needed_author_ids

    def find_author_names(self, author_ids):
        """Find author canonical names for the given author IDs."""
        authors = {}
        if not author_ids:
            return authors

        print(f"\n📝 Looking up {len(author_ids)} author names...")

        author_list = list(author_ids)
        for i in range(0, len(author_list), 900):
            batch = author_list[i:i+900]
            placeholders = ','.join(['?'] * len(batch))
            rows = self.db.execute(
                f"SELECT author_id, author_canonical FROM authors WHERE author_id IN ({placeholders})",
                batch
            ).fetchall()

            for row in rows:
                authors[row['author_id']] = row['author_canonical']

        return authors

    def find_pubs_for_titles(self, title_ids):
        """Find publications (ISBNs, covers) for the given titles."""
        print(f"\n📖 Finding publications for {len(title_ids)} titles...")

        title_to_pubs = {}
        pub_ids = set()
        title_list = list(title_ids)

        for i in range(0, len(title_list), 900):
            batch = title_list[i:i+900]
            placeholders = ','.join(['?'] * len(batch))
            rows = self.db.execute(
                f"SELECT title_id, pub_id FROM pub_content WHERE title_id IN ({placeholders})",
                batch
            ).fetchall()

            for row in rows:
                tid = row['title_id']
                pid = row['pub_id']
                if tid not in title_to_pubs:
                    title_to_pubs[tid] = set()
                title_to_pubs[tid].add(pid)
                pub_ids.add(pid)

        print(f"   Found {len(pub_ids)} publication records linked to our titles")

        pubs = {}
        pub_list = list(pub_ids)

        for i in range(0, len(pub_list), 900):
            batch = pub_list[i:i+900]
            placeholders = ','.join(['?'] * len(batch))
            rows = self.db.execute(
                f"SELECT * FROM pubs WHERE pub_id IN ({placeholders})",
                batch
            ).fetchall()

            for row in rows:
                pubs[row['pub_id']] = {
                    'pub_id': row['pub_id'],
                    'pub_title': row['pub_title'],
                    'pub_year': row['pub_year'],
                    'pub_pages': row['pub_pages'],
                    'pub_ptype': row['pub_ptype'],
                    'pub_ctype': row['pub_ctype'],
                    'pub_isbn': row['pub_isbn'],
                    'pub_frontimage': row['pub_frontimage'],
                    'pub_price': row['pub_price'],
                }

        title_pub_info = {}
        for tid, pub_id_set in title_to_pubs.items():
            candidates = [pubs[pid] for pid in pub_id_set if pid in pubs]
            if not candidates:
                continue

            def pub_sort_key(p):
                has_isbn = 1 if p['pub_isbn'] else 0
                ptype = p.get('pub_ptype', '') or ''
                if ptype in ('tp', 'hc'):
                    type_rank = 2
                elif ptype == 'ebook':
                    type_rank = 1
                else:
                    type_rank = 0
                return (has_isbn, type_rank)

            candidates.sort(key=pub_sort_key, reverse=True)
            title_pub_info[tid] = candidates[0]

        return title_pub_info


# ══════════════════════════════════════════════════════════════════════════
# Dump-file-based queries (slow fallback — used when given a raw dump)
# ══════════════════════════════════════════════════════════════════════════

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


class ISFDBDump:
    """Query ISFDB data by parsing the raw MySQL dump file (slow)."""

    def __init__(self, dump_path):
        self.dump_path = dump_path

    def close(self):
        pass

    def find_series_ids(self, target_names):
        target_lower = {name.lower(): name for name in target_names}
        found = {}
        print(f"\n🔍 Searching for {len(target_names)} series in ISFDB dump (slow)...")

        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`series`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 6:
                            series_title = t[1]
                            if series_title and series_title.lower() in target_lower:
                                orig = target_lower[series_title.lower()]
                                found[orig] = {
                                    'series_id': t[0], 'series_title': t[1],
                                    'series_parent': t[2], 'series_type': t[3],
                                    'series_parent_position': t[4], 'series_note_id': t[5],
                                }
        return found

    def find_parent_series(self, parent_ids):
        parents = {}
        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`series`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 6 and t[0] in parent_ids:
                            parents[t[0]] = {
                                'series_id': t[0], 'series_title': t[1], 'series_parent': t[2],
                            }
        return parents

    def find_sub_series(self, parent_ids):
        sub = {}
        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`series`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 6 and t[2] in parent_ids:
                            pid = t[2]
                            if pid not in sub:
                                sub[pid] = []
                            sub[pid].append({
                                'series_id': t[0], 'series_title': t[1],
                                'series_parent': t[2], 'series_parent_position': t[4],
                            })
        return sub

    def find_titles_for_series(self, series_ids):
        titles = {}
        title_ids = set()
        print(f"\n📚 Searching for titles in {len(series_ids)} series (slow)...")

        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`titles`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 23:
                            sid = t[5]
                            ttype = t[9]
                            parent = t[12]
                            if sid in series_ids and ttype in INCLUDED_TITLE_TYPES and (parent == 0 or parent is None):
                                if sid not in titles:
                                    titles[sid] = []
                                titles[sid].append({
                                    'title_id': t[0], 'title': t[1], 'series_id': sid,
                                    'seriesnum': t[6], 'copyright': t[7], 'ttype': ttype,
                                })
                                title_ids.add(t[0])
        return titles, title_ids

    def find_authors_for_titles(self, title_ids):
        title_to_author = {}
        needed_author_ids = set()
        print(f"\n👤 Searching for authors of {len(title_ids)} titles (slow)...")

        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`canonical_author`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 4 and t[1] in title_ids:
                            title_to_author[t[1]] = t[2]
                            needed_author_ids.add(t[2])
        return title_to_author, needed_author_ids

    def find_author_names(self, author_ids):
        authors = {}
        print(f"\n📝 Looking up {len(author_ids)} author names (slow)...")

        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`authors`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 2 and t[0] in author_ids:
                            authors[t[0]] = t[1]
        return authors

    def find_pubs_for_titles(self, title_ids):
        print(f"\n📖 Finding publications for {len(title_ids)} titles (slow)...")

        title_to_pubs = {}
        pub_ids = set()
        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`pub_content`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 3 and t[1] in title_ids:
                            tid = t[1]
                            pid = t[2]
                            if tid not in title_to_pubs:
                                title_to_pubs[tid] = set()
                            title_to_pubs[tid].add(pid)
                            pub_ids.add(pid)

        print(f"   Found {len(pub_ids)} publication records linked to our titles")

        pubs = {}
        with open(self.dump_path, 'r', encoding='latin1') as f:
            for line in f:
                if 'INSERT INTO' in line and '`pubs`' in line:
                    tuples = parse_mysql_tuples(line)
                    for t in tuples:
                        if len(t) >= 15 and t[0] in pub_ids:
                            pubs[t[0]] = {
                                'pub_id': t[0], 'pub_title': t[1], 'pub_year': t[3],
                                'pub_pages': t[5], 'pub_ptype': t[6], 'pub_ctype': t[7],
                                'pub_isbn': t[8], 'pub_frontimage': t[9], 'pub_price': t[10],
                            }

        title_pub_info = {}
        for tid, pub_id_set in title_to_pubs.items():
            candidates = [pubs[pid] for pid in pub_id_set if pid in pubs]
            if not candidates:
                continue

            def pub_sort_key(p):
                has_isbn = 1 if p['pub_isbn'] else 0
                ptype = p.get('pub_ptype', '') or ''
                if ptype in ('tp', 'hc'):
                    type_rank = 2
                elif ptype == 'ebook':
                    type_rank = 1
                else:
                    type_rank = 0
                return (has_isbn, type_rank)

            candidates.sort(key=pub_sort_key, reverse=True)
            title_pub_info[tid] = candidates[0]

        return title_pub_info


# ══════════════════════════════════════════════════════════════════════════
# Import logic (shared between SQLite and dump backends)
# ══════════════════════════════════════════════════════════════════════════

def import_to_nachoseries(series_data, dry_run=False, genre=None):
    """Import the collected series data into NachoSeries SQLite database."""

    if dry_run:
        print("\n🔍 DRY RUN — no database changes will be made\n")
    if genre:
        print(f"📎 Genre: {genre}")

    db = sqlite3.connect(str(NACHOSERIES_DB))
    cursor = db.cursor()

    now = datetime.now(tz=timezone.utc).isoformat()
    series_inserted = 0
    series_updated = 0
    books_inserted = 0
    source_inserted = 0
    parent_stub_ids = {}  # isfdb_id -> nachoseries UUID

    for entry in series_data:
        series_name = entry['series_title']
        isfdb_id = str(entry['series_id'])
        books = entry.get('books', [])

        # Determine primary author from books
        author_counts = {}
        for b in books:
            a = b.get('author', '')
            if a:
                author_counts[a] = author_counts.get(a, 0) + 1
        primary_author = max(author_counts, key=author_counts.get) if author_counts else None

        # --- Helper: resolve parent series (create stub if needed) ---
        def resolve_parent(entry_data):
            if not entry_data.get('parent_info'):
                return None
            parent = entry_data['parent_info']
            parent_isfdb_id = str(parent['series_id'])

            if parent_isfdb_id in parent_stub_ids:
                return parent_stub_ids[parent_isfdb_id]

            cursor.execute("SELECT id FROM series WHERE isfdb_id = ?", (parent_isfdb_id,))
            parent_row = cursor.fetchone()
            if parent_row:
                parent_stub_ids[parent_isfdb_id] = parent_row[0]
                return parent_row[0]

            parent_name_norm = normalize(parent['series_title'])
            cursor.execute("SELECT id, isfdb_id FROM series WHERE name_normalized = ?", (parent_name_norm,))
            parent_row = cursor.fetchone()
            if parent_row:
                existing_parent_id = parent_row[0]
                existing_parent_isfdb = parent_row[1]
                parent_stub_ids[parent_isfdb_id] = existing_parent_id
                if not existing_parent_isfdb:
                    if not dry_run:
                        cursor.execute("UPDATE series SET isfdb_id = ?, updated_at = ? WHERE id = ?",
                                       (parent_isfdb_id, now, existing_parent_id))
                    print(f"  🔗 Updated parent '{parent['series_title']}' with isfdb_id:{parent_isfdb_id}")
                return existing_parent_id

            new_parent_id = str(uuid.uuid4())
            parent_stub_ids[parent_isfdb_id] = new_parent_id
            if not dry_run:
                cursor.execute("""
                    INSERT INTO series (id, name, name_normalized, author, author_normalized,
                        total_books, confidence, verified, isfdb_id, genre, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (new_parent_id, parent['series_title'], parent_name_norm,
                      primary_author, normalize(primary_author) if primary_author else None,
                      0, 0.9, 0, parent_isfdb_id, genre, now, now))
            print(f"  📁 Created parent series: {parent['series_title']} (isfdb:{parent_isfdb_id})")
            return new_parent_id

        # Check if series already exists
        cursor.execute("SELECT id, isfdb_id, parent_series_id FROM series WHERE isfdb_id = ? OR name_normalized = ?",
                       (isfdb_id, normalize(series_name)))
        existing = cursor.fetchone()

        if existing:
            existing_id = existing[0]
            existing_isfdb = existing[1]
            existing_parent = existing[2]
            updates = []

            if not existing_isfdb:
                if not dry_run:
                    cursor.execute("UPDATE series SET isfdb_id = ?, updated_at = ? WHERE id = ?",
                                   (isfdb_id, now, existing_id))
                updates.append(f"isfdb_id:{isfdb_id}")

            parent_ns_id = resolve_parent(entry)
            if parent_ns_id and not existing_parent:
                if not dry_run:
                    cursor.execute("UPDATE series SET parent_series_id = ?, updated_at = ? WHERE id = ?",
                                   (parent_ns_id, now, existing_id))
                parent_name = entry['parent_info']['series_title'] if entry.get('parent_info') else '?'
                updates.append(f"parent→{parent_name}")

            if updates:
                print(f"  🔄 Updated '{series_name}' (id: {existing_id}): {', '.join(updates)}")
                series_updated += 1
            else:
                print(f"  ⏭️  Series '{series_name}' already exists (id: {existing_id}), nothing to update")
            continue

        # --- New series ---
        parent_ns_id = resolve_parent(entry)

        years = [b['year'] for b in books if b.get('year')]
        year_start = min(years) if years else None
        year_end = max(years) if years else None

        series_id = str(uuid.uuid4())

        if not dry_run:
            cursor.execute("""
                INSERT INTO series (id, name, name_normalized, author, author_normalized,
                    total_books, year_start, year_end, confidence, verified,
                    isfdb_id, genre, created_at, updated_at, parent_series_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (series_id, series_name, normalize(series_name),
                  primary_author, normalize(primary_author) if primary_author else None,
                  len(books), year_start, year_end, 0.95, 0,
                  isfdb_id, genre, now, now, parent_ns_id))

        series_inserted += 1
        print(f"\n  ✅ Series: {series_name} (isfdb:{isfdb_id}, {len(books)} books, {year_start}-{year_end})")
        print(f"     Author: {primary_author}")

        for b in books:
            book_id = str(uuid.uuid4())
            isbn = b.get('isbn')

            if not dry_run:
                cursor.execute("""
                    INSERT INTO series_book (id, series_id, position, title, title_normalized,
                        author, year_published, isbn, confidence, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (book_id, series_id, b.get('position'), b['title'], normalize(b['title']),
                      b.get('author'), b.get('year'), isbn, 0.95, now, now))

            books_inserted += 1
            pos_str = f"#{b.get('position', '?')}" if b.get('position') is not None else "  "
            isbn_str = f" ISBN:{isbn}" if isbn else ""
            print(f"     {pos_str:>5} {b['title']} ({b.get('year', '?')}){isbn_str}")

        if not dry_run:
            source_id = str(uuid.uuid4())
            cursor.execute("""
                INSERT INTO source_data (id, series_id, source, raw_data, book_count, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (source_id, series_id, 'isfdb-dump',
                  json.dumps(entry, default=str), len(books), now))
        source_inserted += 1

    if not dry_run:
        db.commit()

    db.close()

    print(f"\n{'=' * 60}")
    print(f"Import complete{'  (DRY RUN)' if dry_run else ''}:")
    print(f"  Series inserted: {series_inserted}")
    print(f"  Series updated:  {series_updated}")
    print(f"  Books inserted:  {books_inserted}")
    print(f"  Source records:  {source_inserted}")
    print(f"{'=' * 60}")


def run_import(isfdb, target_names, dry_run=False, genre=None):
    """Main import orchestration — works with either ISFDBSqlite or ISFDBDump backend."""

    # Step 1: Find series IDs
    found_series = isfdb.find_series_ids(target_names)

    for name in target_names:
        if name in found_series:
            s = found_series[name]
            parent_str = f" (parent: {s['series_parent']})" if s['series_parent'] else ""
            print(f"  ✅ {name}: ID {s['series_id']}{parent_str}")
        else:
            print(f"  ❌ {name}: NOT FOUND")

    if not found_series:
        print("\nNo series found. Exiting.")
        sys.exit(1)

    # Step 2: Find parent series
    parent_ids = {s['series_parent'] for s in found_series.values() if s['series_parent']}
    parents = {}
    if parent_ids:
        parents = isfdb.find_parent_series(parent_ids)
        for pid, p in parents.items():
            print(f"  📁 Parent series {pid}: {p['series_title']}")

    # Step 3: Discover sub-series (children of targets AND their parents)
    all_series_ids = {s['series_id'] for s in found_series.values()}
    found_ids = set(all_series_ids)

    search_for_children_of = all_series_ids | parent_ids
    sub_series = isfdb.find_sub_series(search_for_children_of)
    for parent_id, children in sub_series.items():
        parent_name = None
        for name, s in found_series.items():
            if s['series_id'] == parent_id:
                parent_name = name
                break
        if parent_name is None and parent_id in parents:
            parent_name = parents[parent_id]['series_title']

        if parent_name:
            print(f"\n  📂 Sub-series of '{parent_name}':")
            for child in children:
                if child['series_id'] in found_ids:
                    print(f"     └─ {child['series_title']} (ID: {child['series_id']}) [already a target]")
                else:
                    print(f"     └─ {child['series_title']} (ID: {child['series_id']})")
                all_series_ids.add(child['series_id'])

    # Step 4: Find titles
    titles, title_ids = isfdb.find_titles_for_series(all_series_ids)
    total_titles = sum(len(v) for v in titles.values())
    print(f"   Found {total_titles} titles across {len(titles)} series")

    # Step 5: Find authors
    title_to_author, author_ids = isfdb.find_authors_for_titles(title_ids)
    author_names = isfdb.find_author_names(author_ids)
    print(f"   Found {len(author_names)} unique authors")

    # Step 6: Find publications (ISBNs, covers)
    title_pub_info = isfdb.find_pubs_for_titles(title_ids)
    print(f"   Found publication info for {len(title_pub_info)} titles")

    # Step 7: Assemble final data
    series_data = []

    for name, s in found_series.items():
        sid = s['series_id']
        series_titles = titles.get(sid, [])

        books = []
        for t in series_titles:
            tid = t['title_id']
            author_id = title_to_author.get(tid)
            author_name = author_names.get(author_id, 'Unknown') if author_id else 'Unknown'
            pub = title_pub_info.get(tid, {})

            books.append({
                'title': t['title'],
                'position': t['seriesnum'],
                'author': author_name,
                'year': extract_year(t['copyright']),
                'isbn': pub.get('pub_isbn'),
                'cover_url': pub.get('pub_frontimage'),
                'pages': pub.get('pub_pages'),
                'isfdb_title_id': tid,
            })

        def sort_key(b):
            pos = b['position']
            try:
                pos = float(pos) if pos is not None else 999
            except (ValueError, TypeError):
                pos = 999
            yr = b.get('year') or 9999
            return (pos, yr)
        books.sort(key=sort_key)

        entry = {
            'series_id': s['series_id'],
            'series_title': s['series_title'],
            'books': books,
        }

        if s['series_parent'] and s['series_parent'] in parents:
            entry['parent_info'] = parents[s['series_parent']]

        series_data.append(entry)

    # Also add sub-series entries
    for parent_id, children in sub_series.items():
        for child in children:
            csid = child['series_id']
            if csid in found_ids:
                continue

            child_titles = titles.get(csid, [])
            books = []
            for t in child_titles:
                tid = t['title_id']
                author_id = title_to_author.get(tid)
                author_name = author_names.get(author_id, 'Unknown') if author_id else 'Unknown'
                pub = title_pub_info.get(tid, {})

                books.append({
                    'title': t['title'],
                    'position': t['seriesnum'],
                    'author': author_name,
                    'year': extract_year(t['copyright']),
                    'isbn': pub.get('pub_isbn'),
                    'cover_url': pub.get('pub_frontimage'),
                    'pages': pub.get('pub_pages'),
                    'isfdb_title_id': tid,
                })

            def sort_key_sub(b):
                pos = b['position']
                try:
                    pos = float(pos) if pos is not None else 999
                except (ValueError, TypeError):
                    pos = 999
                yr = b.get('year') or 9999
                return (pos, yr)
            books.sort(key=sort_key_sub)

            parent_info = None
            for name, s in found_series.items():
                if s['series_id'] == parent_id:
                    parent_info = {'series_id': parent_id, 'series_title': s['series_title']}
                    break
            if parent_info is None and parent_id in parents:
                parent_info = {'series_id': parent_id, 'series_title': parents[parent_id]['series_title']}

            entry = {
                'series_id': child['series_id'],
                'series_title': child['series_title'],
                'books': books,
                'parent_info': parent_info,
            }
            series_data.append(entry)

    # Step 8: Import
    import_to_nachoseries(series_data, dry_run=dry_run, genre=genre)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    dump_path = sys.argv[1]
    target_names = sys.argv[2:]
    dry_run = '--dry-run' in target_names
    if dry_run:
        target_names.remove('--dry-run')

    genre = None
    for arg in list(target_names):
        if arg.startswith('--genre='):
            genre = arg.split('=', 1)[1]
            target_names.remove(arg)

    if not Path(dump_path).exists():
        print(f"Error: Source file not found: {dump_path}")
        sys.exit(1)

    if not NACHOSERIES_DB.exists():
        print(f"Error: NachoSeries database not found: {NACHOSERIES_DB}")
        sys.exit(1)

    # Auto-detect: SQLite DB vs raw MySQL dump
    is_sqlite = dump_path.endswith('.db') or dump_path.endswith('.sqlite')
    if not is_sqlite:
        with open(dump_path, 'rb') as f:
            header = f.read(16)
            if header.startswith(b'SQLite format 3'):
                is_sqlite = True

    if is_sqlite:
        print(f"ISFDB Source: {dump_path} (SQLite — fast mode)")
        isfdb = ISFDBSqlite(dump_path)
    else:
        print(f"ISFDB Source: {dump_path} (MySQL dump — slow mode)")
        print(f"  💡 Tip: Run load-isfdb-to-sqlite.py first for ~100x faster imports")
        isfdb = ISFDBDump(dump_path)

    print(f"NachoSeries DB: {NACHOSERIES_DB}")
    print(f"Target series: {', '.join(target_names)}")
    if genre:
        print(f"Genre: {genre}")

    try:
        run_import(isfdb, target_names, dry_run=dry_run, genre=genre)
    finally:
        isfdb.close()


if __name__ == '__main__':
    main()
