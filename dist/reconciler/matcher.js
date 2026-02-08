/**
 * Reconciliation Matcher
 * Compares series data from different sources and calculates confidence
 */
import stringSimilarity from 'string-similarity';
import { config } from '../config.js';
/**
 * Compare two source results and calculate confidence
 */
export function compareSources(resultA, resultB) {
    if (!resultA.series || !resultB.series) {
        return null;
    }
    const seriesA = resultA.series;
    const seriesB = resultB.series;
    const discrepancies = [];
    // Compare book counts
    const bookCountA = seriesA.books.length;
    const bookCountB = seriesB.books.length;
    const bookCountMatch = bookCountA === bookCountB;
    if (!bookCountMatch) {
        discrepancies.push({
            field: 'book_count',
            sourceA: resultA.source,
            valueA: bookCountA,
            sourceB: resultB.source,
            valueB: bookCountB,
        });
    }
    // Compare book titles using fuzzy matching
    const titleMatches = countTitleMatches(seriesA.books, seriesB.books);
    const maxBooks = Math.max(bookCountA, bookCountB);
    const titleMatchRatio = maxBooks > 0 ? titleMatches / maxBooks : 0;
    // Find title mismatches
    const titleMismatches = findTitleMismatches(seriesA.books, seriesB.books);
    // Compare book order (if titles match, are they in same order?)
    const orderMatch = checkOrderMatch(seriesA.books, seriesB.books);
    if (!orderMatch && titleMatches > 2) {
        discrepancies.push({
            field: 'book_order',
            sourceA: resultA.source,
            valueA: seriesA.books.map(b => b.title).join(', '),
            sourceB: resultB.source,
            valueB: seriesB.books.map(b => b.title).join(', '),
        });
    }
    // Compare authors
    if (seriesA.author && seriesB.author) {
        const authorSimilarity = stringSimilarity.compareTwoStrings(seriesA.author.toLowerCase(), seriesB.author.toLowerCase());
        if (authorSimilarity < 0.8) {
            discrepancies.push({
                field: 'author',
                sourceA: resultA.source,
                valueA: seriesA.author,
                sourceB: resultB.source,
                valueB: seriesB.author,
            });
        }
    }
    // Calculate overall confidence
    const confidence = calculateConfidence({
        bookCountMatch,
        titleMatchRatio,
        orderMatch,
        discrepancyCount: discrepancies.length,
    });
    return {
        seriesName: seriesA.name,
        sources: [resultA.source, resultB.source],
        bookCountMatch,
        bookCountA,
        bookCountB,
        orderMatch,
        titleMatches,
        titleMismatches,
        confidence,
        discrepancies,
    };
}
/**
 * Count how many titles match between two book lists
 */
function countTitleMatches(booksA, booksB) {
    let matches = 0;
    for (const bookA of booksA) {
        const titleA = normalizeTitle(bookA.title);
        for (const bookB of booksB) {
            const titleB = normalizeTitle(bookB.title);
            const similarity = stringSimilarity.compareTwoStrings(titleA, titleB);
            if (similarity >= 0.85) {
                matches++;
                break;
            }
        }
    }
    return matches;
}
/**
 * Find titles that don't match between sources
 */
function findTitleMismatches(booksA, booksB) {
    const mismatches = [];
    const titlesB = booksB.map(b => normalizeTitle(b.title));
    for (const bookA of booksA) {
        const titleA = normalizeTitle(bookA.title);
        let found = false;
        for (const titleB of titlesB) {
            if (stringSimilarity.compareTwoStrings(titleA, titleB) >= 0.85) {
                found = true;
                break;
            }
        }
        if (!found) {
            mismatches.push(bookA.title);
        }
    }
    return mismatches;
}
/**
 * Check if books are in the same order
 */
function checkOrderMatch(booksA, booksB) {
    // Only check if we have enough books to compare
    if (booksA.length < 2 || booksB.length < 2) {
        return true;
    }
    // Build order arrays based on matched titles
    const orderA = [];
    const orderB = [];
    for (let i = 0; i < booksA.length; i++) {
        const titleA = normalizeTitle(booksA[i].title);
        for (let j = 0; j < booksB.length; j++) {
            const titleB = normalizeTitle(booksB[j].title);
            if (stringSimilarity.compareTwoStrings(titleA, titleB) >= 0.85) {
                orderA.push(i);
                orderB.push(j);
                break;
            }
        }
    }
    // Check if relative order is maintained
    for (let i = 1; i < orderA.length; i++) {
        const aIncreasing = orderA[i] > orderA[i - 1];
        const bIncreasing = orderB[i] > orderB[i - 1];
        if (aIncreasing !== bIncreasing) {
            return false;
        }
    }
    return true;
}
/**
 * Normalize title for comparison
 */
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^(the|a|an)\s+/i, '')
        .trim();
}
/**
 * Calculate overall confidence score
 */
function calculateConfidence(factors) {
    let confidence = 0;
    // Book count match: 25% weight
    if (factors.bookCountMatch) {
        confidence += 0.25;
    }
    else {
        // Partial credit if within 2 books
        confidence += 0.10;
    }
    // Title match ratio: 50% weight
    confidence += factors.titleMatchRatio * 0.50;
    // Order match: 15% weight
    if (factors.orderMatch) {
        confidence += 0.15;
    }
    // Base confidence: 10%
    confidence += 0.10;
    // Penalty for discrepancies
    confidence -= factors.discrepancyCount * 0.05;
    return Math.max(0, Math.min(1, confidence));
}
/**
 * Merge two series into one, preferring higher confidence data
 */
export function mergeSeries(seriesA, seriesB, preferSource = 'a') {
    const primary = preferSource === 'a' ? seriesA : seriesB;
    const secondary = preferSource === 'a' ? seriesB : seriesA;
    // Use primary series as base
    const merged = {
        name: primary.name,
        author: primary.author || secondary.author,
        description: primary.description || secondary.description,
        books: [...primary.books],
    };
    // Add any books from secondary that aren't in primary
    for (const bookB of secondary.books) {
        const titleB = normalizeTitle(bookB.title);
        const exists = merged.books.some(bookA => {
            const titleA = normalizeTitle(bookA.title);
            return stringSimilarity.compareTwoStrings(titleA, titleB) >= 0.85;
        });
        if (!exists) {
            merged.books.push(bookB);
        }
    }
    // Re-sort by position
    merged.books.sort((a, b) => (a.position || 999) - (b.position || 999));
    return merged;
}
/**
 * Check if a comparison result needs Talpa verification
 */
export function needsTalpaVerification(result) {
    return (result.confidence >= config.confidence.manualReview &&
        result.confidence < config.confidence.autoAccept &&
        result.discrepancies.length > 0);
}
//# sourceMappingURL=matcher.js.map