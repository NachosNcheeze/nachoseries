/**
 * NachoSeries - Series Database Builder
 * Aggregates and reconciles book series data from multiple sources
 */
import { initDatabase, getStats, closeDatabase } from './database/db.js';
import { fetchSeries as fetchLibraryThing } from './sources/librarything.js';
import { fetchSeries as fetchOpenLibrary } from './sources/openLibrary.js';
import { fetchSeries as fetchISFDB } from './sources/isfdb.js';
import { checkFlareSolverr } from './sources/flareSolverr.js';
import { compareSources, needsTalpaVerification } from './reconciler/matcher.js';
import { config } from './config.js';
import { knownSeries } from './data/knownSeries.js';
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'status';
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                        NACHOSERIES                             ║');
    console.log('║              Series Database Builder v0.1.0                    ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
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
        case 'crawl':
            await runCrawl(args[1]);
            break;
        case 'verify':
            await runVerify();
            break;
        default:
            console.log('Usage: nachoseries <command>');
            console.log('');
            console.log('Commands:');
            console.log('  status           Show database statistics');
            console.log('  test [series]    Test fetch a specific series');
            console.log('  crawl [genre]    Crawl series for a genre');
            console.log('  verify           Verify existing series data');
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
async function runTestFetch(seriesName) {
    const name = seriesName || 'The Stormlight Archive';
    console.log(`🔍 Testing fetch for: "${name}"`);
    console.log('─'.repeat(50));
    // Fetch from ISFDB (most reliable for speculative fiction)
    console.log('\n📚 ISFDB:');
    const isfdbResult = await fetchISFDB(name);
    if (isfdbResult.error) {
        console.log(`  ❌ Error: ${isfdbResult.error}`);
    }
    else if (isfdbResult.series) {
        console.log(`  ✅ Found ${isfdbResult.series.books.length} books`);
        console.log(`  Author: ${isfdbResult.series.author || 'Unknown'}`);
        for (const book of isfdbResult.series.books.slice(0, 5)) {
            console.log(`    ${book.position || '?'}. ${book.title} (${book.yearPublished || '?'})`);
        }
        if (isfdbResult.series.books.length > 5) {
            console.log(`    ... and ${isfdbResult.series.books.length - 5} more`);
        }
    }
    else {
        console.log('  ⚠️ No results');
    }
    // Fetch from Open Library
    console.log('\n📖 Open Library:');
    const olResult = await fetchOpenLibrary(name);
    if (olResult.error) {
        console.log(`  ❌ Error: ${olResult.error}`);
    }
    else if (olResult.series) {
        console.log(`  ✅ Found ${olResult.series.books.length} books`);
        console.log(`  Author: ${olResult.series.author || 'Unknown'}`);
        for (const book of olResult.series.books.slice(0, 5)) {
            console.log(`    ${book.position || '?'}. ${book.title}`);
        }
        if (olResult.series.books.length > 5) {
            console.log(`    ... and ${olResult.series.books.length - 5} more`);
        }
    }
    else {
        console.log('  ⚠️ No results');
    }
    // Optionally try LibraryThing (may not work due to JS requirement)
    console.log('\n📕 LibraryThing (experimental):');
    const ltResult = await fetchLibraryThing(name);
    if (ltResult.error) {
        console.log(`  ❌ Error: ${ltResult.error}`);
    }
    else if (ltResult.series) {
        console.log(`  ✅ Found ${ltResult.series.books.length} books`);
        console.log(`  Author: ${ltResult.series.author || 'Unknown'}`);
        for (const book of ltResult.series.books.slice(0, 5)) {
            console.log(`    ${book.position || '?'}. ${book.title}`);
        }
        if (ltResult.series.books.length > 5) {
            console.log(`    ... and ${ltResult.series.books.length - 5} more`);
        }
    }
    else {
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
            }
            else if (comparison.confidence >= config.confidence.autoAccept) {
                console.log('  ✅ Would auto-accept');
            }
            else {
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
async function runCrawl(genre) {
    const targetGenre = genre || config.genres[0];
    console.log(`🔄 Crawling genre: ${targetGenre}`);
    console.log('─'.repeat(50));
    console.log('Not yet implemented - coming soon!');
}
async function runVerify() {
    console.log('✅ Verifying existing series...');
    console.log('─'.repeat(50));
    console.log('Not yet implemented - coming soon!');
}
main().catch(console.error);
//# sourceMappingURL=index.js.map