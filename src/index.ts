/**
 * NachoSeries - Series Database Builder
 * Aggregates and reconciles book series data from multiple sources
 */

import { initDatabase, getStats, closeDatabase, upsertSeries, upsertSeriesBook, findSeriesByName, getSeriesNeedingVerification, storeSourceData, getDb, updateSeriesGenre, saveSourceSeries, findSeriesByIsfdbId, setParentSeries, getChildSeries, getParentSeriesList, moveBookToSeries, deleteSeriesBook, refreshSeriesBookCount, normalizeText, getBooksInSeries, updateBookDescription, getBooksNeedingDescriptions, getDescriptionStats, dedupParentBooks, findParentsWithDuplicateBooks, type SeriesRecord } from './database/db.js';
import { fetchSeries as fetchLibraryThing } from './sources/librarything.js';
import { fetchSeries as fetchOpenLibrary, searchBookDescription } from './sources/openLibrary.js';
import { searchBookDescription as searchITunesDescription } from './sources/itunes.js';
import { fetchSeries as fetchISFDB, browseSeriesByGenre, fetchSeriesById, genreKeywords, discoverSeriesFromAuthors, scanSeriesRange, fetchPopularAuthors, fetchAuthorSeries, mapTagsToGenre, detectGenre, guessGenreFromName } from './sources/isfdb.js';
import { fetchSeries as fetchGoodreads, testGoodreads } from './sources/goodreads.js';
import { importGenre as importGoodreadsGenre, importAllGenres as importAllGoodreadsGenres, GENRE_LISTS } from './sources/goodreadsList.js';
import { discoverSeriesFromShelves, GENRE_SHELF_MAP } from './sources/goodreadsShelves.js';
import { searchBook, getSeriesDescription, batchEnrich } from './sources/googleBooks.js';
import { lookupGenreForSeries } from './sources/genreLookup.js';
import { initQuotaTable, getAllQuotas, hasQuota, secondsUntilReset, cleanOldQuotas } from './quotas.js';
import { olCircuitBreaker } from './circuitBreaker.js';
import { isOLAvailable, OLCircuitOpenError } from './sources/openLibrary.js';
import { shouldFilterSeries, detectLanguage, getNonEnglishSqlPatterns } from './utils/languageFilter.js';
import { checkFlareSolverr } from './sources/flareSolverr.js';
import { compareSources, needsTalpaVerification } from './reconciler/matcher.js';
import { config } from './config.js';
import { knownSeries } from './data/knownSeries.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                        NACHOSERIES                               ║');
  console.log('║              Series Database Builder v0.1.0                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Initialize database
  initDatabase();
  initQuotaTable();
  
  switch (command) {
    case 'status':
      await showStatus();
      break;
      
    case 'test':
      await runTestFetch(args[1]);
      break;
    
    case 'goodreads':
      // Test Goodreads scraper with a book title
      await testGoodreads(args[1] || 'Awaken Online', args[2]);
      break;
      
    case 'crawl':
      await runCrawl(args[1], args.includes('--save'));
      break;
      
    case 'verify':
      await runVerify();
      break;
      
    case 'discover':
      const discoverLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
      const discoverGenre = args.find(a => a.startsWith('--genre='))?.split('=')[1];
      await runDiscover(args[1] || 'authors', args.includes('--save'), discoverLimit, discoverGenre);
      break;

    case 'tag':
      await runTagGenres(args[1]);
      break;

    case 'retag':
      const retagLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
      await runRetagFromISFDB(retagLimit);
      break;

    case 'autotag':
      // Tag all untagged series using name analysis only (fast, no network)
      await runAutoTagFromNames();
      break;

    case 'booktag':
      // Tag untagged series by looking up individual books in Open Library
      const booktagLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
      await runBookBasedTagging(booktagLimit);
      break;

    case 'daily':
      // Automated daily job: discover new series + tag untagged
      await runDailyJob();
      break;

    case 'cleanup':
      // Remove non-English series from database
      const dryRun = !args.includes('--confirm');
      await runLanguageCleanup(dryRun);
      break;

    case 'import-lists':
      // Import series from Goodreads curated lists
      // Genre is optional (first non-flag arg after command)
      // --save to persist new series, --update-genres to update existing series genres
      const listGenre = args.slice(1).find(a => !a.startsWith('--'));
      const updateGenres = args.includes('--update-genres');
      await runGoodreadsListImport(listGenre, args.includes('--save'), updateGenres);
      break;

    case 'import-seeds': {
      // Import series from seed text files via Goodreads lookup
      // Usage: import-seeds <genre> [--save] [--limit=N]
      const seedGenre = args.slice(1).find(a => !a.startsWith('--'));
      const seedLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
      if (!seedGenre) {
        console.log('Usage: import-seeds <genre> [--save] [--limit=N]');
        console.log('Available seed files: litrpg, post-apocalyptic, fantasy-supplemental, science-fiction-supplemental');
        break;
      }
      await runSeedImport(seedGenre, args.includes('--save'), seedLimit);
      break;
    }

    case 'import-shelves': {
      // Import series from Goodreads genre shelves (community-tagged)
      // Usage: import-shelves <genre> [--save] [--pages=N]
      const shelfGenre = args.slice(1).find(a => !a.startsWith('--'));
      const shelfPages = parseInt(args.find(a => a.startsWith('--pages='))?.split('=')[1] || '5');
      if (!shelfGenre) {
        console.log('Usage: import-shelves <genre> [--save] [--pages=N]');
        console.log(`Available genres: ${Object.keys(GENRE_SHELF_MAP).join(', ')}`);
        break;
      }
      await runShelfImport(shelfGenre, args.includes('--save'), shelfPages);
      break;
    }

    case 'enrich': {
      // Enrich series with descriptions and ISBNs from Google Books
      // Usage: enrich [--descriptions] [--isbns] [--limit=N] [--genre=GENRE] [--series=NAME]
      const enrichLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
      const enrichGenre = args.find(a => a.startsWith('--genre='))?.split('=')[1];
      const enrichSeries = args.find(a => a.startsWith('--series='))?.split('=').slice(1).join('=');
      const enrichDescriptions = args.includes('--descriptions') || (!args.includes('--isbns'));
      const enrichIsbns = args.includes('--isbns');
      await runGoogleBooksEnrich(enrichLimit, enrichGenre, enrichDescriptions, enrichIsbns, enrichSeries);
      break;
    }

    case 'discover-all': {
      // Automated full discovery: seeds → shelves → enrichment
      // Runs through ALL sources until nothing new is found
      // Usage: discover-all [--pages=N] [--skip-seeds] [--skip-shelves] [--skip-enrich]
      const daPages = parseInt(args.find(a => a.startsWith('--pages='))?.split('=')[1] || '3');
      await runDiscoverAll({
        shelfPages: daPages,
        skipSeeds: args.includes('--skip-seeds'),
        skipShelves: args.includes('--skip-shelves'),
        skipEnrich: args.includes('--skip-enrich'),
      });
      break;
    }


    case 'backfill': {
      // Backfill books for series that have 0 book records
      // Usage: backfill [--save] [--limit=N] [--genre=GENRE]
      const bfLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
      const bfGenre = args.find(a => a.startsWith('--genre='))?.split('=')[1];
      await runBackfillBooks(args.includes('--save'), bfLimit, bfGenre);
      break;
    }

    case 'link-subseries': {
      // Link sub-series to their parent series by re-parsing ISFDB pages
      // Usage: link-subseries [--limit=N] [--dry-run]
      const lsLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
      const lsDryRun = args.includes('--dry-run');
      await runLinkSubSeries(lsLimit, lsDryRun);
      break;
    }

    case 'reconcile-subseries': {
      // Reconcile flat series that should have sub-series structure
      // Fetches parent ISFDB pages, creates missing sub-series, moves books
      // Usage: reconcile-subseries [--limit=N] [--dry-run] [--series=NAME]
      const rsLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
      const rsDryRun = args.includes('--dry-run');
      const rsSeries = args.find(a => a.startsWith('--series='))?.split('=').slice(1).join('=');
      await runReconcileSubSeries(rsLimit, rsDryRun, rsSeries);
      break;
    }

    case 'dedup-parents': {
      // Remove books from parent series that are duplicated in child sub-series
      // Usage: dedup-parents [--dry-run] [--series=NAME]
      const dpDryRun = args.includes('--dry-run');
      const dpSeries = args.find(a => a.startsWith('--series='))?.split('=').slice(1).join('=');
      runDedupParents(dpDryRun, dpSeries);
      break;
    }

    case 'enrich-books': {
      // Enrich individual books with descriptions from Google Books
      // Usage: enrich-books [--limit=N] [--genre=GENRE] [--series=NAME] [--dry-run]
      const ebLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '500');
      const ebGenre = args.find(a => a.startsWith('--genre='))?.split('=')[1];
      const ebSeries = args.find(a => a.startsWith('--series='))?.split('=').slice(1).join('=');
      const ebDryRun = args.includes('--dry-run');
      await runEnrichBookDescriptions(ebLimit, ebGenre, ebDryRun, ebSeries);
      break;
    }

    case 'auto-enrich': {
      // Fully autonomous enrichment: series descriptions then book descriptions
      // Respects daily quotas, OL circuit breaker, and auto-resumes
      // Usage: auto-enrich [--genre=GENRE] [--books-only] [--series-only]
      const aeGenre = args.find(a => a.startsWith('--genre='))?.split('=')[1];
      const aeBooksOnly = args.includes('--books-only');
      const aeSeriesOnly = args.includes('--series-only');
      await runAutoEnrich({ genre: aeGenre, booksOnly: aeBooksOnly, seriesOnly: aeSeriesOnly });
      break;
    }

    case 'save':
      await saveSeriesFromTest(args[1]);
      break;

    case 'serve':
    case 'api':
      // Start the API server
      const { startServer } = await import('./api.js');
      closeDatabase(); // Close CLI connection, API will open its own
      startServer();
      return; // Don't close database or exit
      
    default:
      console.log('Usage: nachoseries <command>');
      console.log('');
      console.log('Commands:');
      console.log('  status            Show database statistics');
      console.log('  serve / api       Start the HTTP API server');
      console.log('  test [series]     Test fetch a specific series');
      console.log('  crawl [genre]     Crawl series for a genre (--save to persist)');
      console.log('  save [series]     Fetch and save a specific series');
      console.log('  verify            Verify existing series data');
      console.log('  discover [mode]   Discover series (modes: authors, scan, seed)');
      console.log('  tag [genre]       Tag untagged series with genres using keyword matching');
      console.log('  retag             Re-fetch ISFDB tags for untagged series');
      console.log('  autotag           Tag all untagged series from name analysis (fast)');
      console.log('  booktag           Tag series by looking up books in Open Library');
      console.log('  import-lists      Import from Goodreads curated lists (--save to persist)');
      console.log('  import-seeds      Import from seed text files via Goodreads (--save)');
      console.log('  import-shelves    Import from Goodreads genre shelves (--save)');
      console.log('  enrich            Enrich series with Google Books data (descriptions, ISBNs)');
      console.log('  enrich-books      Enrich individual book descriptions from Google Books');
      console.log('  discover-all      Automated full scan: seeds → shelves → enrichment');
      console.log('  cleanup           Remove non-English series (--confirm to execute)');
      console.log('  backfill          Backfill books for series with 0 book records');
      console.log('  link-subseries    Link sub-series to parents by re-parsing ISFDB pages');
      console.log('  reconcile-subseries  Find flat series needing sub-series split & fix them');
      console.log('  dedup-parents     Remove books from parents that are duplicated in children');
      console.log('  daily             Run automated daily job (discover + tag)');
      console.log('');
      console.log('Options:');
      console.log('  --save            Save discovered series to database');
      console.log('  --limit=N         Limit number of items to process');
      console.log('  --genre=GENRE     Tag discovered series with this genre');
      console.log('  --pages=N         Max pages per shelf to scrape (import-shelves)');
      console.log('  --descriptions    Enrich with descriptions (enrich command)');
      console.log('  --isbns           Enrich with ISBNs (enrich command)');
      console.log('  --dry-run         Preview what would be changed (enrich-books, reconcile-subseries)');
      console.log('  --confirm         Execute cleanup (otherwise dry-run)');
      console.log('  --skip-seeds      Skip seed file imports (discover-all)');
      console.log('  --skip-shelves    Skip shelf scraping (discover-all)');
      console.log('  --skip-enrich     Skip Google Books enrichment (discover-all)');
      console.log('');
      console.log('Genres: ' + Object.keys(genreKeywords).join(', '));
      break;
  }
  
  closeDatabase();
}

async function showStatus() {
  console.log('📊 Database Status');
  console.log('─'.repeat(50));
  
  const stats = getStats();
  
  console.log(`Total Series:     ${stats.totalSeries}`);
  console.log(`Total Books:      ${stats.totalBooks}`);
  console.log(`Verified Series:  ${stats.verifiedSeries}`);
  console.log(`Avg Confidence:   ${(stats.avgConfidence * 100).toFixed(1)}%`);
  console.log('');
  console.log('Series by Genre:');
  for (const [genre, count] of Object.entries(stats.seriesByGenre)) {
    console.log(`  ${genre}: ${count}`);
  }
  
  // Show untagged count
  const db = getDb();
  const untaggedCount = (db.prepare('SELECT COUNT(*) as count FROM series WHERE genre IS NULL').get() as { count: number }).count;
  console.log(`  (untagged): ${untaggedCount}`);
  
  console.log('');
  console.log('🔌 Services Status');
  console.log('─'.repeat(50));
  const flareSolverrOk = await checkFlareSolverr();
  console.log(`FlareSolverr:     ${flareSolverrOk ? '✅ Online' : '❌ Offline'} (${config.flareSolverr.url})`);
  console.log('');
  console.log('📋 Configuration');
  console.log('─'.repeat(50));
  console.log(`Genres: ${config.genres.join(', ')}`);
  console.log(`Year Range: ${config.yearRange.start}-${config.yearRange.end}`);
  console.log(`Auto-Accept Threshold: ${config.confidence.autoAccept * 100}%`);
}

