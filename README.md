# NachoSeries 📚

**Series Database Builder for NachoReads**

NachoSeries aggregates and reconciles book series data from multiple sources to build a reliable, local series database. It runs independently and provides data to NachoReads for series-aware browsing.

## Features

- 🔍 **Multi-Source Aggregation** - Fetches series data from LibraryThing, Open Library, and ISFDB
- ⚖️ **Smart Reconciliation** - Compares sources and calculates confidence scores
- 🎯 **Conflict Resolution** - Uses LibraryThing Talpa (sparingly) to resolve discrepancies
- 📅 **Automated Scheduling** - Daily crawls and verification runs
- 🧪 **Accuracy Testing** - Validates against known correct series data

## Data Sources

| Source | Use | Quota |
|--------|-----|-------|
| LibraryThing Page Scraping | Primary series data | None |
| Open Library API | Secondary/comparison | None |
| ISFDB | Sci-Fi/Fantasy bonus | None |
| Talpa | Conflict resolution only | 50/day |

## Quick Start

```bash
# Install dependencies
npm install

# Initialize database
npm run db:init

# Check status
npm run dev status

# Test fetch a series
npm run dev test "The Stormlight Archive"

# Run tests
npm test
```

## Commands

```bash
nachoseries status           # Show database statistics
nachoseries test [series]    # Test fetch a specific series
nachoseries crawl [genre]    # Crawl series for a genre
nachoseries verify           # Verify existing series data
```

## Docker

```bash
# Build
docker build -t nachoseries .

# Run
docker run -v nachoseries-data:/data nachoseries status
```

### Docker Compose (addons-compose.yml)

```yaml
nachoseries:
  build:
    context: ../repos/nachoseries
    dockerfile: Dockerfile
  container_name: nachoseries
  volumes:
    - nachoseries-data:/data
    - ${NACHOSERIES_DATA:-./nachoseries}:/data  # Or shared with Bookarr
  environment:
    - LIBRARYTHING_API_KEY=${LIBRARYTHING_API_KEY}
  restart: unless-stopped
  # Optional: run on schedule
  # command: ["node", "dist/jobs/scheduler.js"]
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NACHOSERIES_DB_PATH` | `./data/nachoseries.db` | SQLite database path |
| `LIBRARYTHING_API_KEY` | - | API key for Talpa (optional) |

## Target Genres

- Science Fiction
- LitRPG
- Fantasy  
- Post-Apocalyptic

Year range: 2000–present

## Database Schema

### Series
- `id` - Unique identifier
- `name` - Series name
- `author` - Primary author
- `genre` - Genre category
- `total_books` - Number of books
- `confidence` - Data confidence (0.0-1.0)

### Series Books
- `series_id` - Parent series
- `position` - Book position (supports decimals for novellas)
- `title` - Book title
- `ebook_known` - Ebook availability flag
- `audiobook_known` - Audiobook availability flag

## Integration with NachoReads

NachoSeries provides a REST API that NachoReads queries for series data:

1. NachoSeries crawls and verifies series data daily
2. NachoReads queries NachoSeries API for series browsing
3. Series data includes genre tags (Sci-Fi, Fantasy, LitRPG, etc.)
4. Supports filtering by genre, searching by name/author

## License

MIT
