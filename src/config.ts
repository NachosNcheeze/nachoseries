/**
 * NachoSeries Configuration
 * Series database builder for Bookarr
 */

export const config = {
  // Database
  database: {
    path: process.env.NACHOSERIES_DB_PATH || './data/nachoseries.db',
  },
  
  // Language filtering - only allow English series
  language: {
    allowedLanguages: ['english'],
    filterEnabled: true,
  },
  
  // Target genres to crawl
  genres: [
    'science-fiction',
    'litrpg',
    'fantasy',
    'post-apocalyptic',
  ],
  
  // Year range for series
  yearRange: {
    start: 2000,
    end: new Date().getFullYear(),
  },
  
  // Confidence thresholds
  confidence: {
    autoAccept: 0.90,      // 90%+ - auto-accept without verification
    needsVerify: 0.70,     // 70-89% - queue for Talpa verification
    manualReview: 0.70,    // <70% - needs manual review
  },
  
  // API quotas (daily limits)
  quotas: {
    talpa: 50,             // LibraryThing Talpa - conflict resolution only
    thingISBN: 1000,       // LibraryThing ISBN lookup
    thingTitle: 1000,      // LibraryThing title lookup
  },
  
  // Rate limiting (requests per second)
  rateLimit: {
    librarything: 1,       // 1 req/sec for page scraping
    openLibrary: 5,        // 5 req/sec allowed
    isfdb: 1,              // Be nice to ISFDB
  },
  
  // Scheduling
  schedule: {
    crawlTime: '03:00',    // 3 AM - crawl new series
    verifyTime: '04:00',   // 4 AM - verify existing series
  },
  
  // LibraryThing API key (optional, for Talpa)
  libraryThing: {
    apiKey: process.env.LIBRARYTHING_API_KEY || '',
  },
  
  // FlareSolverr for Cloudflare bypass
  flareSolverr: {
    url: process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1',
    timeout: 60000,  // 60 seconds max for Cloudflare challenges
  },
};

export type Config = typeof config;