async function runTestFetch(seriesName?: string) {
  const name = seriesName || 'The Stormlight Archive';
  
  console.log(`🔍 Testing fetch for: "${name}"`);
  console.log('─'.repeat(50));
  
  // Fetch from ISFDB (most reliable for speculative fiction)
  console.log('\n📚 ISFDB:');
  const isfdbResult = await fetchISFDB(name);
  
  if (isfdbResult.error) {
    console.log(`  ❌ Error: ${isfdbResult.error}`);
  } else if (isfdbResult.series) {
    console.log(`  ✅ Found ${isfdbResult.series.books.length} books`);
    console.log(`  Author: ${isfdbResult.series.author || 'Unknown'}`);
    for (const book of isfdbResult.series.books.slice(0, 5)) {
      console.log(`    ${book.position || '?'}. ${book.title} (${book.yearPublished || '?'})`);
    }
    if (isfdbResult.series.books.length > 5) {
      console.log(`    ... and ${isfdbResult.series.books.length - 5} more`);
    }
  } else {
    console.log('  ⚠️ No results');
  }
  
  // Fetch from Open Library
  console.log('\n📖 Open Library:');
  const olResult = await fetchOpenLibrary(name);
  
  if (olResult.error) {
    console.log(`  ❌ Error: ${olResult.error}`);
  } else if (olResult.series) {
    console.log(`  ✅ Found ${olResult.series.books.length} books`);
    console.log(`  Author: ${olResult.series.author || 'Unknown'}`);
    for (const book of olResult.series.books.slice(0, 5)) {
      console.log(`    ${book.position || '?'}. ${book.title}`);
    }
    if (olResult.series.books.length > 5) {
      console.log(`    ... and ${olResult.series.books.length - 5} more`);
    }
  } else {
    console.log('  ⚠️ No results');
  }
  
  // Optionally try LibraryThing (may not work due to JS requirement)
  console.log('\n📕 LibraryThing (experimental):');
  const ltResult = await fetchLibraryThing(name);
  
  if (ltResult.error) {
    console.log(`  ❌ Error: ${ltResult.error}`);
  } else if (ltResult.series) {
    console.log(`  ✅ Found ${ltResult.series.books.length} books`);
    console.log(`  Author: ${ltResult.series.author || 'Unknown'}`);
    for (const book of ltResult.series.books.slice(0, 5)) {
      console.log(`    ${book.position || '?'}. ${book.title}`);
    }
    if (ltResult.series.books.length > 5) {
      console.log(`    ... and ${ltResult.series.books.length - 5} more`);
    }
  } else {
    console.log('  ⚠️ No results (site requires JavaScript)');
  }
  
  // Compare ISFDB and Open Library results
  if (isfdbResult.series && olResult.series) {
    console.log('\n⚖️ ISFDB vs Open Library Comparison:');
    const comparison = compareSources(isfdbResult, olResult);
    
    if (comparison) {
      console.log(`  Confidence: ${(comparison.confidence * 100).toFixed(1)}%`);
      console.log(`  Book Count Match: ${comparison.bookCountMatch ? '✅' : '❌'} (${comparison.bookCountA} vs ${comparison.bookCountB})`);
      console.log(`  Title Matches: ${comparison.titleMatches}`);
      console.log(`  Order Match: ${comparison.orderMatch ? '✅' : '❌'}`);
      
      if (comparison.discrepancies.length > 0) {
        console.log('  Discrepancies:');
        for (const d of comparison.discrepancies.slice(0, 5)) {
          console.log(`    - ${d.field}: ${d.valueA} (${d.sourceA}) vs ${d.valueB} (${d.sourceB})`);
        }
        if (comparison.discrepancies.length > 5) {
          console.log(`    ... and ${comparison.discrepancies.length - 5} more`);
        }
      }
      
      if (needsTalpaVerification(comparison)) {
        console.log('  ⚠️ Would queue for Talpa verification');
      } else if (comparison.confidence >= config.confidence.autoAccept) {
        console.log('  ✅ Would auto-accept');
      } else {
        console.log('  🔍 Would need manual review');
      }
    }
  }
  
  // Compare with known data if available
  const known = knownSeries.find(k => k.name.toLowerCase() === name.toLowerCase());
  if (known) {
    console.log('\n📋 Known Data Comparison:');
    console.log(`  Expected: ${known.bookCount} books by ${known.author}`);
    
    if (isfdbResult.series) {
      const isfdbDiff = isfdbResult.series.books.length - known.bookCount;
      console.log(`  ISFDB: ${isfdbDiff === 0 ? '✅ Exact match' : `${isfdbDiff > 0 ? '+' : ''}${isfdbDiff} books`}`);
    }
    
    if (olResult.series) {
      const olDiff = olResult.series.books.length - known.bookCount;
      console.log(`  Open Library: ${olDiff === 0 ? '✅ Exact match' : `${olDiff > 0 ? '+' : ''}${olDiff} books`}`);
    }
    
    if (ltResult.series) {
      const ltDiff = ltResult.series.books.length - known.bookCount;
      console.log(`  LibraryThing: ${ltDiff === 0 ? '✅ Exact match' : `${ltDiff > 0 ? '+' : ''}${ltDiff} books`}`);
    }
  }
}

