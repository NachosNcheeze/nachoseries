/**
 * Accuracy Tests
 * Tests that validate NachoSeries data against known correct series
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { knownSeries, type KnownSeries } from './knownSeries.js';
import { fetchSeries as fetchLibraryThing } from '../src/sources/librarything.js';
import { fetchSeries as fetchOpenLibrary } from '../src/sources/openLibrary.js';
import { compareSources } from '../src/reconciler/matcher.js';
import stringSimilarity from 'string-similarity';

// Skip slow tests in CI
const SKIP_SLOW = process.env.CI === 'true';

describe('LibraryThing Source Accuracy', () => {
  // Test a subset to avoid rate limiting
  const testSeries = knownSeries.slice(0, 5);
  
  for (const known of testSeries) {
    it(`should fetch "${known.name}" with correct book count`, async () => {
      if (SKIP_SLOW) return;
      
      const result = await fetchLibraryThing(known.name);
      
      expect(result.error).toBeUndefined();
      expect(result.series).not.toBeNull();
      
      if (result.series) {
        // Allow some variance in book count (some sources include novellas)
        const countDiff = Math.abs(result.series.books.length - known.bookCount);
        expect(countDiff).toBeLessThanOrEqual(3);
        
        // Check that first book title matches
        const firstBook = result.series.books.find(b => b.position === 1);
        if (firstBook) {
          const similarity = stringSimilarity.compareTwoStrings(
            firstBook.title.toLowerCase(),
            known.books[0].title.toLowerCase()
          );
          expect(similarity).toBeGreaterThanOrEqual(0.7);
        }
      }
    }, 30000); // 30s timeout for network requests
  }
});

describe('Open Library Source Accuracy', () => {
  const testSeries = knownSeries.slice(0, 3);
  
  for (const known of testSeries) {
    it(`should find "${known.name}" in search results`, async () => {
      if (SKIP_SLOW) return;
      
      const result = await fetchOpenLibrary(known.name);
      
      // Open Library may not have all series, so just check we got a response
      expect(result.source).toBe('openlibrary');
      
      if (result.series) {
        // If we got results, check they're reasonable
        expect(result.series.books.length).toBeGreaterThan(0);
      }
    }, 30000);
  }
});

describe('Source Comparison', () => {
  it('should calculate high confidence for matching sources', () => {
    const resultA = {
      source: 'librarything' as const,
      series: {
        name: 'Test Series',
        author: 'Test Author',
        books: [
          { title: 'Book One', position: 1 },
          { title: 'Book Two', position: 2 },
          { title: 'Book Three', position: 3 },
        ],
      },
      raw: {},
    };
    
    const resultB = {
      source: 'openlibrary' as const,
      series: {
        name: 'Test Series',
        author: 'Test Author',
        books: [
          { title: 'Book One', position: 1 },
          { title: 'Book Two', position: 2 },
          { title: 'Book Three', position: 3 },
        ],
      },
      raw: {},
    };
    
    const comparison = compareSources(resultA, resultB);
    
    expect(comparison).not.toBeNull();
    expect(comparison!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(comparison!.bookCountMatch).toBe(true);
    expect(comparison!.orderMatch).toBe(true);
    expect(comparison!.discrepancies.length).toBe(0);
  });
  
  it('should detect book count discrepancy', () => {
    const resultA = {
      source: 'librarything' as const,
      series: {
        name: 'Test Series',
        books: [
          { title: 'Book One', position: 1 },
          { title: 'Book Two', position: 2 },
        ],
      },
      raw: {},
    };
    
    const resultB = {
      source: 'openlibrary' as const,
      series: {
        name: 'Test Series',
        books: [
          { title: 'Book One', position: 1 },
          { title: 'Book Two', position: 2 },
          { title: 'Book Three', position: 3 },
        ],
      },
      raw: {},
    };
    
    const comparison = compareSources(resultA, resultB);
    
    expect(comparison).not.toBeNull();
    expect(comparison!.bookCountMatch).toBe(false);
    expect(comparison!.discrepancies.some(d => d.field === 'book_count')).toBe(true);
  });
  
  it('should handle fuzzy title matching', () => {
    const resultA = {
      source: 'librarything' as const,
      series: {
        name: 'Test Series',
        books: [
          { title: 'The Way of Kings', position: 1 },
        ],
      },
      raw: {},
    };
    
    const resultB = {
      source: 'openlibrary' as const,
      series: {
        name: 'Test Series',
        books: [
          { title: 'Way of Kings, The', position: 1 },
        ],
      },
      raw: {},
    };
    
    const comparison = compareSources(resultA, resultB);
    
    expect(comparison).not.toBeNull();
    expect(comparison!.titleMatches).toBe(1);
  });
});

describe('Known Series Validation', () => {
  it('should have unique series names', () => {
    const names = knownSeries.map(s => s.name.toLowerCase());
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
  
  it('should have valid book counts', () => {
    for (const series of knownSeries) {
      expect(series.bookCount).toBe(series.books.length);
    }
  });
  
  it('should have sequential book positions', () => {
    for (const series of knownSeries) {
      for (let i = 0; i < series.books.length; i++) {
        expect(series.books[i].position).toBe(i + 1);
      }
    }
  });
  
  it('should cover all target genres', () => {
    const genres = new Set(knownSeries.map(s => s.genre));
    expect(genres.has('fantasy')).toBe(true);
    expect(genres.has('science-fiction')).toBe(true);
    expect(genres.has('litrpg')).toBe(true);
    expect(genres.has('post-apocalyptic')).toBe(true);
  });
});
