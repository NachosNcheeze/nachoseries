/**
 * NachoSeries - Series Database Builder
 * Aggregates and reconciles book series data from multiple sources
 */

import { initDatabase, getStats, closeDatabase, upsertSeries, upsertSeriesBook, findSeriesByName, getSeriesNeedingVerification, storeSourceData, getDb } from './database/db.js';
import { fetchSeries as fetchLibraryThing } from './sources/librarything.js';
import { fetchSeries as fetchOpenLibrary } from './sources/openLibrary.js';
import { fetchSeries as fetchISFDB, browseSeriesByGenre, fetchSeriesById, genreKeywords, discoverSeriesFromAuthors, scanSeriesRange, fetchPopularAuthors, fetchAuthorSeries, mapTagsToGenre, detectGenre, guessGenreFromName } from './sources/isfdb.js';
import { fetchSeries as fetchGoodreads, testGoodreads } from './sources/goodreads.js';
import { importGenre as importGoodreadsGenre, importAllGenres as importAllGoodreadsGenres, GENRE_LISTS } from './sources/goodreadsList.js';
import { lookupGenreForSeries } from './sources/genreLookup.js';
import { shouldFilterSeries, detectLanguage, getNonEnglishSqlPatterns } from './utils/languageFilter.js';
import { checkFlareSolverr } from './sources/flareSolverr.js';
import { compareSources, needsTalpaVerification } from './reconciler/matcher.js';
import { config } from './config.js';
import { knownSeries } from './data/knownSeries.js';

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
      // Genre is optional (first non-flag arg after command), --save to persist
      const listGenre = args.slice(1).find(a => !a.startsWith('--'));
      await runGoodreadsListImport(listGenre, args.includes('--save'));
      break;

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
      console.log('  cleanup           Remove non-English series (--confirm to execute)');
      console.log('  daily             Run automated daily job (discover + tag)');
      console.log('');
      console.log('Options:');
      console.log('  --save            Save discovered series to database');
      console.log('  --limit=N         Limit number of items to process');
      console.log('  --genre=GENRE     Tag discovered series with this genre');
      console.log('  --confirm         Execute cleanup (otherwise dry-run)');
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

main().catch(console.error);

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
async function runGoodreadsListImport(genre?: string, save = false) {
  console.log('📚 Goodreads List Import');
  console.log('─'.repeat(50));
  
  if (genre && !GENRE_LISTS[genre]) {
    console.log(`Unknown genre: ${genre}`);
    console.log(`Available genres: ${Object.keys(GENRE_LISTS).join(', ')}`);
    return;
  }
  
  if (!save) {
    console.log('⚠️  Dry run mode - use --save to persist to database');
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
  
  for (const [g, series] of allSeries) {
    console.log(`\n${g}: ${series.length} series`);
    totalSeries += series.length;
    
    if (save && series.length > 0) {
      const db = getDb();
      
      for (const s of series) {
        // Check if series already exists
        const existing = findSeriesByName(s.name);
        if (existing) {
          console.log(`  ⏭️  Skip (exists): ${s.name}`);
          continue;
        }
        
        // Filter non-English
        if (shouldFilterSeries(s.name)) {
          console.log(`  ⏭️  Skip (non-English): ${s.name}`);
          continue;
        }
        
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
  if (save) {
    console.log(`Saved to DB: ${savedSeries} new series`);
    const stats = getStats();
    console.log(`Database now has ${stats.totalSeries} series`);
  }
}

// Call main
main().catch(console.error);