async function runCrawl(genre?: string, saveToDb = false) {
  const targetGenre = genre || config.genres[0];
  
  console.log(`🔄 Crawling genre: ${targetGenre}`);
  console.log(`📁 Save to database: ${saveToDb ? 'Yes' : 'No (dry run)'}`);
  console.log('─'.repeat(50));
  
  // Check if genre is valid
  if (!genreKeywords[targetGenre]) {
    console.log(`❌ Unknown genre: ${targetGenre}`);
    console.log(`   Available: ${Object.keys(genreKeywords).join(', ')}`);
    return;
  }
  
  // Discover series for the genre
  console.log(`\n🔍 Discovering series for "${targetGenre}"...`);
  const seriesList = await browseSeriesByGenre(targetGenre);
  
  console.log(`\n📊 Found ${seriesList.length} series to process`);
  console.log('─'.repeat(50));
  
  let saved = 0;
  let skipped = 0;
  let errors = 0;
  
  for (let i = 0; i < seriesList.length; i++) {
    const seriesRef = seriesList[i];
    const progress = `[${i + 1}/${seriesList.length}]`;
    
    // Check if already in database
    const existing = findSeriesByName(seriesRef.name);
    if (existing) {
      console.log(`${progress} ⏭️  ${seriesRef.name} (already exists)`);
      skipped++;
      continue;
    }
    
    // Fetch full series data
    console.log(`${progress} 📥 Fetching: ${seriesRef.name}`);
    const result = await fetchSeriesById(seriesRef.id);
    
    if (result.error || !result.series) {
      console.log(`${progress} ❌ Error: ${result.error || 'No data'}`);
      errors++;
      continue;
    }
    
    const series = result.series;
    
    // Skip series with no books or too few books
    if (series.books.length < 2) {
      console.log(`${progress} ⏭️  ${series.name} (only ${series.books.length} book)`);
      skipped++;
      continue;
    }
    
    // Calculate year range
    const years = series.books.map(b => b.yearPublished).filter((y): y is number => y !== undefined);
    const yearStart = years.length > 0 ? Math.min(...years) : undefined;
    const yearEnd = years.length > 0 ? Math.max(...years) : undefined;
    
    console.log(`${progress} ✅ ${series.name} - ${series.books.length} books by ${series.author || 'Unknown'}`);
    
    if (saveToDb) {
      // Save to database
      const seriesId = upsertSeries({
        name: series.name,
        author: series.author,
        genre: targetGenre,
        total_books: series.books.length,
        year_start: yearStart,
        year_end: yearEnd,
        confidence: 0.8,  // ISFDB is generally reliable
        isfdb_id: series.sourceId,
      });
      
      // Save each book
      for (const book of series.books) {
        upsertSeriesBook({
          series_id: seriesId,
          title: book.title,
          position: book.position,
          author: book.author,
          year_published: book.yearPublished,
          confidence: 0.8,
        });
      }
      
      // Store raw source data
      storeSourceData(seriesId, 'isfdb', result.raw, series.books.length);
      
      // Process sub-series hierarchy if this series has sub-series or a parent
      if (series.subSeries && series.subSeries.length > 0) {
        console.log(`${progress}   🔗 Processing ${series.subSeries.length} sub-series...`);
        await processSeriesHierarchy(series.sourceId!, { genre: targetGenre, verbose: false });
      } else if (series.parentSeriesId) {
        // This is a sub-series — process the parent to discover siblings
        await processSeriesHierarchy(series.parentSeriesId, { genre: targetGenre, verbose: false });
      }
      
      saved++;
    } else {
      saved++;  // Count as "would be saved" in dry run
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Crawl Summary:');
  console.log(`  Genre: ${targetGenre}`);
  console.log(`  Processed: ${seriesList.length} series`);
  console.log(`  ${saveToDb ? 'Saved' : 'Would save'}: ${saved}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  
  if (!saveToDb) {
    console.log('');
    console.log('💡 Run with --save to persist to database');
  }
}

async function saveSeriesFromTest(seriesName?: string) {
  const name = seriesName || 'The Stormlight Archive';
  
  console.log(`💾 Fetching and saving: "${name}"`);
  console.log('─'.repeat(50));
  
  // Check if already exists
  const existing = findSeriesByName(name);
  if (existing) {
    console.log(`⚠️ Series already exists in database (ID: ${existing.id})`);
    console.log(`   Name: ${existing.name}`);
    console.log(`   Books: ${existing.total_books}`);
    return;
  }
  
  // Fetch from ISFDB
  const result = await fetchISFDB(name);
  
  if (result.error || !result.series) {
    console.log(`❌ Error fetching series: ${result.error || 'No data'}`);
    return;
  }
  
  const series = result.series;
  console.log(`✅ Found: ${series.name} - ${series.books.length} books`);
  
  // Calculate year range
  const years = series.books.map(b => b.yearPublished).filter((y): y is number => y !== undefined);
  const yearStart = years.length > 0 ? Math.min(...years) : undefined;
  const yearEnd = years.length > 0 ? Math.max(...years) : undefined;
  
  // Save to database
  const seriesId = upsertSeries({
    name: series.name,
    author: series.author,
    total_books: series.books.length,
    year_start: yearStart,
    year_end: yearEnd,
    confidence: 0.8,
    isfdb_id: series.sourceId,
  });
  
  console.log(`📁 Saved series with ID: ${seriesId}`);
  
  // Save each book
  for (const book of series.books) {
    upsertSeriesBook({
      series_id: seriesId,
      title: book.title,
      position: book.position,
      author: book.author,
      year_published: book.yearPublished,
      confidence: 0.8,
    });
    console.log(`  📖 Saved: ${book.position}. ${book.title}`);
  }
  
  // Store raw source data
  storeSourceData(seriesId, 'isfdb', result.raw, series.books.length);
  
  console.log('');
  console.log('✅ Series saved successfully!');
}

async function runVerify() {
  console.log('✅ Verifying existing series...');
  console.log('─'.repeat(50));
  
  // Get series needing verification
  const toVerify = getSeriesNeedingVerification(10);
  
  if (toVerify.length === 0) {
    console.log('No series need verification!');
    return;
  }
  
  console.log(`Found ${toVerify.length} series needing verification:`);
  console.log('');
  
  for (const series of toVerify) {
    console.log(`📋 ${series.name}`);
    console.log(`   Confidence: ${(series.confidence * 100).toFixed(1)}%`);
    console.log(`   Books: ${series.total_books || '?'}`);
    console.log(`   Author: ${series.author || 'Unknown'}`);
    
    // Fetch fresh data from ISFDB
    if (series.isfdb_id) {
      console.log(`   Refreshing from ISFDB...`);
      const result = await fetchSeriesById(series.isfdb_id);
      
      if (result.series) {
        const freshBooks = result.series.books.length;
        const diff = freshBooks - (series.total_books || 0);
        
        if (diff !== 0) {
          console.log(`   ⚠️ Book count changed: ${series.total_books} → ${freshBooks} (${diff > 0 ? '+' : ''}${diff})`);
        } else {
          console.log(`   ✅ Book count verified: ${freshBooks}`);
        }
      }
    }
    console.log('');
  }
  
  console.log('─'.repeat(50));
  console.log('💡 Full verification with cross-source reconciliation coming soon!');
}

async function runDiscover(mode: string, saveToDb = false, limit = 100, genre?: string) {
  console.log(`🔍 Discovery mode: ${mode}`);
  console.log(`📁 Save to database: ${saveToDb ? 'Yes' : 'No (dry run)'}`);
  console.log(`📊 Limit: ${limit} ${mode === 'authors' ? 'authors' : 'series IDs'}`);
  if (genre) {
    console.log(`🏷️  Genre tag: ${genre}`);
  }
  console.log('─'.repeat(50));
  
  let discoveredSeries: Array<{ id: string; name: string; author?: string }> = [];
  
  if (mode === 'authors') {
    // Import the function dynamically since we just added it
    const { discoverSeriesFromAuthors } = await import('./sources/isfdb.js');
    
    console.log('\n🔄 Crawling popular authors for their series...\n');
    
    discoveredSeries = await discoverSeriesFromAuthors(limit, (current, total, author, count) => {
      const progress = `[${current}/${total}]`;
      console.log(`${progress} ${author}: ${count} series`);
    });
  } else if (mode === 'scan') {
    const { scanSeriesRange } = await import('./sources/isfdb.js');
    
    // Start from series ID 1 and scan
    console.log(`\n🔄 Scanning series IDs 1-${limit}...\n`);
    
    discoveredSeries = await scanSeriesRange(1, limit, (current, total, found) => {
      if (current % 100 === 0 || current === total) {
        console.log(`  Progress: ${current}/${total} (found: ${found})`);
      }
    });
  } else if (mode === 'seed') {
    // Import known series from our seed list
    console.log('\n📋 Importing known series from seed list...\n');
    
    for (const known of knownSeries) {
      console.log(`  ${known.name} by ${known.author}`);
      discoveredSeries.push({ id: '', name: known.name, author: known.author });
    }
  } else {
    console.log(`❌ Unknown discovery mode: ${mode}`);
    console.log('   Available modes: authors, scan, seed');
    return;
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log(`\n📊 Discovered ${discoveredSeries.length} series\n`);
  
  if (!saveToDb) {
    console.log('Top 20 discovered series:');
    for (const s of discoveredSeries.slice(0, 20)) {
      console.log(`  - ${s.name}${s.author ? ` (${s.author})` : ''}`);
    }
    if (discoveredSeries.length > 20) {
      console.log(`  ... and ${discoveredSeries.length - 20} more`);
    }
    console.log('');
    console.log('💡 Run with --save to fetch full details and persist to database');
    if (!genre) {
      console.log('💡 Add --genre=GENRE to tag all discovered series with a genre');
    }
    return;
  }
  
  // Fetch and save each series
  console.log('Fetching and saving series details...\n');
  
  let saved = 0;
  let skipped = 0;
  let filtered = 0;
  let errors = 0;
  
  for (let i = 0; i < discoveredSeries.length; i++) {
    const seriesRef = discoveredSeries[i];
    const progress = `[${i + 1}/${discoveredSeries.length}]`;
    
    // Language filter - skip non-English series
    if (shouldFilterSeries(seriesRef.name)) {
      console.log(`${progress} 🌍 ${seriesRef.name} (non-English, skipped)`);
      filtered++;
      continue;
    }
    
    // Check if already in database
    const existing = findSeriesByName(seriesRef.name);
    if (existing) {
      console.log(`${progress} ⏭️  ${seriesRef.name} (already exists)`);
      skipped++;
      continue;
    }
    
    // Fetch full series data
    let result;
    if (seriesRef.id) {
      result = await fetchSeriesById(seriesRef.id);
    } else {
      // For seed mode, search by name
      result = await fetchISFDB(seriesRef.name);
    }
    
    if (result.error || !result.series) {
      console.log(`${progress} ❌ ${seriesRef.name}: ${result.error || 'No data'}`);
      errors++;
      continue;
    }
    
    const series = result.series;
    
    // Skip series with too few books
    if (series.books.length < 2) {
      console.log(`${progress} ⏭️  ${series.name} (only ${series.books.length} book)`);
      skipped++;
      continue;
    }
    
    // Calculate year range
    const years = series.books.map(b => b.yearPublished).filter((y): y is number => y !== undefined);
    const yearStart = years.length > 0 ? Math.min(...years) : undefined;
    const yearEnd = years.length > 0 ? Math.max(...years) : undefined;
    
    // Determine genre: use provided genre, or auto-detect from ISFDB tags, or guess from name
    const detectedGenre = genre || detectGenre(series.tags, series.name);
    
    // Save to database WITH GENRE if provided or detected
    const seriesId = upsertSeries({
      name: series.name,
      author: series.author,
      genre: detectedGenre,
      total_books: series.books.length,
      year_start: yearStart,
      year_end: yearEnd,
      confidence: 0.8,
      isfdb_id: series.sourceId,
    });
    
    // Save each book
    for (const book of series.books) {
      upsertSeriesBook({
        series_id: seriesId,
        title: book.title,
        position: book.position,
        author: book.author,
        year_published: book.yearPublished,
        confidence: 0.8,
      });
    }
    
    // Store raw source data
    storeSourceData(seriesId, 'isfdb', result.raw, series.books.length);
    
    // Process sub-series hierarchy if applicable
    if (series.subSeries && series.subSeries.length > 0) {
      console.log(`${progress}   🔗 Processing ${series.subSeries.length} sub-series...`);
      await processSeriesHierarchy(series.sourceId!, { genre: detectedGenre || undefined, verbose: false });
    } else if (series.parentSeriesId) {
      await processSeriesHierarchy(series.parentSeriesId, { genre: detectedGenre || undefined, verbose: false });
    }
    
    const genreLabel = detectedGenre ? ` [${detectedGenre}]` : '';
    console.log(`${progress} ✅ ${series.name} - ${series.books.length} books${genreLabel}`);
    saved++;
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Discovery Summary:');
  console.log(`  Mode: ${mode}`);
  if (genre) {
    console.log(`  Genre: ${genre}`);
  }
  console.log(`  Discovered: ${discoveredSeries.length} series`);
  console.log(`  Saved: ${saved}`);
  console.log(`  Skipped (existing): ${skipped}`);
  console.log(`  Filtered (non-English): ${filtered}`);
  console.log(`  Errors: ${errors}`);
}

/**
 * Tag untagged series with genres based on keyword matching
 */
async function runTagGenres(targetGenre?: string) {
  console.log('🏷️  Tagging series with genres...');
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Genre keyword patterns for matching series names
  const genrePatterns: Record<string, RegExp[]> = {
    'litrpg': [
      /\blitrpg\b/i,
      /\bgamelit\b/i,
      /\bdungeon\s*core\b/i,
      /\bcultivation\b/i,
      /\bprogression\s*fantasy\b/i,
      /\bsystem\s*apocalypse\b/i,
      /\bvrmmo\b/i,
    ],
    'fantasy': [
      /\bfantasy\b/i,
      /\bsword\s*(and|&)\s*sorcery\b/i,
      /\bdragon\b/i,
      /\bwizard\b/i,
      /\bmagic\b/i,
      /\belf\b|\belves\b|\bdwarves\b|\bdwarf\b/i,
      /\bthrone\b|\bkingdom\b|\bempire\b|\brealm\b/i,
      /\bfae\b|\bfaerie\b|\bfairy\b/i,
    ],
    'science-fiction': [
      /\bscience\s*fiction\b/i,
      /\bsci[\s-]?fi\b/i,
      /\bspace\s*opera\b/i,
      /\bcyberpunk\b/i,
      /\bstarship\b/i,
      /\bgalaxy\b|\bgalactic\b/i,
      /\balien\b|\bextraterrestrial\b/i,
      /\bplanet\b/i,
      /\bstar\s*trek\b|\bstar\s*wars\b/i,
    ],
    'post-apocalyptic': [
      /\bapocalyptic\b/i,
      /\bpost[\s-]?apocaly/i,
      /\bdystopian\b/i,
      /\bsurvival\b/i,
      /\bzombie\b/i,
      /\bcollapse\b/i,
      /\bwasteland\b/i,
    ],
    'horror': [
      /\bhorror\b/i,
      /\bdark\s*fantasy\b/i,
      /\bsupernatural\b/i,
      /\bvampire\b/i,
      /\bwerewolf\b/i,
      /\bhaunted\b/i,
      /\bghost\b|\bghostly\b/i,
      /\bmonster\b/i,
    ],
    'mystery': [
      /\bmystery\b/i,
      /\bdetective\b/i,
      /\bcrime\b/i,
      /\bwhodunit\b/i,
      /\bmurder\b/i,
      /\bsleuth\b/i,
    ],
    'thriller': [
      /\bthriller\b/i,
      /\bsuspense\b/i,
      /\bspy\b/i,
      /\bespionage\b/i,
      /\bassassin\b/i,
      /\bconspiracy\b/i,
    ],
    'romance': [
      /\bromance\b/i,
      /\blove\s*story\b/i,
      /\bromantic\b/i,
      /\bregency\b/i,
    ],
  };
  
  // Get all series without genres
  const stmt = db.prepare('SELECT id, name, author FROM series WHERE genre IS NULL');
  const untagged = stmt.all() as Array<{ id: string; name: string; author: string | null }>;
  
  console.log(`Found ${untagged.length} series without genre tags\n`);
  
  let tagged = 0;
  const genresToProcess = targetGenre ? [targetGenre] : Object.keys(genrePatterns);
  const genreCounts: Record<string, number> = {};
  
  for (const series of untagged) {
    const searchText = series.name;
    let wasTagged = false;
    
    for (const genreName of genresToProcess) {
      if (wasTagged) break;
      const patterns = genrePatterns[genreName];
      if (!patterns) continue;
      
      for (const pattern of patterns) {
        if (pattern.test(searchText)) {
          // Update genre
          db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
            .run(genreName, series.id);
          
          console.log(`  🏷️  ${series.name} → ${genreName}`);
          tagged++;
          genreCounts[genreName] = (genreCounts[genreName] || 0) + 1;
          wasTagged = true;
          break;  // Only assign first matching genre
        }
      }
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log(`Tagged ${tagged} series with genres:`);
  for (const [g, count] of Object.entries(genreCounts)) {
    console.log(`  ${g}: ${count}`);
  }
  console.log(`\nRemaining untagged: ${untagged.length - tagged}`);
}

/**
 * Re-fetch ISFDB tags for untagged series and apply genre classification
 * Uses multi-strategy approach: ISFDB tags → name analysis
 */
async function runRetagFromISFDB(limit = 100) {
  console.log('🔄 Re-tagging series from ISFDB...');
  console.log(`📊 Limit: ${limit} series`);
  console.log('Strategy: ISFDB tags → Name analysis fallback');
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Get untagged series that have an ISFDB ID
  const stmt = db.prepare(`
    SELECT id, name, isfdb_id 
    FROM series 
    WHERE genre IS NULL AND isfdb_id IS NOT NULL
    LIMIT ?
  `);
  const untagged = stmt.all(limit) as Array<{ id: number; name: string; isfdb_id: string }>;
  
  console.log(`Found ${untagged.length} untagged series with ISFDB IDs\n`);
  
  let taggedFromISFDB = 0;
  let taggedFromName = 0;
  let noMatch = 0;
  let errors = 0;
  const genreCounts: Record<string, number> = {};
  
  for (let i = 0; i < untagged.length; i++) {
    const series = untagged[i];
    const progress = `[${i + 1}/${untagged.length}]`;
    
    try {
      // Fetch series from ISFDB to get tags
      const result = await fetchSeriesById(series.isfdb_id);
      
      if (result.error || !result.series) {
        // Can't fetch, try name-based detection
        const genreFromName = guessGenreFromName(series.name);
        if (genreFromName) {
          db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
            .run(genreFromName, series.id);
          console.log(`${progress} 📝 ${series.name} → ${genreFromName} (from name)`);
          taggedFromName++;
          genreCounts[genreFromName] = (genreCounts[genreFromName] || 0) + 1;
        } else {
          console.log(`${progress} ❌ ${series.name}: ${result.error || 'No data'}`);
          errors++;
        }
        continue;
      }
      
      const tags = result.series.tags;
      
      // Try tag-based detection first
      let genre = tags && tags.length > 0 ? mapTagsToGenre(tags) : undefined;
      let source = 'tags';
      
      // Fall back to name analysis
      if (!genre) {
        genre = guessGenreFromName(series.name);
        source = 'name';
      }
      
      if (!genre) {
        const tagInfo = tags && tags.length > 0 ? ` (tags: ${tags.slice(0, 3).join(', ')})` : '';
        console.log(`${progress} ⏭️  ${series.name}${tagInfo} - no match`);
        noMatch++;
        continue;
      }
      
      // Update the series with the genre
      db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
        .run(genre, series.id);
      
      if (source === 'tags') {
        console.log(`${progress} 🏷️  ${series.name} → ${genre} (from: ${tags!.slice(0, 3).join(', ')})`);
        taggedFromISFDB++;
      } else {
        console.log(`${progress} 📝 ${series.name} → ${genre} (from name)`);
        taggedFromName++;
      }
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      
    } catch (error) {
      // On error, still try name-based detection
      const genreFromName = guessGenreFromName(series.name);
      if (genreFromName) {
        db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
          .run(genreFromName, series.id);
        console.log(`${progress} 📝 ${series.name} → ${genreFromName} (from name, after error)`);
        taggedFromName++;
        genreCounts[genreFromName] = (genreCounts[genreFromName] || 0) + 1;
      } else {
        console.log(`${progress} ❌ ${series.name}: ${error}`);
        errors++;
      }
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Re-tagging Summary:');
  console.log(`  Processed: ${untagged.length}`);
  console.log(`  Tagged from ISFDB tags: ${taggedFromISFDB}`);
  console.log(`  Tagged from name analysis: ${taggedFromName}`);
  console.log(`  Total tagged: ${taggedFromISFDB + taggedFromName}`);
  console.log(`  No match: ${noMatch}`);
  console.log(`  Errors: ${errors}`);
  console.log('');
  console.log('By genre:');
  for (const [g, count] of Object.entries(genreCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${g}: ${count}`);
  }
}

/**
 * Fast auto-tagging using name analysis only (no network requests)
 * Tags all untagged series based on keywords in their names
 */
async function runAutoTagFromNames() {
  console.log('🚀 Auto-tagging series from names (fast mode)...');
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Get ALL untagged series
  const stmt = db.prepare(`SELECT id, name FROM series WHERE genre IS NULL`);
  const untagged = stmt.all() as Array<{ id: number; name: string }>;
  
  console.log(`Found ${untagged.length} untagged series\n`);
  
  let tagged = 0;
  const genreCounts: Record<string, number> = {};
  
  for (const series of untagged) {
    const genre = guessGenreFromName(series.name);
    
    if (genre) {
      db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
        .run(genre, series.id);
      tagged++;
      genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    }
  }
  
  console.log('📊 Auto-tagging Summary:');
  console.log(`  Processed: ${untagged.length}`);
  console.log(`  Tagged: ${tagged}`);
  console.log(`  Remaining untagged: ${untagged.length - tagged}`);
  console.log('');
  console.log('By genre:');
  for (const [g, count] of Object.entries(genreCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${g}: ${count}`);
  }
}

/**
 * Automated daily job for self-sufficient operation
 * 1. Discover new series from popular authors
 * 2. Auto-tag any untagged series
 * 3. Report stats
 */
async function runDailyJob() {
  const startTime = Date.now();
  console.log('🤖 Running automated daily job...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log('═'.repeat(60));
  
  const db = getDb();
  const statsBefore = getStats();
  
  // Phase 1: Discover new series (limited to avoid rate limiting)
  console.log('\n📡 Phase 1: Discovering new series from popular authors...');
  console.log('─'.repeat(50));
  
  try {
    await runDiscover('authors', true, 50); // 50 authors, save to DB
  } catch (error) {
    console.log(`⚠️ Discovery phase had issues: ${error}`);
  }
  
  // Phase 2: Auto-tag untagged series
  console.log('\n🏷️ Phase 2: Auto-tagging untagged series...');
  console.log('─'.repeat(50));
  
  await runAutoTagFromNames();
  
  // Phase 3: Try ISFDB tags for remaining untagged (limited)
  console.log('\n🔄 Phase 3: Fetching ISFDB tags for remaining untagged...');
  console.log('─'.repeat(50));
  
  try {
    await runRetagFromISFDB(100); // 100 series at a time
  } catch (error) {
    console.log(`⚠️ ISFDB retag phase had issues: ${error}`);
  }
  
  // Final stats
  const statsAfter = getStats();
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  console.log('\n═'.repeat(60));
  console.log('📊 Daily Job Complete!');
  console.log('─'.repeat(50));
  console.log(`  Duration: ${elapsed} minutes`);
  console.log(`  Series: ${statsBefore.totalSeries} → ${statsAfter.totalSeries} (+${statsAfter.totalSeries - statsBefore.totalSeries})`);
  console.log(`  Books: ${statsBefore.totalBooks} → ${statsAfter.totalBooks} (+${statsAfter.totalBooks - statsBefore.totalBooks})`);
  console.log('');
  console.log('Series by genre:');
  for (const [genre, count] of Object.entries(statsAfter.seriesByGenre || {}).sort((a, b) => b[1] - a[1])) {
    const before = (statsBefore.seriesByGenre as Record<string, number>)?.[genre] || 0;
    const diff = count - before;
    const diffStr = diff > 0 ? ` (+${diff})` : '';
    console.log(`  ${genre}: ${count}${diffStr}`);
  }
  
  // Count remaining untagged
  const untaggedCount = db.prepare(`SELECT COUNT(*) as count FROM series WHERE genre IS NULL`).get() as { count: number };
  console.log(`\n  Untagged: ${untaggedCount.count}`);
}

/**
 * Tag untagged series by looking up individual books in Open Library
 * Uses book-level genre data to tag entire series
 */
async function runBookBasedTagging(limit = 100) {
  console.log('📚 Book-based genre tagging via Open Library...');
  console.log(`📊 Limit: ${limit} series`);
  console.log('Strategy: Look up books → extract subjects → map to genre');
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Get untagged series with their books
  const untaggedSeries = db.prepare(`
    SELECT s.id, s.name, s.author
    FROM series s
    WHERE s.genre IS NULL
    LIMIT ?
  `).all(limit) as Array<{ id: string; name: string; author: string | null }>;
  
  console.log(`Found ${untaggedSeries.length} untagged series\n`);
  
  let tagged = 0;
  let noMatch = 0;
  let errors = 0;
  const genreCounts: Record<string, number> = {};
  
  for (let i = 0; i < untaggedSeries.length; i++) {
    const series = untaggedSeries[i];
    const progress = `[${i + 1}/${untaggedSeries.length}]`;
    
    try {
      // Get books for this series
      const books = db.prepare(`
        SELECT title, author FROM series_book WHERE series_id = ? LIMIT 5
      `).all(series.id) as Array<{ title: string; author: string | null }>;
      
      if (books.length === 0) {
        console.log(`${progress} ⏭️  ${series.name} (no books in DB)`);
        noMatch++;
        continue;
      }
      
      // Look up genre via Open Library
      const result = await lookupGenreForSeries(
        books.map(b => ({ title: b.title, author: b.author || series.author || undefined })),
        3  // Try up to 3 books
      );
      
      if (!result) {
        console.log(`${progress} ⏭️  ${series.name} (no genre found)`);
        noMatch++;
        continue;
      }
      
      // Update the series with the genre
      db.prepare("UPDATE series SET genre = ?, updated_at = datetime('now') WHERE id = ?")
        .run(result.genre, series.id);
      
      console.log(`${progress} 📖 ${series.name} → ${result.genre} (from: ${result.matchedSubjects.slice(0, 2).join(', ')})`);
      tagged++;
      genreCounts[result.genre] = (genreCounts[result.genre] || 0) + 1;
      
    } catch (error) {
      console.log(`${progress} ❌ ${series.name}: ${error}`);
      errors++;
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Book-based Tagging Summary:');
  console.log(`  Processed: ${untaggedSeries.length}`);
  console.log(`  Tagged: ${tagged}`);
  console.log(`  No match: ${noMatch}`);
  console.log(`  Errors: ${errors}`);
  console.log('');
  console.log('By genre:');
  for (const [g, count] of Object.entries(genreCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${g}: ${count}`);
  }
  
  // Show remaining untagged
  const remaining = db.prepare(`SELECT COUNT(*) as count FROM series WHERE genre IS NULL`).get() as { count: number };
  console.log(`\nRemaining untagged: ${remaining.count}`);
}

/**
 * Clean up non-English series from the database
 * Uses pattern matching and language detection
 */
async function runLanguageCleanup(dryRun = true) {
  console.log('🌍 Language Cleanup: Removing non-English series...');
  console.log(`Mode: ${dryRun ? 'DRY RUN (use --confirm to delete)' : '⚠️  LIVE - DELETING'}`);
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Get all series and check each one
  const allSeries = db.prepare(`SELECT id, name FROM series`).all() as Array<{ id: string; name: string }>;
  
  const nonEnglish: Array<{ id: string; name: string; language: string }> = [];
  
  for (const series of allSeries) {
    const result = detectLanguage(series.name);
    if (!result.isEnglish && result.confidence > 60) {
      nonEnglish.push({
        id: series.id,
        name: series.name,
        language: result.detectedLanguage || 'unknown',
      });
    }
  }
  
  // Group by detected language
  const byLanguage: Record<string, string[]> = {};
  for (const s of nonEnglish) {
    if (!byLanguage[s.language]) {
      byLanguage[s.language] = [];
    }
    byLanguage[s.language].push(s.name);
  }
  
  console.log(`\nFound ${nonEnglish.length} non-English series:\n`);
  
  for (const [lang, names] of Object.entries(byLanguage).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${lang}: ${names.length} series`);
    // Show first 3 examples
    for (const name of names.slice(0, 3)) {
      console.log(`    - ${name}`);
    }
    if (names.length > 3) {
      console.log(`    ... and ${names.length - 3} more`);
    }
  }
  
  if (dryRun) {
    console.log('\n⚠️  DRY RUN - No changes made');
    console.log('Run with --confirm to delete these series');
  } else {
    console.log('\n🗑️  Deleting non-English series...');
    
    let deleted = 0;
    for (const series of nonEnglish) {
      // Delete books first (foreign key)
      db.prepare(`DELETE FROM series_book WHERE series_id = ?`).run(series.id);
      db.prepare(`DELETE FROM source_data WHERE series_id = ?`).run(series.id);
      db.prepare(`DELETE FROM series WHERE id = ?`).run(series.id);
      deleted++;
    }
    
    console.log(`✅ Deleted ${deleted} non-English series`);
  }
  
  // Show final stats
  const stats = getStats();
  console.log(`\nDatabase now has ${stats.totalSeries} series`);
}

/**
 * Import series from Goodreads curated lists
 */
async function runGoodreadsListImport(genre?: string, save = false, updateExistingGenres = false) {
  console.log('📚 Goodreads List Import');
  console.log('─'.repeat(50));
  
  if (genre && !GENRE_LISTS[genre]) {
    console.log(`Unknown genre: ${genre}`);
    console.log(`Available genres: ${Object.keys(GENRE_LISTS).join(', ')}`);
    return;
  }
  
  if (!save && !updateExistingGenres) {
    console.log('⚠️  Dry run mode - use --save to persist new series, --update-genres to update existing');
  }
  
  let allSeries: Map<string, import('./types.js').SourceSeries[]>;
  
  if (genre) {
    // Import single genre
    const series = await importGoodreadsGenre(genre);
    allSeries = new Map([[genre, series]]);
  } else {
    // Import all genres
    allSeries = await importAllGoodreadsGenres();
  }
  
  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Import Summary');
  console.log('═'.repeat(50));
  
  let totalSeries = 0;
  let savedSeries = 0;
  let updatedGenres = 0;
  
  // Genres that should be updated (generic/unset genres)
  const genericGenres = new Set(['', null, undefined, 'fiction', 'unknown']);
  
  for (const [g, series] of allSeries) {
    console.log(`\n${g}: ${series.length} series`);
    totalSeries += series.length;
    
    if ((save || updateExistingGenres) && series.length > 0) {
      const db = getDb();
      
      for (const s of series) {
        // Filter non-English
        if (shouldFilterSeries(s.name)) {
          console.log(`  ⏭️  Skip (non-English): ${s.name}`);
          continue;
        }
        
        // Check if series already exists
        const existing = findSeriesByName(s.name);
        if (existing) {
          // Only update genre if:
          // 1. --update-genres flag is set
          // 2. Existing genre is generic (null, empty, "fiction", "unknown")
          // 3. New genre is different and more specific
          const existingGenre = existing.genre || '';
          const shouldUpdate = updateExistingGenres && 
            genericGenres.has(existingGenre) && 
            !genericGenres.has(g);
          
          if (shouldUpdate) {
            const oldGenre = existingGenre || '(none)';
            updateSeriesGenre(existing.id, g);
            updatedGenres++;
            console.log(`  🔄 Updated genre: ${s.name} (${oldGenre} → ${g})`);
          } else {
            console.log(`  ⏭️  Skip (exists): ${s.name}`);
          }
          continue;
        }
        
        if (!save) continue; // Only create new if --save flag
        
        // Insert series
        const seriesId = upsertSeries({
          name: s.name,
          author: s.author || null,
          genre: g,
          confidence: 0.8, // Curated lists are fairly reliable
        });
        
        // Insert books
        for (const book of s.books) {
          upsertSeriesBook({
            series_id: seriesId,
            title: book.title,
            author: book.author || null,
            position: book.position || null,
            year_published: book.yearPublished || null,
          });
        }
        
        savedSeries++;
        console.log(`  ✅ Saved: ${s.name} (${s.books.length} books)`);
      }
    }
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`Total found: ${totalSeries} series`);
  if (save || updateExistingGenres) {
    if (save) console.log(`Saved to DB: ${savedSeries} new series`);
    if (updateExistingGenres) console.log(`Updated genres: ${updatedGenres} existing series`);
    const stats = getStats();
    console.log(`Database now has ${stats.totalSeries} series`);
  }
}

// =============================================================================
// Seed Import (Combo 1, Layer 1)
// =============================================================================

/**
 * Import series from seed text files via Goodreads on-demand lookup.
 * Seed files live in data/seeds/<genre>.txt with one series name per line.
 * For each name: check local DB → if not found, Goodreads lookup → cache in DB.
 */
async function runSeedImport(genre: string, save = false, limit = 0) {
  console.log('🌱 Seed Import via Goodreads Lookup');
  console.log('─'.repeat(50));
  
  // Find the seed file
  const seedDir = join(process.cwd(), 'data', 'seeds');
  const seedFile = join(seedDir, `${genre}.txt`);
  
  if (!existsSync(seedFile)) {
    console.log(`❌ Seed file not found: ${seedFile}`);
    // List available seed files
    if (existsSync(seedDir)) {
      const files = readdirSync(seedDir).filter(f => f.endsWith('.txt'));
      console.log(`Available seed files: ${files.map(f => f.replace('.txt', '')).join(', ')}`);
    }
    return;
  }
  
  // Parse the seed file
  const content = readFileSync(seedFile, 'utf-8');
  const seriesNames = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  
  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const uniqueNames = seriesNames.filter(name => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  const toProcess = limit > 0 ? uniqueNames.slice(0, limit) : uniqueNames;
  
  console.log(`📄 Seed file: ${seedFile}`);
  console.log(`📊 Series names: ${uniqueNames.length} unique (${seriesNames.length} total lines)`);
  console.log(`🔄 Processing: ${toProcess.length}${limit > 0 ? ` (limited to ${limit})` : ''}`);
  console.log(`📁 Save to database: ${save ? 'Yes' : 'No (dry run)'}`);
  console.log(`🏷️  Genre: ${genre}`);
  console.log('─'.repeat(50));
  
  const db = getDb();
  let alreadyExists = 0;
  let fetched = 0;
  let saved = 0;
  let notFound = 0;
  let filtered = 0;
  let errors = 0;
  
  // Determine the canonical genre name for the seed file
  // Map seed file names to actual genre labels
  const genreMap: Record<string, string> = {
    'litrpg': 'litrpg',
    'post-apocalyptic': 'post-apocalyptic',
    'fantasy-supplemental': 'fantasy',
    'science-fiction-supplemental': 'science-fiction',
    'fantasy': 'fantasy',
    'science-fiction': 'science-fiction',
    'horror': 'horror',
    'romance': 'romance',
    'mystery': 'mystery',
    'thriller': 'thriller',
  };
  const canonicalGenre = genreMap[genre] || genre;
  
  for (let i = 0; i < toProcess.length; i++) {
    const seriesName = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;
    
    // Language filter
    if (shouldFilterSeries(seriesName)) {
      console.log(`${progress} 🌍 ${seriesName} (non-English, skipped)`);
      filtered++;
      continue;
    }
    
    // Check if already in database
    const existing = findSeriesByName(seriesName);
    if (existing) {
      // If exists but has no genre (or generic genre), update it
      if (save && (!existing.genre || existing.genre === 'fiction')) {
        updateSeriesGenre(existing.id, canonicalGenre);
        console.log(`${progress} 🔄 ${seriesName} (exists, genre updated → ${canonicalGenre})`);
      } else {
        console.log(`${progress} ⏭️  ${seriesName} (already exists${existing.genre ? ` [${existing.genre}]` : ''})`);
      }
      alreadyExists++;
      continue;
    }
    
    // Not in DB — fetch from Goodreads
    console.log(`${progress} 📥 Fetching: ${seriesName}...`);
    
    try {
      const series = await fetchGoodreads(seriesName);
      
      if (!series || series.books.length === 0) {
        console.log(`${progress} ⚠️  ${seriesName} (not found on Goodreads)`);
        notFound++;
        continue;
      }
      
      fetched++;
      
      if (save) {
        // Save to database with genre
        const seriesId = saveSourceSeries(series, series.sourceId);
        
        // Set the genre
        updateSeriesGenre(seriesId, canonicalGenre);
        
        console.log(`${progress} ✅ ${series.name} - ${series.books.length} books by ${series.author || 'Unknown'} [${canonicalGenre}]`);
        saved++;
      } else {
        console.log(`${progress} 📋 ${series.name} - ${series.books.length} books by ${series.author || 'Unknown'} (dry run)`);
      }
    } catch (error) {
      console.log(`${progress} ❌ ${seriesName}: ${error}`);
      errors++;
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Seed Import Summary:');
  console.log(`  Genre: ${canonicalGenre}`);
  console.log(`  Processed: ${toProcess.length}`);
  console.log(`  Already in DB: ${alreadyExists}`);
  console.log(`  Fetched from Goodreads: ${fetched}`);
  console.log(`  ${save ? 'Saved' : 'Would save'}: ${saved}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Filtered (non-English): ${filtered}`);
  console.log(`  Errors: ${errors}`);
  
  if (!save) {
    console.log('\n💡 Run with --save to persist to database');
  } else {
    const stats = getStats();
    console.log(`\n📈 Database now has ${stats.totalSeries} series, ${stats.totalBooks} books`);
  }
}

// =============================================================================
// Goodreads Shelf Import (Combo 1, Layer 2)
// =============================================================================

/**
 * Import series by scraping Goodreads genre shelves.
 * Discovers series names from community-tagged shelves, then
 * fetches full series data via Goodreads on-demand lookup.
 */
async function runShelfImport(genre: string, save = false, maxPages = 5) {
  console.log('📚 Goodreads Shelf Import');
  console.log('─'.repeat(50));
  
  if (!GENRE_SHELF_MAP[genre]) {
    console.log(`❌ Unknown genre: ${genre}`);
    console.log(`Available genres: ${Object.keys(GENRE_SHELF_MAP).join(', ')}`);
    return;
  }
  
  console.log(`🏷️  Genre: ${genre}`);
  console.log(`📄 Pages per shelf: ${maxPages}`);
  console.log(`📁 Save to database: ${save ? 'Yes' : 'No (dry run)'}`);
  console.log('─'.repeat(50));
  
  // Phase 1: Discover series names from shelves
  console.log('\n📡 Phase 1: Discovering series from Goodreads shelves...\n');
  
  const discoveredSeries = await discoverSeriesFromShelves(genre, maxPages, (shelf, total) => {
    console.log(`  [Shelf: ${shelf}] Total unique series so far: ${total}`);
  });
  
  console.log(`\n📊 Discovered ${discoveredSeries.length} unique series from shelves\n`);
  
  if (discoveredSeries.length === 0) {
    console.log('No series found. Shelves may require sign-in or have changed format.');
    return;
  }
  
  if (!save) {
    // Dry run — just show what we found
    console.log('Top 30 discovered series:');
    for (const s of discoveredSeries.slice(0, 30)) {
      const existing = findSeriesByName(s.name);
      const status = existing ? `✅ in DB${existing.genre ? ` [${existing.genre}]` : ''}` : '🆕 NEW';
      console.log(`  ${status} ${s.name} by ${s.author}`);
    }
    if (discoveredSeries.length > 30) {
      console.log(`  ... and ${discoveredSeries.length - 30} more`);
    }
    
    // Count how many are new
    const newCount = discoveredSeries.filter(s => !findSeriesByName(s.name)).length;
    console.log(`\n📊 ${newCount} new series (not in DB), ${discoveredSeries.length - newCount} already exist`);
    console.log('💡 Run with --save to fetch full details and persist new series');
    return;
  }
  
  // Phase 2: For each NEW series, fetch full data via Goodreads and save
  console.log('📥 Phase 2: Fetching and saving new series...\n');
  
  const db = getDb();
  let alreadyExists = 0;
  let saved = 0;
  let notFound = 0;
  let filtered = 0;
  let errors = 0;
  
  for (let i = 0; i < discoveredSeries.length; i++) {
    const seriesRef = discoveredSeries[i];
    const progress = `[${i + 1}/${discoveredSeries.length}]`;
    
    // Language filter
    if (shouldFilterSeries(seriesRef.name)) {
      console.log(`${progress} 🌍 ${seriesRef.name} (non-English, skipped)`);
      filtered++;
      continue;
    }
    
    // Check if already in database
    const existing = findSeriesByName(seriesRef.name);
    if (existing) {
      // Update genre if missing
      if (!existing.genre || existing.genre === 'fiction') {
        updateSeriesGenre(existing.id, genre);
      }
      alreadyExists++;
      continue; // Silent skip for existing — too many to log
    }
    
    // Fetch full series data from Goodreads
    try {
      const series = await fetchGoodreads(seriesRef.name);
      
      if (!series || series.books.length === 0) {
        console.log(`${progress} ⚠️  ${seriesRef.name} (not found on Goodreads)`);
        notFound++;
        continue;
      }
      
      // Save to database
      const seriesId = saveSourceSeries(series, series.sourceId);
      updateSeriesGenre(seriesId, genre);
      
      console.log(`${progress} ✅ ${series.name} - ${series.books.length} books [${genre}]`);
      saved++;
    } catch (error) {
      console.log(`${progress} ❌ ${seriesRef.name}: ${error}`);
      errors++;
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Shelf Import Summary:');
  console.log(`  Genre: ${genre}`);
  console.log(`  Discovered from shelves: ${discoveredSeries.length}`);
  console.log(`  Already in DB: ${alreadyExists}`);
  console.log(`  Saved: ${saved}`);
  console.log(`  Not found on Goodreads: ${notFound}`);
  console.log(`  Filtered (non-English): ${filtered}`);
  console.log(`  Errors: ${errors}`);
  
  const stats = getStats();
  console.log(`\n📈 Database now has ${stats.totalSeries} series, ${stats.totalBooks} books`);
}

// =============================================================================
// Google Books Enrichment (Combo 1, Layer 3)
// =============================================================================

/**
 * Enrich existing series with descriptions and ISBNs from Google Books.
 * Processes series that are missing descriptions, updating them in place.
 */
async function runGoogleBooksEnrich(limit = 100, genre?: string, doDescriptions = true, doIsbns = false, seriesFilter?: string) {
  console.log('📖 Google Books Enrichment');
  console.log('─'.repeat(50));
  console.log(`📊 Limit: ${limit} series`);
  if (genre) console.log(`🏷️  Genre filter: ${genre}`);
  if (seriesFilter) console.log(`📌 Series filter: ${seriesFilter}`);
  console.log(`📝 Descriptions: ${doDescriptions ? 'Yes' : 'No'}`);
  console.log(`🔢 ISBNs: ${doIsbns ? 'Yes' : 'No'}`);
  console.log('─'.repeat(50));
  
  const db = getDb();
  
  // Get series needing enrichment
  let query: string;
  const params: (string | number)[] = [];
  
  if (doDescriptions) {
    query = `
      SELECT s.id, s.name, s.author, s.genre, s.description
      FROM series s
      WHERE (s.description IS NULL OR s.description = '')
      ${genre ? 'AND s.genre = ?' : ''}
      ${seriesFilter ? 'AND s.name_normalized LIKE ?' : ''}
      ORDER BY s.confidence DESC, s.total_books DESC
      LIMIT ?
    `;
    if (genre) params.push(genre);
    if (seriesFilter) params.push(`%${seriesFilter.toLowerCase().replace(/[^\w\s]/g, '')}%`);
    params.push(limit);
  } else {
    // ISBNs only — get series that have books without ISBNs
    query = `
      SELECT DISTINCT s.id, s.name, s.author, s.genre, s.description
      FROM series s
      JOIN series_book sb ON sb.series_id = s.id
      WHERE (sb.isbn IS NULL OR sb.isbn = '')
      ${genre ? 'AND s.genre = ?' : ''}
      ${seriesFilter ? 'AND s.name_normalized LIKE ?' : ''}
      ORDER BY s.confidence DESC
      LIMIT ?
    `;
    if (genre) params.push(genre);
    if (seriesFilter) params.push(`%${seriesFilter.toLowerCase().replace(/[^\w\s]/g, '')}%`);
    params.push(limit);
  }
  
  const seriesToEnrich = db.prepare(query).all(...params) as Array<{
    id: string; name: string; author: string | null; genre: string | null; description: string | null;
  }>;
  
  console.log(`\nFound ${seriesToEnrich.length} series to enrich\n`);
  
  let descriptionsAdded = 0;
  let isbnsAdded = 0;
  let noResults = 0;
  let errors = 0;
  
  for (let i = 0; i < seriesToEnrich.length; i++) {
    const series = seriesToEnrich[i];
    const progress = `[${i + 1}/${seriesToEnrich.length}]`;
    
    try {
      // Get the books for this series (for description lookup and ISBN enrichment)
      const books = db.prepare(`
        SELECT id, title, author, isbn FROM series_book WHERE series_id = ? ORDER BY position ASC LIMIT 5
      `).all(series.id) as Array<{ id: string; title: string; author: string | null; isbn: string | null }>;
      
      // Enrich description
      if (doDescriptions && (!series.description || series.description === '')) {
        // Build lookup list: use books if available, otherwise try series name directly
        const lookupBooks = books.length > 0
          ? books.map(b => ({ title: b.title, author: b.author || series.author || undefined }))
          : [{ title: series.name, author: series.author || undefined }];
        
        const descResult = await getSeriesDescription(lookupBooks, series.name);
        
        if (descResult) {
          db.prepare("UPDATE series SET description = ?, updated_at = datetime('now') WHERE id = ?")
            .run(descResult.description, series.id);
          console.log(`${progress} 📝 ${series.name} — description added (${descResult.description.length} chars)`);
          descriptionsAdded++;
        } else {
          console.log(`${progress} ⏭️  ${series.name} — no description found`);
          noResults++;
        }
      }
      
      // Enrich ISBNs
      if (doIsbns && books.length > 0) {
        for (const book of books) {
          if (book.isbn) continue; // Already has ISBN
          
          const enrichment = await searchBook(book.title, book.author || series.author || undefined);
          
          if (enrichment?.isbn13 || enrichment?.isbn10) {
            const isbn = enrichment.isbn13 || enrichment.isbn10;
            db.prepare("UPDATE series_book SET isbn = ?, updated_at = datetime('now') WHERE id = ?")
              .run(isbn, book.id);
            isbnsAdded++;
          }
        }
        console.log(`${progress} 🔢 ${series.name} — ISBNs checked`);
      }
    } catch (error) {
      console.log(`${progress} ❌ ${series.name}: ${error}`);
      errors++;
    }
  }
  
  console.log('');
  console.log('─'.repeat(50));
  console.log('📊 Enrichment Summary:');
  console.log(`  Processed: ${seriesToEnrich.length} series`);
  if (doDescriptions) console.log(`  Descriptions added: ${descriptionsAdded}`);
  if (doIsbns) console.log(`  ISBNs added: ${isbnsAdded}`);
  console.log(`  No results: ${noResults}`);
  console.log(`  Errors: ${errors}`);
}

// =============================================================================
// Book-Level Description Enrichment (enrich-books)
// =============================================================================

/**
 * Enrich individual book records with descriptions from Google Books.
 * Unlike the series-level 'enrich' command, this stores descriptions
 * on each series_book row so NachoReads can serve them instantly.
 */
async function runEnrichBookDescriptions(limit = 500, genre?: string, dryRun = false, seriesFilter?: string) {
  console.log('📖 Book Description Enrichment');
  console.log('─'.repeat(60));
  
  // Show current stats
  const statsBefore = getDescriptionStats();
  console.log(`📊 Current: ${statsBefore.withDescription}/${statsBefore.totalBooks} books have descriptions (${statsBefore.percentage}%)`);
  console.log(`📝 To enrich: up to ${limit} books`);
  if (genre) console.log(`🏷️  Genre filter: ${genre}`);
  if (seriesFilter) console.log(`📌 Series filter: ${seriesFilter}`);
  if (dryRun) console.log('🔍 DRY RUN — no changes will be saved');
  console.log('─'.repeat(60));
  console.log('');
  
  // Get books needing descriptions
  const books = getBooksNeedingDescriptions(limit, genre, seriesFilter);
  
  if (books.length === 0) {
    console.log('✅ All books already have descriptions!');
    return;
  }
  
  console.log(`Found ${books.length} books needing descriptions\n`);
  
  let enriched = 0;
  let noResults = 0;
  let errors = 0;
  let rateLimitHits = 0;
  
  // Track by series for cleaner output
  let currentSeriesId = '';
  
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const progress = `[${i + 1}/${books.length}]`;
    
    // Log series header when series changes
    if (book.series_id !== currentSeriesId) {
      currentSeriesId = book.series_id;
      console.log(`\n📚 ${book.series_name}${book.series_author ? ` — ${book.series_author}` : ''}`);
    }
    
    try {
      // Use the book's own author, fall back to series author
      const author = book.author || book.series_author || undefined;
      
      let description: string | null = null;
      let descSource = 'google-books';
      
      // Try Open Library first (no daily quota, 5 req/sec)
      try {
        if (isOLAvailable()) {
          const olResult = await searchBookDescription(book.title, author);
          if (olResult && olResult.description.length > 30) {
            description = olResult.description;
            descSource = 'openlibrary';
          }
        }
      } catch (e) {
        if (e instanceof OLCircuitOpenError) {
          // Circuit just tripped — skip OL for this book, fall through to GB
        } else {
          throw e;
        }
      }
      
      // Fallback 1: try Google Books if Open Library missed
      if (!description && hasQuota('google-books')) {
        console.log(`    ↳ Open Library miss, trying Google Books...`);
        const enrichment = await searchBook(book.title, author);
        if (enrichment?.description && enrichment.description.length > 30) {
          description = enrichment.description;
          descSource = 'google-books';
        }
      }
      
      // Fallback 2: try iTunes if both missed
      if (!description) {
        console.log(`    ↳ Google Books miss, trying iTunes...`);
        const itunesResult = await searchITunesDescription(book.title, author);
        if (itunesResult && itunesResult.description.length > 30) {
          description = itunesResult.description;
          descSource = 'itunes';
        }
      }
      
      if (description) {
        if (!dryRun) {
          updateBookDescription(book.id, description);
        }
        
        const srcLabel = descSource === 'openlibrary' ? ' [OL]' : descSource === 'itunes' ? ' [iTunes]' : '';
        const truncated = description.length > 80 
          ? description.substring(0, 77) + '...' 
          : description;
        console.log(`  ${progress} ✅ ${book.title}${srcLabel} (${description.length} chars) — ${truncated}`);
        enriched++;
      } else {
        console.log(`  ${progress} ⏭️  ${book.title} — no description found`);
        noResults++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429')) {
        rateLimitHits++;
        console.log(`  ${progress} ⏳ Rate limited, waiting 15s...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        i--; // Retry this book
        continue;
      }
      console.log(`  ${progress} ❌ ${book.title}: ${msg}`);
      errors++;
    }
    
    // Extra safety: if we hit 3 consecutive rate limits, slow down permanently
    if (rateLimitHits >= 3) {
      console.log('\n⚠️  Multiple rate limits hit. Slowing to 1 req/sec...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      rateLimitHits = 0;
    }
  }
  
  // Final stats
  const statsAfter = dryRun ? statsBefore : getDescriptionStats();
  
  console.log('');
  console.log('─'.repeat(60));
  console.log('📊 Book Description Enrichment Summary');
  console.log('─'.repeat(60));
  console.log(`  Processed: ${books.length} books`);
  console.log(`  Enriched:  ${enriched} books got descriptions`);
  console.log(`  No result: ${noResults}`);
  console.log(`  Errors:    ${errors}`);
  if (dryRun) {
    console.log(`  ⚠️  DRY RUN — no changes saved`);
  } else {
    console.log(`  Before:    ${statsBefore.withDescription}/${statsBefore.totalBooks} (${statsBefore.percentage}%)`);
    console.log(`  After:     ${statsAfter.withDescription}/${statsAfter.totalBooks} (${statsAfter.percentage}%)`);
  }
}

