/**
 * NachoSeries Type Definitions
 */
// =============================================================================
// Crawl Types
// =============================================================================
/**
 * Genre mapping for different sources
 */
export const GENRE_MAPPING = {
    'science-fiction': {
        librarything: 'Science fiction',
        openlibrary: 'science_fiction',
        isfdb: 'SF',
    },
    'fantasy': {
        librarything: 'Fantasy',
        openlibrary: 'fantasy',
        isfdb: 'Fantasy',
    },
    'litrpg': {
        librarything: 'LitRPG',
        openlibrary: 'litrpg', // May not exist
        isfdb: '', // Not tracked
    },
    'post-apocalyptic': {
        librarything: 'Post-apocalyptic',
        openlibrary: 'post_apocalyptic',
        isfdb: 'Post-Apocalyptic',
    },
};
//# sourceMappingURL=types.js.map