// =============================================================================
// Autonomous Enrichment (auto-enrich)
// =============================================================================

interface AutoEnrichOptions {
  genre?: string;
  booksOnly?: boolean;
  seriesOnly?: boolean;
}

/**
 * Fully autonomous enrichment runner.
 * - Runs series descriptions first, then book descriptions
 * - Processes in batches of 200
 * - Pauses when OL circuit breaker trips (waits for recovery)
 * - Stops Google Books/iTunes calls when daily quota exhausted
 * - Sleeps until midnight UTC when all quotas exhausted and OL can't help
 * - Resumes automatically the next day
 * - Runs until everything is enriched
 */
async function runAutoEnrich(options: AutoEnrichOptions) {
  initQuotaTable();
  cleanOldQuotas();

  const BATCH_SIZE = 200;
  const startTime = Date.now();
  let totalSeriesEnriched = 0;
  let totalBooksEnriched = 0;

  console.log('');
  console.log('═'.repeat(60));
  console.log('🤖 AUTO-ENRICH — Autonomous Enrichment Mode');
  console.log('═'.repeat(60));
  console.log(`  Started: ${new Date().toISOString()}`);
  if (options.genre) console.log(`  Genre filter: ${options.genre}`);
  if (options.booksOnly) console.log(`  Mode: Books only`);
  if (options.seriesOnly) console.log(`  Mode: Series only`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  OL circuit breaker: enabled`);
  console.log(`  Google Books daily quota: tracked`);
  console.log('═'.repeat(60));
  console.log('');

  // --- Phase 1: Series Descriptions ---
  if (!options.booksOnly) {
    console.log('📚 Phase 1: Series Descriptions');
    console.log('─'.repeat(60));

    let seriesDone = false;
    while (!seriesDone) {
      // Check OL availability
      if (!isOLAvailable()) {
        const status = olCircuitBreaker.getStatus();
        const waitSec = Math.ceil(status.cooldownRemainingMs / 1000);
        console.log(`⏸️  OL circuit breaker OPEN — waiting ${waitSec}s for recovery...`);
        await sleep(status.cooldownRemainingMs + 1000);
        continue;
      }

      try {
        // Series enrichment uses runGoogleBooksEnrich which tries OL first then GB
        const db = getDb();
        let query = `SELECT COUNT(*) as cnt FROM series WHERE (description IS NULL OR description = '')`;
        const params: (string | number)[] = [];
        if (options.genre) {
          query += ' AND genre = ?';
          params.push(options.genre);
        }
        const remaining = (db.prepare(query).get(...params) as { cnt: number }).cnt;

        if (remaining === 0) {
          console.log('✅ All series have descriptions!');
          seriesDone = true;
          break;
        }

        console.log(`\n📊 ${remaining} series still need descriptions`);
        const batchLimit = Math.min(BATCH_SIZE, remaining);

        await runGoogleBooksEnrich(batchLimit, options.genre, true, false);
        totalSeriesEnriched += batchLimit; // Approximate

        // Brief pause between batches
        await sleep(2000);
      } catch (error) {
        if (error instanceof OLCircuitOpenError) {
          console.log('⏸️  OL went down mid-batch, will retry after cooldown...');
          await sleep(30000);
          continue;
        }
        console.error('❌ Series enrichment error:', error);
        await sleep(5000);
      }
    }
  }

  // --- Phase 2: Book Descriptions ---
  if (!options.seriesOnly) {
    console.log('\n📖 Phase 2: Book Descriptions');
    console.log('─'.repeat(60));

    let booksDone = false;
    let consecutiveEmptyBatches = 0;

    while (!booksDone) {
      // Check how many books still need descriptions
      const statsNow = getDescriptionStats();
      const booksRemaining = statsNow.totalBooks - statsNow.withDescription;

      if (booksRemaining === 0) {
        console.log('✅ All books have descriptions!');
        booksDone = true;
        break;
      }

      // Check OL availability
      const olUp = isOLAvailable();
      const gbAvailable = hasQuota('google-books');

      if (!olUp && !gbAvailable) {
        // Both sources down/exhausted — sleep until quota reset
        const resetSec = secondsUntilReset();
        const status = olCircuitBreaker.getStatus();
        
        if (status.state === 'OPEN') {
          // OL is down AND Google quota exhausted — wait for OL first, it might recover
          const waitSec = Math.ceil(status.cooldownRemainingMs / 1000);
          console.log(`⏸️  OL circuit OPEN + Google quota exhausted — waiting ${waitSec}s for OL recovery...`);
          await sleep(status.cooldownRemainingMs + 1000);
          continue;
        } else {
          // OL returned no results for a while, Google exhausted — sleep until reset
          console.log(`💤 All sources exhausted. Sleeping ${Math.ceil(resetSec / 60)} minutes until quota reset (${new Date(Date.now() + resetSec * 1000).toISOString()})...`);
          printAutoEnrichProgress(startTime, totalSeriesEnriched, totalBooksEnriched, statsNow);
          await sleep(resetSec * 1000 + 5000);
          cleanOldQuotas();
          console.log('\n🔄 New day — resuming enrichment');
          consecutiveEmptyBatches = 0;
          continue;
        }
      }

      if (!olUp) {
        const status = olCircuitBreaker.getStatus();
        const waitSec = Math.ceil(status.cooldownRemainingMs / 1000);
        console.log(`⏸️  OL circuit breaker OPEN — waiting ${waitSec}s (Google Books still available: ${gbAvailable})...`);
        await sleep(status.cooldownRemainingMs + 1000);
        continue;
      }

      // Run a batch
      const batchLimit = Math.min(BATCH_SIZE, booksRemaining);
      console.log(`\n📊 ${booksRemaining} books remaining | Google Books: ${gbAvailable ? 'available' : 'quota exhausted'}`);

      const beforeStats = getDescriptionStats();

      try {
        await runEnrichBookDescriptions(batchLimit, options.genre, false);
      } catch (error) {
        if (error instanceof OLCircuitOpenError) {
          console.log('⏸️  OL went down mid-batch, will retry after cooldown...');
          await sleep(30000);
          continue;
        }
        console.error('❌ Book enrichment error:', error);
        await sleep(5000);
        continue;
      }

      const afterStats = getDescriptionStats();
      const batchEnriched = afterStats.withDescription - beforeStats.withDescription;
      totalBooksEnriched += batchEnriched;

      if (batchEnriched === 0) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= 3) {
          // Three consecutive batches with zero results — all remaining books are unenrichable
          console.log(`\n⚠️  ${consecutiveEmptyBatches} consecutive empty batches — remaining ${booksRemaining} books appear unenrichable`);
          
          if (!gbAvailable) {
            // Google exhausted, maybe it could help tomorrow
            const resetSec = secondsUntilReset();
            console.log(`💤 Sleeping until quota reset to try Google Books fallback...`);
            await sleep(resetSec * 1000 + 5000);
            cleanOldQuotas();
            consecutiveEmptyBatches = 0;
            continue;
          }
          
          booksDone = true;
          break;
        }
      } else {
        consecutiveEmptyBatches = 0;
      }

      // Brief pause between batches
      await sleep(2000);
    }
  }

  // Final report
  const elapsed = Date.now() - startTime;
  const statsEnd = getDescriptionStats();
  console.log('');
  console.log('═'.repeat(60));
  console.log('🤖 AUTO-ENRICH COMPLETE');
  console.log('═'.repeat(60));
  printAutoEnrichProgress(startTime, totalSeriesEnriched, totalBooksEnriched, statsEnd);
  console.log(`  Total runtime: ${formatDuration(elapsed)}`);
  console.log('═'.repeat(60));
}

function printAutoEnrichProgress(
  startTime: number,
  seriesEnriched: number,
  booksEnriched: number,
  stats: { withDescription: number; totalBooks: number; percentage: number }
) {
  const elapsed = Date.now() - startTime;
  const quotas = getAllQuotas();
  console.log(`  Runtime: ${formatDuration(elapsed)}`);
  console.log(`  Books enriched this session: ~${booksEnriched}`);
  console.log(`  Book coverage: ${stats.withDescription}/${stats.totalBooks} (${stats.percentage}%)`);
  for (const [svc, q] of Object.entries(quotas)) {
    console.log(`  ${svc} quota: ${q.used}/${q.limit} used (${q.remaining} remaining)`);
  }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Automated Full Discovery (discover-all)
// =============================================================================

interface DiscoverAllOptions {
  shelfPages: number;
  skipSeeds: boolean;
  skipShelves: boolean;
  skipEnrich: boolean;
}

/**
 * Automated full-scan discovery pipeline.
 * Runs through ALL sources (seeds, shelves, enrichment) until everything is processed.
 * Respects all rate limits built into each source module.
 */
async function runDiscoverAll(options: DiscoverAllOptions) {
  const globalStart = Date.now();
  const statsBefore = getStats();
  
  const formatElapsed = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };
  
  console.log('🚀 FULL AUTOMATED DISCOVERY');
  console.log('═'.repeat(60));
  console.log(`📅 Started: ${new Date().toISOString()}`);
  console.log(`📊 Database before: ${statsBefore.totalSeries} series, ${statsBefore.totalBooks} books`);
  console.log(`🔧 Shelf pages per genre: ${options.shelfPages}`);
  console.log(`⏭️  Skip seeds: ${options.skipSeeds}  | Skip shelves: ${options.skipShelves}  | Skip enrich: ${options.skipEnrich}`);
  console.log('═'.repeat(60));
  
  const phaseResults: Array<{
    phase: string;
    newSeries: number;
    newBooks: number;
    elapsed: number;
  }> = [];
  
  // ─── Seed File Genre Mapping ───
  const seedGenreMap: Record<string, string> = {
    'litrpg': 'litrpg',
    'post-apocalyptic': 'post-apocalyptic',
    'fantasy-supplemental': 'fantasy',
    'science-fiction-supplemental': 'science-fiction',
    'fantasy': 'fantasy',
    'science-fiction': 'science-fiction',
    'horror': 'horror',
    'romance': 'romance',
    'mystery': 'mystery',
    'thriller': 'thriller',
  };
  
  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Seed File Imports (Layer 1 — highest precision)
  // ═══════════════════════════════════════════════════════════════
  if (!options.skipSeeds) {
    const seedDir = join(process.cwd(), 'data', 'seeds');
    
    if (existsSync(seedDir)) {
      const seedFiles = readdirSync(seedDir)
        .filter(f => f.endsWith('.txt'))
        .map(f => f.replace('.txt', ''));
      
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`📦 PHASE 1: SEED FILE IMPORTS (${seedFiles.length} files)`);
      console.log('═'.repeat(60));
      
      for (const seedName of seedFiles) {
        const phaseStart = Date.now();
        const beforeStats = getStats();
        
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`🌱 Seed file: ${seedName}`);
        console.log('─'.repeat(50));
        
        const seedFile = join(seedDir, `${seedName}.txt`);
        const content = readFileSync(seedFile, 'utf-8');
        const seriesNames = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
        
        // Deduplicate
        const seen = new Set<string>();
        const uniqueNames = seriesNames.filter(name => {
          const key = name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        
        const canonicalGenre = seedGenreMap[seedName] || seedName;
        const db = getDb();
        let saved = 0;
        let skipped = 0;
        let notFound = 0;
        let errors = 0;
        
        console.log(`  📊 ${uniqueNames.length} unique names | Genre: ${canonicalGenre}`);
        
        for (let i = 0; i < uniqueNames.length; i++) {
          const seriesName = uniqueNames[i];
          
          // Language filter
          if (shouldFilterSeries(seriesName)) { skipped++; continue; }
          
          // Already in DB?
          const existing = findSeriesByName(seriesName);
          if (existing) {
            // Update genre if missing
            if (!existing.genre || existing.genre === 'fiction') {
              updateSeriesGenre(existing.id, canonicalGenre);
            }
            skipped++;
            continue;
          }
          
          // Fetch from Goodreads
          try {
            const series = await fetchGoodreads(seriesName);
            if (!series || series.books.length === 0) {
              notFound++;
              continue;
            }
            
            const seriesId = saveSourceSeries(series, series.sourceId);
            updateSeriesGenre(seriesId, canonicalGenre);
            saved++;
            
            if (saved % 5 === 0 || saved === 1) {
              const elapsed = formatElapsed(Date.now() - phaseStart);
              console.log(`  [${seedName}] ✅ ${saved} saved so far (${i + 1}/${uniqueNames.length}) | ${elapsed}`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`  [${seedName}] ❌ ${seriesName}: ${msg}`);
            errors++;
          }
        }
        
        const afterStats = getStats();
        const phaseElapsed = Date.now() - phaseStart;
        
        phaseResults.push({
          phase: `Seeds: ${seedName}`,
          newSeries: afterStats.totalSeries - beforeStats.totalSeries,
          newBooks: afterStats.totalBooks - beforeStats.totalBooks,
          elapsed: phaseElapsed,
        });
        
        console.log(`  ✅ Done: +${afterStats.totalSeries - beforeStats.totalSeries} series, +${afterStats.totalBooks - beforeStats.totalBooks} books | ${formatElapsed(phaseElapsed)} | Skipped: ${skipped} | NotFound: ${notFound} | Errors: ${errors}`);
      }
    } else {
      console.log('\n⚠️  No seed directory found, skipping Phase 1');
    }
  } else {
    console.log('\n⏭️  Phase 1 (Seeds) — skipped by flag');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Goodreads Shelf Scraping (Layer 2 — bulk discovery)
  // ═══════════════════════════════════════════════════════════════
  if (!options.skipShelves) {
    const shelfGenres = Object.keys(GENRE_SHELF_MAP);
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📚 PHASE 2: SHELF SCRAPING (${shelfGenres.length} genres, ${options.shelfPages} pages each)`);
    console.log('═'.repeat(60));
    
    for (const genre of shelfGenres) {
      const phaseStart = Date.now();
      const beforeStats = getStats();
      
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`📚 Shelf genre: ${genre} (${GENRE_SHELF_MAP[genre].length} shelf tags)`);
      console.log('─'.repeat(50));
      
      // Phase 2a: Discover series names from shelves
      let discoveredSeries: Array<{ name: string; author: string }>;
      try {
        discoveredSeries = await discoverSeriesFromShelves(genre, options.shelfPages, (shelf, total) => {
          console.log(`  [${shelf}] ${total} unique series discovered`);
        });
      } catch (error) {
        console.log(`  ❌ Shelf scraping failed: ${error}`);
        phaseResults.push({ phase: `Shelves: ${genre}`, newSeries: 0, newBooks: 0, elapsed: Date.now() - phaseStart });
        continue;
      }
      
      console.log(`  📊 Discovered ${discoveredSeries.length} series from shelves`);
      
      // Phase 2b: Fetch and save new series
      let saved = 0;
      let skipped = 0;
      let notFound = 0;
      let errors = 0;
      
      for (let i = 0; i < discoveredSeries.length; i++) {
        const seriesRef = discoveredSeries[i];
        
        if (shouldFilterSeries(seriesRef.name)) { skipped++; continue; }
        
        const existing = findSeriesByName(seriesRef.name);
        if (existing) {
          if (!existing.genre || existing.genre === 'fiction') {
            updateSeriesGenre(existing.id, genre);
          }
          skipped++;
          continue;
        }
        
        try {
          const series = await fetchGoodreads(seriesRef.name);
          if (!series || series.books.length === 0) {
            notFound++;
            continue;
          }
          
          const seriesId = saveSourceSeries(series, series.sourceId);
          updateSeriesGenre(seriesId, genre);
          saved++;
          
          if (saved % 10 === 0 || saved === 1) {
            const elapsed = formatElapsed(Date.now() - phaseStart);
            console.log(`  [${genre}] ✅ ${saved} saved so far (${i + 1}/${discoveredSeries.length}) | ${elapsed}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.log(`  [${genre}] ❌ ${seriesRef.name}: ${msg}`);
          errors++;
        }
      }
      
      const afterStats = getStats();
      const phaseElapsed = Date.now() - phaseStart;
      
      phaseResults.push({
        phase: `Shelves: ${genre}`,
        newSeries: afterStats.totalSeries - beforeStats.totalSeries,
        newBooks: afterStats.totalBooks - beforeStats.totalBooks,
        elapsed: phaseElapsed,
      });
      
      console.log(`  ✅ Done: +${afterStats.totalSeries - beforeStats.totalSeries} series, +${afterStats.totalBooks - beforeStats.totalBooks} books | ${formatElapsed(phaseElapsed)} | Skipped: ${skipped} | NotFound: ${notFound} | Errors: ${errors}`);
    }
  } else {
    console.log('\n⏭️  Phase 2 (Shelves) — skipped by flag');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Google Books Enrichment (Layer 3 — metadata quality)
  // ═══════════════════════════════════════════════════════════════
  if (!options.skipEnrich) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('📖 PHASE 3: GOOGLE BOOKS ENRICHMENT');
    console.log('═'.repeat(60));
    
    const db = getDb();
    
    // 3a: Descriptions (batch of 500 at a time, loop until all done)
    console.log('\n📝 Phase 3a: Adding descriptions...');
    
    let totalDescriptions = 0;
    let descBatchNum = 0;
    const ENRICH_BATCH = 500;
    
    while (true) {
      descBatchNum++;
      const phaseStart = Date.now();
      
      const seriesToEnrich = db.prepare(`
        SELECT s.id, s.name, s.author, s.genre, s.description
        FROM series s
        WHERE (s.description IS NULL OR s.description = '')
        ORDER BY s.confidence DESC, s.total_books DESC
        LIMIT ?
      `).all(ENRICH_BATCH) as Array<{
        id: string; name: string; author: string | null; genre: string | null; description: string | null;
      }>;
      
      if (seriesToEnrich.length === 0) {
        console.log('  ✅ All series have descriptions (or no more to process)');
        break;
      }
      
      console.log(`  Batch ${descBatchNum}: ${seriesToEnrich.length} series without descriptions`);
      
      let added = 0;
      let noResult = 0;
      let errors = 0;
      
      for (let i = 0; i < seriesToEnrich.length; i++) {
        const series = seriesToEnrich[i];
        
        try {
          const books = db.prepare(`
            SELECT id, title, author, isbn FROM series_book WHERE series_id = ? ORDER BY position ASC LIMIT 5
          `).all(series.id) as Array<{ id: string; title: string; author: string | null; isbn: string | null }>;
          
          const lookupBooks = books.length > 0
            ? books.map(b => ({ title: b.title, author: b.author || series.author || undefined }))
            : [{ title: series.name, author: series.author || undefined }];
          
          const descResult = await getSeriesDescription(lookupBooks, series.name);
          
          if (descResult) {
            db.prepare("UPDATE series SET description = ?, updated_at = datetime('now') WHERE id = ?")
              .run(descResult.description, series.id);
            added++;
          } else {
            // Mark as attempted so we don't retry forever (store empty placeholder)
            db.prepare("UPDATE series SET description = '[none]', updated_at = datetime('now') WHERE id = ?")
              .run(series.id);
            noResult++;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (errors < 5) console.log(`  ❌ ${series.name}: ${msg}`);
          else if (errors === 5) console.log(`  ❌ (suppressing further error messages)`);
          errors++;
        }
        
        // Progress every 50
        if ((i + 1) % 50 === 0) {
          const elapsed = formatElapsed(Date.now() - phaseStart);
          const rate = ((i + 1) / ((Date.now() - phaseStart) / 1000)).toFixed(1);
          const remaining = seriesToEnrich.length - i - 1;
          const eta = formatElapsed(remaining / parseFloat(rate) * 1000);
          console.log(`  [Desc batch ${descBatchNum}] ${i + 1}/${seriesToEnrich.length} | +${added} descriptions | ${rate}/sec | ETA: ${eta}`);
        }
      }
      
      totalDescriptions += added;
      console.log(`  Batch ${descBatchNum} done: +${added} descriptions, ${noResult} no-result, ${errors} errors | ${formatElapsed(Date.now() - phaseStart)}`);
      
      // If we got a full batch, there might be more
      if (seriesToEnrich.length < ENRICH_BATCH) break;
    }
    
    // 3b: ISBNs (batch of 500 at a time)
    console.log('\n🔢 Phase 3b: Adding ISBNs...');
    
    let totalIsbns = 0;
    let isbnBatchNum = 0;
    
    while (true) {
      isbnBatchNum++;
      const phaseStart = Date.now();
      
      const booksToEnrich = db.prepare(`
        SELECT sb.id, sb.title, sb.author, sb.series_id, s.author as series_author
        FROM series_book sb
        JOIN series s ON sb.series_id = s.id
        WHERE (sb.isbn IS NULL OR sb.isbn = '')
        ORDER BY s.confidence DESC
        LIMIT ?
      `).all(ENRICH_BATCH) as Array<{
        id: string; title: string; author: string | null; series_id: string; series_author: string | null;
      }>;
      
      if (booksToEnrich.length === 0) {
        console.log('  ✅ All books have ISBNs (or no more to process)');
        break;
      }
      
      console.log(`  Batch ${isbnBatchNum}: ${booksToEnrich.length} books without ISBNs`);
      
      let added = 0;
      let noResult = 0;
      let errors = 0;
      
      for (let i = 0; i < booksToEnrich.length; i++) {
        const book = booksToEnrich[i];
        
        try {
          const enrichment = await searchBook(book.title, book.author || book.series_author || undefined);
          
          if (enrichment?.isbn13 || enrichment?.isbn10) {
            const isbn = enrichment.isbn13 || enrichment.isbn10;
            db.prepare("UPDATE series_book SET isbn = ?, updated_at = datetime('now') WHERE id = ?")
              .run(isbn, book.id);
            added++;
          } else {
            // Mark as attempted
            db.prepare("UPDATE series_book SET isbn = 'none', updated_at = datetime('now') WHERE id = ?")
              .run(book.id);
            noResult++;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (errors < 5) console.log(`  ❌ ISBN error: ${msg}`);
          else if (errors === 5) console.log(`  ❌ (suppressing further error messages)`);
          errors++;
        }
        
        // Progress every 100
        if ((i + 1) % 100 === 0) {
          const elapsed = formatElapsed(Date.now() - phaseStart);
          const rate = ((i + 1) / ((Date.now() - phaseStart) / 1000)).toFixed(1);
          const remaining = booksToEnrich.length - i - 1;
          const eta = formatElapsed(remaining / parseFloat(rate) * 1000);
          console.log(`  [ISBN batch ${isbnBatchNum}] ${i + 1}/${booksToEnrich.length} | +${added} ISBNs | ${rate}/sec | ETA: ${eta}`);
        }
      }
      
      totalIsbns += added;
      console.log(`  Batch ${isbnBatchNum} done: +${added} ISBNs, ${noResult} no-result, ${errors} errors | ${formatElapsed(Date.now() - phaseStart)}`);
      
      if (booksToEnrich.length < ENRICH_BATCH) break;
    }
    
    phaseResults.push({
      phase: 'Enrichment (descriptions)',
      newSeries: 0,
      newBooks: 0,
      elapsed: 0, // tracked in sub-batches
    });
    
    console.log(`\n  📊 Enrichment totals: +${totalDescriptions} descriptions, +${totalIsbns} ISBNs`);
  } else {
    console.log('\n⏭️  Phase 3 (Enrichment) — skipped by flag');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════════
  const statsAfter = getStats();
  const totalElapsed = Date.now() - globalStart;
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log('🏁 DISCOVER-ALL COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  ⏱️  Total time: ${formatElapsed(totalElapsed)}`);
  console.log(`  📅 Finished: ${new Date().toISOString()}`);
  console.log('');
  console.log(`  Series: ${statsBefore.totalSeries} → ${statsAfter.totalSeries} (+${statsAfter.totalSeries - statsBefore.totalSeries})`);
  console.log(`  Books:  ${statsBefore.totalBooks} → ${statsAfter.totalBooks} (+${statsAfter.totalBooks - statsBefore.totalBooks})`);
  
  console.log('');
  console.log('  Phase Breakdown:');
  console.log('  ' + '─'.repeat(56));
  for (const r of phaseResults) {
    const pad = r.phase.padEnd(30);
    console.log(`  ${pad} +${r.newSeries} series, +${r.newBooks} books (${formatElapsed(r.elapsed)})`);
  }
  
  console.log('');
  console.log('  Genre Breakdown:');
  console.log('  ' + '─'.repeat(56));
  for (const [genre, count] of Object.entries(statsAfter.seriesByGenre || {}).sort((a, b) => b[1] - a[1])) {
    const before = (statsBefore.seriesByGenre as Record<string, number>)?.[genre] || 0;
    const diff = count - before;
    const diffStr = diff > 0 ? ` (+${diff})` : '';
    console.log(`  ${genre.padEnd(25)} ${count}${diffStr}`);
  }
  
  const untaggedCount = (getDb().prepare(`SELECT COUNT(*) as count FROM series WHERE genre IS NULL`).get() as { count: number }).count;
  console.log(`  ${'(untagged)'.padEnd(25)} ${untaggedCount}`);
  console.log('═'.repeat(60));
}


// =============================================================================
// Backfill Books for Series with 0 Book Records
// =============================================================================

async function runBackfillBooks(save = false, limit = 0, genre?: string) {
  console.log('🔧 Backfill Books for Bookless Series');
  console.log('─'.repeat(60));

  if (!save) {
    console.log('⚠️  Dry run mode - use --save to persist changes');
  }

  const db = getDb();

  // Find all series with 0 books in series_book table
  let sql = `
    SELECT s.* FROM series s
    LEFT JOIN series_book sb ON sb.series_id = s.id
    WHERE sb.id IS NULL
  `;
  const params: (string | number)[] = [];

  if (genre) {
    sql += ' AND s.genre = ?';
    params.push(genre);
  }

  sql += ' ORDER BY s.genre, s.name';
  if (limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const booklessSeries = db.prepare(sql).all(...params) as SeriesRecord[];

  console.log(`Found ${booklessSeries.length} series with 0 book records`);
  if (genre) console.log(`  Filtered to genre: ${genre}`);
  console.log('');

  if (booklessSeries.length === 0) {
    console.log('✅ Nothing to backfill!');
    return;
  }

  let goodreadsFound = 0;
  let openLibraryFound = 0;
  let notFound = 0;
  let errors = 0;
  let totalBooksAdded = 0;

  for (let i = 0; i < booklessSeries.length; i++) {
    const series = booklessSeries[i];
    const progress = `[${i + 1}/${booklessSeries.length}]`;
    const label = `${series.name}${series.author ? ` by ${series.author}` : ''} (${series.genre || 'untagged'})`;

    // Step 1: Try Goodreads (searches by series name + author)
    try {
      console.log(`${progress} 🔍 Goodreads: ${label}`);
      const grResult = await fetchGoodreads(series.name, series.author || undefined);

      if (grResult && grResult.books.length > 0) {
        console.log(`${progress} ✅ Goodreads: ${grResult.books.length} books found`);
        goodreadsFound++;

        if (save) {
          // Update series metadata
          upsertSeries({
            id: series.id,
            name: series.name,
            author: grResult.author || series.author || null,
            genre: series.genre || null,
            total_books: grResult.books.length,
            description: grResult.description || series.description || null,
            confidence: Math.max(series.confidence, 0.85),
          });

          // Insert all books
          for (const book of grResult.books) {
            upsertSeriesBook({
              series_id: series.id,
              title: book.title,
              author: book.author || grResult.author || series.author || null,
              position: book.position ?? null,
              year_published: book.yearPublished ?? null,
              isbn: book.isbn || null,
              confidence: 0.85,
            });
            totalBooksAdded++;
          }

          // Store Goodreads source data
          if (grResult.sourceId) {
            try {
              storeSourceData(series.id, 'goodreads', {
                goodreadsId: grResult.sourceId,
                url: `https://www.goodreads.com/series/${grResult.sourceId}`,
              }, grResult.books.length);
            } catch {
              // Ignore if already exists
            }
          }

          for (const book of grResult.books.slice(0, 3)) {
            console.log(`       #${book.position || '?'}: ${book.title}`);
          }
          if (grResult.books.length > 3) {
            console.log(`       ... and ${grResult.books.length - 3} more`);
          }
        }
        continue;
      }
    } catch (err) {
      console.log(`${progress} ⚠️  Goodreads error: ${err instanceof Error ? err.message : err}`);
    }

    // Step 2: Fallback to Open Library
    try {
      console.log(`${progress} 🔍 OpenLibrary: ${label}`);
      const olResult = await fetchOpenLibrary(series.name);

      if (olResult.series && olResult.series.books.length > 0) {
        const books = olResult.series.books;
        console.log(`${progress} ✅ OpenLibrary: ${books.length} books found`);
        openLibraryFound++;

        if (save) {
          // Update series metadata
          upsertSeries({
            id: series.id,
            name: series.name,
            author: olResult.series.author || series.author || null,
            genre: series.genre || null,
            total_books: books.length,
            description: series.description || null,
            confidence: Math.max(series.confidence, 0.7),
          });

          // Insert all books
          for (const book of books) {
            upsertSeriesBook({
              series_id: series.id,
              title: book.title,
              author: book.author || olResult.series.author || series.author || null,
              position: book.position ?? null,
              year_published: book.yearPublished ?? null,
              isbn: book.isbn || null,
              openlibrary_key: book.sourceId || null,
              confidence: 0.7,
            });
            totalBooksAdded++;
          }

          for (const book of books.slice(0, 3)) {
            console.log(`       #${book.position || '?'}: ${book.title}`);
          }
          if (books.length > 3) {
            console.log(`       ... and ${books.length - 3} more`);
          }
        }
        continue;
      }
    } catch (err) {
      console.log(`${progress} ⚠️  OpenLibrary error: ${err instanceof Error ? err.message : err}`);
      errors++;
    }

    // Neither source found books
    console.log(`${progress} ❌ No books found: ${series.name}`);
    notFound++;
  }

  // Summary
  console.log('');
  console.log('═'.repeat(60));
  console.log('📊 Backfill Summary');
  console.log('═'.repeat(60));
  console.log(`  Total bookless series:  ${booklessSeries.length}`);
  console.log(`  Found via Goodreads:    ${goodreadsFound}`);
  console.log(`  Found via OpenLibrary:  ${openLibraryFound}`);
  console.log(`  Not found anywhere:     ${notFound}`);
  console.log(`  Errors:                 ${errors}`);
  if (save) {
    console.log(`  Books added to DB:      ${totalBooksAdded}`);
    const stats = getStats();
    console.log(`  DB now has ${stats.totalSeries} series, ${stats.totalBooks} books`);
  } else {
    console.log('');
    console.log('💡 Run with --save to persist changes');
  }
  console.log('═'.repeat(60));
}

// =============================================================================
// Sub-Series Hierarchy Processing
// =============================================================================

/**
 * Process a series that has sub-series on ISFDB.
 * Given an ISFDB parent/universe page, this function:
 * 1. Creates (or finds) the parent universe series
 * 2. Fetches each sub-series from ISFDB
 * 3. Creates sub-series entries with parent links
 * 4. Moves books from any flat series to the correct sub-series
 * 
 * Returns { created, moved, errors } counts.
 */
async function processSeriesHierarchy(
  parentIsfdbId: string,
  options: { dryRun?: boolean; genre?: string; verbose?: boolean } = {}
): Promise<{ parentId: string | null; created: number; moved: number; errors: number }> {
  const { dryRun = false, genre, verbose = true } = options;
  
  // Step 1: Fetch the parent/universe page from ISFDB
  const parentResult = await fetchSeriesById(parentIsfdbId);
  if (!parentResult.series) {
    if (verbose) console.log(`    ❌ Could not fetch parent ISFDB page ${parentIsfdbId}`);
    return { parentId: null, created: 0, moved: 0, errors: 1 };
  }
  
  const parentSource = parentResult.series;
  const subSeriesList = parentSource.subSeries || [];
  
  if (subSeriesList.length === 0) {
    if (verbose) console.log(`    ℹ️  No sub-series on parent page ${parentSource.name}`);
    return { parentId: null, created: 0, moved: 0, errors: 0 };
  }
  
  if (verbose) {
    console.log(`    📖 Parent: ${parentSource.name} (ISFDB ${parentIsfdbId})`);
    console.log(`    📚 Sub-series: ${subSeriesList.map(s => s.name).join(', ')}`);
  }
  
  // Step 2: Create/find the parent universe series in our DB
  let parentRecord = findSeriesByIsfdbId(parentIsfdbId);
  if (!parentRecord) {
    parentRecord = findSeriesByName(parentSource.name);
  }
  
  let parentDbId: string;
  if (parentRecord) {
    parentDbId = parentRecord.id;
    // Make sure it has the ISFDB ID
    if (!parentRecord.isfdb_id && !dryRun) {
      upsertSeries({
        id: parentDbId,
        name: parentRecord.name,
        isfdb_id: parentIsfdbId,
      });
    }
  } else {
    // Create the parent universe series (it may have no direct books)
    if (dryRun) {
      if (verbose) console.log(`    🆕 Would create parent: ${parentSource.name}`);
      parentDbId = 'dry-run-parent';
    } else {
      parentDbId = upsertSeries({
        name: parentSource.name,
        author: parentSource.author,
        genre: genre || null,
        total_books: parentSource.books.length,
        confidence: 0.8,
        isfdb_id: parentIsfdbId,
      });
      // Save parent's direct books (if any)
      for (const book of parentSource.books) {
        upsertSeriesBook({
          series_id: parentDbId,
          title: book.title,
          position: book.position,
          author: book.author,
          year_published: book.yearPublished,
          confidence: 0.8,
        });
      }
      storeSourceData(parentDbId, 'isfdb', { seriesId: parentIsfdbId }, parentSource.books.length);
      if (verbose) console.log(`    🆕 Created parent: ${parentSource.name} (${parentDbId})`);
    }
  }
  
  let created = 0;
  let moved = 0;
  let errors = 0;
  
  // Step 3: Process each sub-series
  for (const subRef of subSeriesList) {
    try {
      // Fetch the sub-series page from ISFDB
      const subResult = await fetchSeriesById(subRef.id);
      if (!subResult.series) {
        if (verbose) console.log(`    ⚠️  Could not fetch sub-series: ${subRef.name} (ISFDB ${subRef.id})`);
        errors++;
        continue;
      }
      
      const subSource = subResult.series;
      
      if (subSource.books.length === 0) {
        if (verbose) console.log(`    ⏭️  ${subSource.name} — 0 books, skipping`);
        continue;
      }
      
      // Check if this sub-series already exists
      let subRecord = findSeriesByIsfdbId(subRef.id);
      if (!subRecord) {
        subRecord = findSeriesByName(subSource.name);
      }
      
      if (subRecord) {
        // Already exists — just ensure parent link is set
        if (!subRecord.parent_series_id && !dryRun) {
          setParentSeries(subRecord.id, parentDbId);
          if (verbose) console.log(`    🔗 Linked existing: ${subRecord.name} → ${parentSource.name}`);
        }
        // Ensure it has the ISFDB ID
        if (!subRecord.isfdb_id && !dryRun) {
          upsertSeries({
            id: subRecord.id,
            name: subRecord.name,
            isfdb_id: subRef.id,
          });
        }
        continue;
      }
      
      // Sub-series doesn't exist — create it
      if (dryRun) {
        if (verbose) console.log(`    🆕 Would create sub-series: ${subSource.name} (${subSource.books.length} books)`);
        created++;
        continue;
      }
      
      // Determine genre from parent or auto-detect
      const subGenre = genre || (parentRecord?.genre) || detectGenre(subSource.tags, subSource.name) || null;
      
      const subDbId = upsertSeries({
        name: subSource.name,
        author: subSource.author,
        genre: subGenre,
        total_books: subSource.books.length,
        confidence: 0.8,
        isfdb_id: subRef.id,
        parent_series_id: parentDbId,
      });
      
      // Save the sub-series books
      for (const book of subSource.books) {
        upsertSeriesBook({
          series_id: subDbId,
          title: book.title,
          position: book.position,
          author: book.author,
          year_published: book.yearPublished,
          confidence: 0.8,
        });
      }
      
      storeSourceData(subDbId, 'isfdb', { seriesId: subRef.id }, subSource.books.length);
      
      if (verbose) console.log(`    ✅ Created: ${subSource.name} (${subSource.books.length} books) [${subGenre || 'no genre'}]`);
      created++;
      
      // Step 4: Check if any sibling series has these books mixed in
      // Only look at known siblings (same parent), NOT the entire database
      const siblingCandidates = findFlatSiblingsForBooks(subSource, subSeriesList, parentIsfdbId, parentDbId, subRef.id);
      
      for (const candidate of siblingCandidates) {
        for (const book of subSource.books) {
          const titleNorm = normalizeText(book.title);
          const wasMoved = moveBookToSeries(
            candidate.id, subDbId, titleNorm, book.position
          );
          if (wasMoved) {
            moved++;
            if (verbose) console.log(`      📦 Moved "${book.title}" from ${candidate.name} → ${subSource.name}`);
          }
        }
        // Update book count on the source series after moves
        refreshSeriesBookCount(candidate.id);
      }
      
    } catch (error) {
      if (verbose) console.error(`    ❌ Error processing sub-series ${subRef.name}: ${error}`);
      errors++;
    }
  }
  
  // Step 5: Link any existing DB series that are children (already have ISFDB IDs matching sub-series)
  // and set the parent's book count
  if (!dryRun) {
    refreshSeriesBookCount(parentDbId);
  }
  
  return { parentId: parentDbId, created, moved, errors };
}

/**
 * Find series in our DB that are "flat" siblings — i.e., they are children of
 * the same parent and may contain books that should belong to a different sub-series.
 * 
 * CRITICAL: Only returns series that are known siblings (share the same parent),
 * NOT random series that happen to have a book with the same title.
 * 
 * The main use case: "Awaken Online" in DB has books from "Side Quests" and "Tarot"
 * because Goodreads merged them. We need to find that flat series to move books out.
 */
function findFlatSiblingsForBooks(
  _subSource: { books: Array<{ title: string }> },
  allSubSeries: Array<{ id: string; name: string }>,
  parentIsfdbId: string,
  parentDbId: string,
  currentSubIsfdbId: string
): Array<{ id: string; name: string }> {
  const db = getDb();
  
  const candidates: Array<{ id: string; name: string }> = [];
  
  // Strategy: Only look at series that are KNOWN siblings of this sub-series.
  // A sibling is a series that:
  // 1. Has the same parent_series_id in our DB, OR
  // 2. Has an ISFDB ID matching another sub-series of the same parent
  
  // Get all sibling ISFDB IDs (excluding the current sub-series)
  const siblingIsfdbIds = allSubSeries
    .filter(s => s.id !== currentSubIsfdbId)
    .map(s => s.id);
  
  // Find DB series that are siblings by parent_series_id
  const byParent = db.prepare(`
    SELECT id, name FROM series
    WHERE parent_series_id = ?
  `).all(parentDbId) as Array<{ id: string; name: string }>;
  
  for (const s of byParent) {
    if (!candidates.find(c => c.id === s.id)) {
      candidates.push(s);
    }
  }
  
  // Find DB series that are siblings by ISFDB ID match
  if (siblingIsfdbIds.length > 0) {
    const placeholders = siblingIsfdbIds.map(() => '?').join(',');
    const byIsfdb = db.prepare(`
      SELECT id, name FROM series
      WHERE isfdb_id IN (${placeholders})
    `).all(...siblingIsfdbIds) as Array<{ id: string; name: string }>;
    
    for (const s of byIsfdb) {
      if (!candidates.find(c => c.id === s.id)) {
        candidates.push(s);
      }
    }
  }
  
  // Also include the parent series itself (it might have flat books)
  const parentSeries = db.prepare('SELECT id, name FROM series WHERE id = ?')
    .get(parentDbId) as { id: string; name: string } | undefined;
  if (parentSeries && !candidates.find(c => c.id === parentSeries.id)) {
    candidates.push(parentSeries);
  }
  
  // Also find the series matched by ISFDB parent ID (the original flat series)
  const byParentIsfdb = db.prepare(`
    SELECT id, name FROM series WHERE isfdb_id = ?
  `).get(parentIsfdbId) as { id: string; name: string } | undefined;
  if (byParentIsfdb && !candidates.find(c => c.id === byParentIsfdb.id)) {
    candidates.push(byParentIsfdb);
  }
  
  return candidates;
}

/**
 * Reconcile flat series that should have sub-series hierarchy.
 * 
 * Strategy:
 * 1. Find series with ISFDB IDs that are sub-series (have parentSeriesId on ISFDB)
 * 2. For each, fetch the parent universe page from ISFDB
 * 3. Check if the parent has other sub-series we don't have yet
 * 4. Create missing sub-series and move books from any flat series
 * 
 * Also checks for series that have "too many books" compared to ISFDB 
 * (a sign that Goodreads merged multiple sub-series into one).
 */
async function runReconcileSubSeries(limit = 0, dryRun = false, filterName?: string) {
  console.log('🔄 Reconcile Sub-Series');
  console.log('═'.repeat(60));
  console.log(dryRun ? '⚠️  DRY RUN — no changes will be saved' : '💾 Will create sub-series and move books');
  if (filterName) console.log(`🔍 Filtering to series matching: "${filterName}"`);
  console.log('');
  
  const db = getDb();
  
  // Strategy 1: Find series where our book count exceeds ISFDB book count
  // This indicates Goodreads likely merged sub-series books into one series
  console.log('📋 Phase 1: Finding series with book count mismatches...');
  
  let seriesWithIsfdb = db.prepare(`
    SELECT s.id, s.name, s.isfdb_id, s.genre, s.parent_series_id,
           COUNT(sb.id) as db_book_count,
           sd.raw_data
    FROM series s
    JOIN series_book sb ON sb.series_id = s.id
    LEFT JOIN source_data sd ON sd.series_id = s.id AND sd.source = 'isfdb'
    WHERE s.isfdb_id IS NOT NULL
    GROUP BY s.id
    HAVING db_book_count >= 3
    ORDER BY db_book_count DESC
  `).all() as Array<{
    id: string; name: string; isfdb_id: string; genre: string | null;
    parent_series_id: string | null; db_book_count: number; raw_data: string | null;
  }>;
  
  // Apply name filter if provided
  if (filterName) {
    const filterNorm = filterName.toLowerCase();
    seriesWithIsfdb = seriesWithIsfdb.filter(s => s.name.toLowerCase().includes(filterNorm));
    console.log(`  Filtered to ${seriesWithIsfdb.length} series matching "${filterName}"`);
  } else {
    console.log(`  Found ${seriesWithIsfdb.length} series with ISFDB IDs and 3+ books`);
  }
  
  // Collect parent ISFDB IDs we need to process
  const parentsToProcess = new Map<string, { triggerSeries: string; genre: string | null }>();
  let scanned = 0;
  let needsReconcile = 0;
  
  const toScan = limit > 0 ? seriesWithIsfdb.slice(0, limit) : seriesWithIsfdb;
  
  for (const series of toScan) {
    scanned++;
    
    if (scanned % 100 === 0) {
      console.log(`  ... scanned ${scanned}/${toScan.length}`);
    }
    
    // Fetch the ISFDB page to check if this series has a parent
    try {
      const result = await fetchSeriesById(series.isfdb_id);
      
      if (!result.series) continue;
      
      // If this series has a parent on ISFDB, we need to check the parent for siblings
      if (result.series.parentSeriesId) {
        if (!parentsToProcess.has(result.series.parentSeriesId)) {
          parentsToProcess.set(result.series.parentSeriesId, {
            triggerSeries: series.name,
            genre: series.genre,
          });
        }
      }
      
      // Also check if this series itself IS a parent with sub-series we don't have
      if (result.series.subSeries && result.series.subSeries.length > 0) {
        // Check how many sub-series we're missing
        let missingSubs = 0;
        for (const sub of result.series.subSeries) {
          const existing = findSeriesByIsfdbId(sub.id);
          if (!existing) missingSubs++;
        }
        if (missingSubs > 0) {
          if (!parentsToProcess.has(series.isfdb_id)) {
            parentsToProcess.set(series.isfdb_id, {
              triggerSeries: series.name,
              genre: series.genre,
            });
          }
        }
      }
      
      // Check for book count mismatch (sign of flattened sub-series)
      const isfdbBookCount = result.series.books.length;
      if (series.db_book_count > isfdbBookCount + 2 && result.series.parentSeriesId) {
        // We have way more books than ISFDB says — likely merged sub-series
        needsReconcile++;
        console.log(`  ⚠️  ${series.name}: DB has ${series.db_book_count} books, ISFDB has ${isfdbBookCount} → checking parent`);
      }
      
    } catch (error) {
      // Rate limits, network errors — skip
      continue;
    }
  }
  
  console.log('');
  console.log(`📋 Phase 2: Processing ${parentsToProcess.size} parent universe pages...`);
  console.log(`  (${needsReconcile} series flagged with book count mismatches)`);
  console.log('');
  
  let totalCreated = 0;
  let totalMoved = 0;
  let totalErrors = 0;
  let processed = 0;
  
  for (const [parentIsfdbId, info] of parentsToProcess) {
    processed++;
    console.log(`  [${processed}/${parentsToProcess.size}] Processing parent ISFDB ${parentIsfdbId} (triggered by: ${info.triggerSeries})`);
    
    const result = await processSeriesHierarchy(parentIsfdbId, {
      dryRun,
      genre: info.genre || undefined,
      verbose: true,
    });
    
    totalCreated += result.created;
    totalMoved += result.moved;
    totalErrors += result.errors;
  }
  
  console.log('');
  console.log('═'.repeat(60));
  console.log('📊 Reconcile Sub-Series Summary');
  console.log('═'.repeat(60));
  console.log(`  Series scanned:        ${scanned}`);
  console.log(`  Parent pages checked:  ${parentsToProcess.size}`);
  console.log(`  Sub-series created:    ${totalCreated}`);
  console.log(`  Books moved:           ${totalMoved}`);
  console.log(`  Errors:                ${totalErrors}`);
  
  if (dryRun && (totalCreated > 0 || totalMoved > 0)) {
    console.log('');
    console.log('💡 Run without --dry-run to persist changes');
  }
  
  const stats = getStats();
  console.log(`\n📈 Database: ${stats.totalSeries} series, ${stats.totalBooks} books`);
  console.log('═'.repeat(60));
}

/**
 * Remove books from parent series that are duplicated in their child sub-series.
 * 
 * On ISFDB, parent/universe pages list ALL books including those that belong
 * to child sub-series. When we import both the parent and child, we end up
 * with the same books in both. This command removes the duplicates from the parent.
 */
function runDedupParents(dryRun = false, filterName?: string) {
  console.log('🧹 Dedup Parent Series Books');
  console.log('═'.repeat(60));
  console.log(dryRun ? '⚠️  DRY RUN — no changes will be saved' : '💾 Will remove duplicate books from parents');
  if (filterName) console.log(`🔍 Filtering to series matching: "${filterName}"`);
  console.log('');
  
  let affected = findParentsWithDuplicateBooks();
  
  if (filterName) {
    const filterNorm = filterName.toLowerCase();
    affected = affected.filter(s => s.name.toLowerCase().includes(filterNorm));
  }
  
  console.log(`📊 Found ${affected.length} parent series with duplicate books`);
  console.log('');
  
  let totalRemoved = 0;
  let processedCount = 0;
  
  for (const parent of affected) {
    processedCount++;
    const result = dedupParentBooks(parent.id, dryRun);
    
    if (result.removed > 0) {
      totalRemoved += result.removed;
      const verb = dryRun ? 'Would remove' : 'Removed';
      console.log(`  [${processedCount}/${affected.length}] ${parent.name}: ${verb} ${result.removed} duplicate book(s)`);
      if (result.titles.length <= 10) {
        for (const title of result.titles) {
          console.log(`      📦 ${title}`);
        }
      } else {
        for (const title of result.titles.slice(0, 8)) {
          console.log(`      📦 ${title}`);
        }
        console.log(`      ... and ${result.titles.length - 8} more`);
      }
    }
  }
  
  console.log('');
  console.log('═'.repeat(60));
  console.log('📊 Dedup Summary');
  console.log('═'.repeat(60));
  console.log(`  Parent series checked: ${affected.length}`);
  console.log(`  Books ${dryRun ? 'to remove' : 'removed'}:     ${totalRemoved}`);
  
  if (dryRun && totalRemoved > 0) {
    console.log('');
    console.log('💡 Run without --dry-run to persist changes');
  }
  
  const stats = getStats();
  console.log(`\n📈 Database: ${stats.totalSeries} series, ${stats.totalBooks} books`);
  console.log('═'.repeat(60));
}

/**
 * Link sub-series to their parent series by re-parsing ISFDB pages.
 * Scans all series with ISFDB IDs, fetches their pages, and sets up
 * parent_series_id links where sub-series relationships exist.
 */
async function runLinkSubSeries(limit = 0, dryRun = false) {
  console.log('🔗 Link Sub-Series');
  console.log('─'.repeat(60));
  console.log(dryRun ? '⚠️  DRY RUN — no changes will be saved' : '💾 Will save parent links to database');
  console.log('');

  const db = getDb();

  // Get all series that have ISFDB IDs (these are the ones we can look up)
  const allSeries = db.prepare(`
    SELECT id, name, isfdb_id, parent_series_id
    FROM series
    WHERE isfdb_id IS NOT NULL
    ORDER BY total_books DESC
  `).all() as Array<{ id: string; name: string; isfdb_id: string; parent_series_id: string | null }>;

  const toProcess = limit > 0 ? allSeries.slice(0, limit) : allSeries;
  console.log(`📋 Series with ISFDB IDs: ${allSeries.length}`);
  console.log(`📋 Processing: ${toProcess.length}`);
  console.log('');

  let linked = 0;
  let alreadyLinked = 0;
  let parentNotFound = 0;
  let noParent = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const series = toProcess[i];

    // Skip if already has a parent
    if (series.parent_series_id) {
      alreadyLinked++;
      continue;
    }

    try {
      // Fetch the ISFDB page to check for "Sub-series of:" metadata
      const result = await fetchSeriesById(series.isfdb_id);

      if (!result.series) {
        errors++;
        continue;
      }

      if (result.series.parentSeriesId) {
        // This series IS a sub-series — find the parent in our DB
        const parent = findSeriesByIsfdbId(result.series.parentSeriesId);

        if (parent) {
          if (!dryRun) {
            setParentSeries(series.id, parent.id);
          }
          linked++;
          console.log(`  ✅ ${series.name} → parent: ${parent.name}${dryRun ? ' (dry run)' : ''}`);
        } else {
          parentNotFound++;
          console.log(`  ⚠️  ${series.name} → parent ISFDB ID ${result.series.parentSeriesId} not in DB`);
        }
      } else {
        noParent++;
      }

      // Progress every 50
      if ((i + 1) % 50 === 0) {
        console.log(`  ... processed ${i + 1}/${toProcess.length} (linked: ${linked}, no parent: ${noParent})`);
      }

    } catch (error) {
      errors++;
      console.error(`  ❌ Error processing ${series.name}: ${error}`);
    }
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log('📊 Link Sub-Series Summary');
  console.log('═'.repeat(60));
  console.log(`  Processed:           ${toProcess.length}`);
  console.log(`  Newly linked:        ${linked}`);
  console.log(`  Already linked:      ${alreadyLinked}`);
  console.log(`  Parent not in DB:    ${parentNotFound}`);
  console.log(`  No parent (top-lvl): ${noParent}`);
  console.log(`  Errors:              ${errors}`);

  if (dryRun && linked > 0) {
    console.log('');
    console.log('💡 Run without --dry-run to persist changes');
  }

  // Show current hierarchy stats
  const parentsList = getParentSeriesList(10);
  if (parentsList.length > 0) {
    console.log('');
    console.log('🏛️  Top Parent Series (by child count):');
    for (const p of parentsList) {
      console.log(`  ${p.name}: ${p.childCount} sub-series`);
    }
  }

  console.log('═'.repeat(60));
}

// Call main
main().catch(console.error);