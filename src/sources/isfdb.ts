/**
 * ISFDB Source Fetcher
 * Internet Speculative Fiction Database - traditional HTML scraping
 * 
 * ISFDB is a comprehensive database of speculative fiction.
 * Unlike LibraryThing, it uses server-side rendering so we can scrape directly.
 */

import * as cheerio from 'cheerio';
import { config } from '../config.js';
import type { SourceBook, SourceSeries, SourceResult } from '../types.js';

const BASE_URL = 'https://isfdb.org';

// Rate limiter
let lastRequest = 0;
const MIN_INTERVAL = 1000 / config.rateLimit.isfdb;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

/**
 * Search for a series on ISFDB
 */
async function searchSeries(seriesName: string): Promise<{ id: string; name: string } | null> {
  await rateLimit();
  
  const query = encodeURIComponent(seriesName);
  const url = `${BASE_URL}/cgi-bin/se.cgi?arg=${query}&type=Series`;
  
  console.log(`[ISFDB] Searching for series: ${seriesName}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  // Check if we got a direct series page (title contains "Series:")
  const pageTitle = $('title').text();
  if (pageTitle.startsWith('Series:')) {
    // Direct match - extract series ID from edit link
    const editLink = $('a[href*="editseries.cgi"]').attr('href');
    if (editLink) {
      const match = editLink.match(/editseries\.cgi\?(\d+)/);
      if (match) {
        const seriesNameFromPage = $('h2').text().replace('Series: ', '').trim();
        return { id: match[1], name: seriesNameFromPage };
      }
    }
  }
  
  // Multiple results - look for exact or best match
  const results: Array<{ id: string; name: string }> = [];
  
  // ISFDB search results show series links
  $('a[href*="pe.cgi"]').each((_, el) => {
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/pe\.cgi\?(\d+)/);
    if (match && name) {
      results.push({ id: match[1], name });
    }
  });
  
  if (results.length === 0) {
    return null;
  }
  
  // Try to find exact match first
  const exactMatch = results.find(r => 
    r.name.toLowerCase() === seriesName.toLowerCase()
  );
  if (exactMatch) return exactMatch;
  
  // Otherwise return first result
  return results[0];
}

/**
 * Search for multiple series matching a keyword
 * Returns all series from search results
 */
export async function searchSeriesKeyword(keyword: string, maxResults = 100): Promise<Array<{ id: string; name: string }>> {
  await rateLimit();
  
  const query = encodeURIComponent(keyword);
  const url = `${BASE_URL}/cgi-bin/se.cgi?arg=${query}&type=Series`;
  
  console.log(`[ISFDB] Searching series with keyword: ${keyword}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const results: Array<{ id: string; name: string }> = [];
  
  // Check if we got a direct series page (single result)
  const pageTitle = $('title').text();
  if (pageTitle.startsWith('Series:')) {
    const editLink = $('a[href*="editseries.cgi"]').attr('href');
    if (editLink) {
      const match = editLink.match(/editseries\.cgi\?(\d+)/);
      if (match) {
        const seriesNameFromPage = $('h2').text().replace('Series: ', '').trim();
        results.push({ id: match[1], name: seriesNameFromPage });
      }
    }
    return results;
  }
  
  // Multiple results - collect all series links
  $('a[href*="pe.cgi"]').each((_, el) => {
    if (results.length >= maxResults) return;
    
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/pe\.cgi\?(\d+)/);
    if (match && name) {
      // Avoid duplicates
      if (!results.find(r => r.id === match[1])) {
        results.push({ id: match[1], name });
      }
    }
  });
  
  console.log(`[ISFDB] Found ${results.length} series for keyword: ${keyword}`);
  return results;
}

/**
 * Fetch series details from ISFDB series page
 */
async function fetchSeriesPage(seriesId: string): Promise<SourceSeries | null> {
  await rateLimit();
  
  const url = `${BASE_URL}/cgi-bin/pe.cgi?${seriesId}`;
  console.log(`[ISFDB] Fetching series page: ${url}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  // Get series name from header
  const seriesName = $('h2').first().text().replace('Series: ', '').trim();
  if (!seriesName) {
    return null;
  }
  
  // Extract series tags (genre/category info)
  const tags: string[] = [];
  $('li:contains("Series Tags:")').find('a[href*="tag.cgi"]').each((_, el) => {
    const tag = $(el).text().trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  });
  if (tags.length > 0) {
    console.log(`[ISFDB] Found tags: ${tags.join(', ')}`);
  }

  // Extract author - appears in book entries as "by Author"
  let author: string | undefined;
  
  // Parse books and sub-series from the series listing
  const books: SourceBook[] = [];
  const subSeries: Array<{ id: string; name: string }> = [];

  // Check if this series is a sub-series of another (metadata header)
  let parentSeriesId: string | undefined;
  $('li:contains("Sub-series of:")').find('a[href*="pe.cgi"]').each((_, el) => {
    const href = $(el).attr('href');
    const match = href?.match(/pe\.cgi\?(\d+)/);
    if (match && !parentSeriesId) {
      parentSeriesId = match[1];
    }
  });

  // Get the content area - books are in nested lists within ContentBox divs
  const contentBoxes = $('#content .ContentBox');
  
  contentBoxes.each((boxIndex, box) => {
    const $box = $(box);
    
    // Look for li elements that have a title link with italic class
    $box.find('li').each((_, el) => {
      const $li = $(el);
      
      // Check if this li has a title link (class="italic" and href contains title.cgi)
      const titleLink = $li.find('> a.italic[href*="title.cgi"], > a[class*="italic"][href*="title.cgi"]');
      if (titleLink.length === 0) {
        // No title link — check if this is a sub-series link (pe.cgi)
        const seriesLink = $li.find('> a[href*="pe.cgi"]');
        if (seriesLink.length > 0) {
          const href = seriesLink.attr('href');
          const name = seriesLink.text().trim();
          const match = href?.match(/pe\.cgi\?(\d+)/);
          // Exclude self and parent from sub-series list
          if (match && name && match[1] !== seriesId && match[1] !== parentSeriesId && !subSeries.find(s => s.id === match[1])) {
            subSeries.push({ id: match[1], name });
          }
        }
        return;
      }
      
      // Get the text content before the link (should be the position number)
      const liText = $li.clone().children().remove().end().text().trim();
      const positionMatch = liText.match(/^(\d+(?:\.\d+)?)/);
      const position = positionMatch ? parseFloat(positionMatch[1]) : undefined;
      
      // Skip if no position (likely a subseries header with a title link)
      if (position === undefined) return;
      
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      const titleId = href?.match(/title\.cgi\?(\d+)/)?.[1];
      
      // Get year from the bold tag that contains a 4-digit year
      const boldTags = $li.find('> b');
      let year: number | undefined;
      boldTags.each((_, b) => {
        const bText = $(b).text();
        const yearMatch = bText.match(/^(\d{4})$/);
        if (yearMatch) {
          year = parseInt(yearMatch[1]);
        }
      });
      
      // Get author if not already found (only first author link, avoid translations)
      if (!author) {
        const authorLink = $li.find('a[href*="ea.cgi"]').first();
        if (authorLink.length) {
          const authorText = authorLink.text().trim();
          // Skip if it contains non-ASCII characters (likely a translation)
          if (/^[\x00-\x7F]+$/.test(authorText)) {
            author = authorText;
          }
        }
      }
      
      // Skip short fiction marked with [SF]
      const typeMarker = $li.text();
      if (typeMarker.includes('[SF]')) {
        return;
      }
      
      books.push({
        title,
        position,
        yearPublished: year,
        sourceId: titleId,
        author,
      });
    });
  });
  
  // Deduplicate books by title
  const uniqueBooks = books.reduce((acc, book) => {
    const existing = acc.find(b => b.title === book.title);
    if (!existing) {
      acc.push(book);
    }
    return acc;
  }, [] as SourceBook[]);
  
  // Sort by position
  uniqueBooks.sort((a, b) => {
    if (a.position === undefined && b.position === undefined) return 0;
    if (a.position === undefined) return 1;
    if (b.position === undefined) return -1;
    return a.position - b.position;
  });
  
  console.log(`[ISFDB] Parsed ${uniqueBooks.length} books from HTML`);
  if (subSeries.length > 0) {
    console.log(`[ISFDB] Found ${subSeries.length} sub-series: ${subSeries.map(s => s.name).join(', ')}`);
  }
  if (parentSeriesId) {
    console.log(`[ISFDB] This is a sub-series of ISFDB ID: ${parentSeriesId}`);
  }
  
  return {
    name: seriesName,
    author,
    books: uniqueBooks,
    sourceId: seriesId,
    tags: tags.length > 0 ? tags : undefined,
    subSeries: subSeries.length > 0 ? subSeries : undefined,
    parentSeriesId,
  };
}

/**
 * Fetch series by ID directly
 */
export async function fetchSeriesById(seriesId: string): Promise<SourceResult> {
  try {
    const series = await fetchSeriesPage(seriesId);
    
    if (!series) {
      return {
        source: 'isfdb',
        series: null,
        raw: { seriesId },
        error: 'Failed to parse series page',
      };
    }
    
    return {
      source: 'isfdb',
      series,
      raw: { seriesId },
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      source: 'isfdb',
      series: null,
      raw: null,
      error: message,
    };
  }
}

/**
 * Main entry point - fetch series data from ISFDB
 */
export async function fetchSeries(seriesName: string): Promise<SourceResult> {
  try {
    // First search for the series
    const searchResult = await searchSeries(seriesName);
    
    if (!searchResult) {
      return {
        source: 'isfdb',
        series: null,
        raw: null,
        error: 'Series not found',
      };
    }
    
    console.log(`[ISFDB] Found series: ${searchResult.name} (ID: ${searchResult.id})`);
    
    // Fetch the full series page
    const series = await fetchSeriesPage(searchResult.id);
    
    if (!series) {
      return {
        source: 'isfdb',
        series: null,
        raw: { searchResult },
        error: 'Failed to parse series page',
      };
    }
    
    console.log(`[ISFDB] Found ${series.books.length} books in series`);
    
    return {
      source: 'isfdb',
      series,
      raw: { searchResult },
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[ISFDB] Error: ${message}`);
    return {
      source: 'isfdb',
      series: null,
      raw: null,
      error: message,
    };
  }
}

/**
 * Genre search keywords for crawling
 * These map our genres to ISFDB search terms
 */
export const genreKeywords: Record<string, string[]> = {
  'litrpg': ['litrpg', 'gamelit', 'dungeon core', 'cultivation'],
  'fantasy': ['epic fantasy series', 'high fantasy', 'urban fantasy series', 'sword and sorcery'],
  'science-fiction': ['space opera', 'hard science fiction', 'military sf series', 'cyberpunk'],
  'post-apocalyptic': ['post-apocalyptic', 'apocalyptic', 'dystopian series'],
};

/**
 * Comprehensive genre tag mappings for ISFDB
 * Includes exact matches, partial patterns, and ISFDB-specific terminology
 */
const GENRE_TAG_MAP: Record<string, { exact: string[]; contains: string[] }> = {
  'litrpg': {
    exact: ['litrpg', 'gamelit', 'progression fantasy', 'cultivation', 'dungeon core', 'isekai', 'wuxia', 'xianxia'],
    contains: ['rpg', 'game-', 'level up', 'stat screen']
  },
  'post-apocalyptic': {
    exact: [
      'post-apocalyptic', 'apocalyptic', 'post apocalypse', 'dystopia', 'dystopian',
      'zombie', 'zombies', 'nuclear war', 'nuclear holocaust', 'plague', 'pandemic',
      'ecological disaster', 'collapse of civilization', 'survivalist', 'end of the world'
    ],
    contains: ['apocalyp', 'dystop', 'post-nuclear', 'survival']
  },
  'horror': {
    exact: [
      'horror', 'supernatural horror', 'gothic', 'cosmic horror', 'lovecraftian',
      'cthulhu mythos', 'vampires', 'vampire', 'werewolf', 'werewolves', 'haunted',
      'ghosts', 'ghost', 'slasher', 'monster', 'monsters', 'demon', 'demons',
      'possession', 'exorcism', 'occult', 'satanic', 'serial killer', 'cannibalism',
      'body horror', 'folk horror', 'psychological horror', 'splatterpunk',
      'creature feature', 'lovecraft', 'haunting', 'poltergeist', 'undead'
    ],
    contains: ['horror', 'terror', 'nightmare', 'creep', 'scary', 'frightening']
  },
  'mystery': {
    exact: [
      'mystery', 'detective', 'crime fiction', 'crime', 'whodunit', 'sleuth', 'noir',
      'cozy mystery', 'police procedural', 'private investigator', 'amateur sleuth',
      'locked room', 'murder mystery', 'investigation', 'forensic'
    ],
    contains: ['mystery', 'detective', 'murder', 'crime']
  },
  'thriller': {
    exact: [
      'thriller', 'suspense', 'spy fiction', 'espionage', 'spy', 'assassin',
      'conspiracy', 'political thriller', 'techno-thriller', 'legal thriller',
      'medical thriller', 'action', 'adventure', 'terrorism', 'kidnapping'
    ],
    contains: ['thriller', 'suspense', 'espionage']
  },
  'romance': {
    exact: [
      'romance', 'paranormal romance', 'romantic fantasy', 'love story',
      'regency romance', 'historical romance', 'contemporary romance',
      'romantic suspense', 'erotic romance'
    ],
    contains: ['romance', 'romantic']
  },
  'science-fiction': {
    exact: [
      'science fiction', 'sf', 'sci-fi', 'scifi', 'space opera', 'hard sf',
      'hard science fiction', 'military sf', 'military science fiction', 'cyberpunk',
      'space exploration', 'alien contact', 'first contact', 'time travel',
      'robots', 'robot', 'ai', 'artificial intelligence', 'nanotechnology',
      'colonization', 'galactic empire', 'far future', 'interstellar travel',
      'aliens', 'alien', 'space war', 'space warfare', 'terraforming', 'mars',
      'near future', 'alternate history', 'parallel universe', 'parallel universes',
      'young-adult sf', 'juvenile sf', 'steampunk', 'dieselpunk', 'biopunk',
      'generation ship', 'space station', 'starship', 'ftl', 'warp drive',
      'clone', 'cloning', 'genetic engineering', 'transhumanism', 'posthuman',
      'singularity', 'virtual reality', 'simulation', 'matrix', 'uploaded minds',
      'dyson sphere', 'ringworld', 'megastructure', 'planet', 'planetary romance',
      'solar system', 'asteroid', 'moon', 'venus', 'jupiter', 'saturn',
      'faster than light', 'hyperspace', 'wormhole', 'space fleet', 'space navy',
      'alien invasion', 'extraterrestrial', 'ufo', 'contact', 'seti',
      'space colony', 'generation starship', 'sleeper ship', 'cryo', 'cryonics',
      'uplift', 'sentient', 'android', 'cyborg', 'mech', 'mecha', 'power armor',
      'galactic', 'interplanetary', 'interstellar', 'intergalactic',
      'future war', 'star war', 'space battle', 'space combat',
      'psionics', 'psi', 'telepathy', 'telekinesis', 'precognition'
    ],
    contains: ['sf', 'sci-fi', 'science fic', 'space', 'alien', 'robot', 'cyber', 'future', 'star']
  },
  'fantasy': {
    exact: [
      'fantasy', 'epic fantasy', 'high fantasy', 'urban fantasy', 'sword and sorcery',
      'heroic fantasy', 'magic', 'magical', 'dragons', 'dragon', 'elves', 'elf',
      'wizards', 'wizard', 'mage', 'quest', 'witches', 'witch', 'sorcery', 'sorcerer',
      'humorous fantasy', 'historical fantasy', 'gaslamp fantasy', 'young-adult fantasy',
      'juvenile fantasy', 'dark fantasy', 'fairy tale', 'fairy tales', 'retold fairy tales',
      'fae', 'faerie', 'faery', 'folklore', 'myth', 'mythology', 'mythological',
      'arthurian', 'camelot', 'merlin', 'king arthur', 'medieval', 'knights',
      'kingdom', 'kingdoms', 'prince', 'princess', 'royalty', 'throne',
      'prophecy', 'chosen one', 'dark lord', 'necromancer', 'necromancy',
      'shapeshifter', 'shapeshifting', 'werewolf fantasy', 'vampire fantasy',
      'portal fantasy', 'secondary world', 'alternate world', 'other world',
      'sword', 'swords', 'enchanted', 'enchantment', 'spellcaster', 'spells',
      'demons', 'angels', 'gods', 'goddesses', 'pantheon', 'divine',
      'elemental', 'elementals', 'druid', 'druids', 'shaman', 'shamanic',
      'unicorn', 'phoenix', 'griffin', 'gryphon', 'pegasus', 'mythical creatures',
      'dwarves', 'dwarf', 'halfling', 'hobbit', 'orc', 'orcs', 'goblin', 'goblins',
      'troll', 'trolls', 'giant', 'giants', 'ogre', 'ogres',
      'castle', 'tower', 'dungeon', 'labyrinth', 'maze',
      'cursed', 'curse', 'blessing', 'artifact', 'magical artifact', 'talisman',
      'grimoire', 'spellbook', 'wand', 'staff', 'amulet', 'ring of power',
      'portal', 'dimension', 'realm', 'otherworld', 'underworld', 'overworld'
    ],
    contains: ['fantasy', 'magic', 'wizard', 'witch', 'dragon', 'elf', 'elv', 'sword', 'sorcery', 'fairy', 'fae', 'myth']
  }
};

// Priority order for tie-breaking (most specific first)
const GENRE_PRIORITY = ['litrpg', 'horror', 'mystery', 'thriller', 'post-apocalyptic', 'romance', 'science-fiction', 'fantasy'];

/**
 * Map ISFDB tags to our genre categories
 * Uses both exact matching and substring matching for better coverage
 * 
 * Strategy: 
 * 1. Score each genre based on exact and partial tag matches
 * 2. Exact matches score 2 points, partial matches score 1 point
 * 3. Pick genre with highest score, use priority for ties
 */
export function mapTagsToGenre(tags: string[]): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  
  const normalizedTags = tags.map(t => t.toLowerCase().trim());
  const genreScores: Record<string, number> = {};
  
  for (const [genre, patterns] of Object.entries(GENRE_TAG_MAP)) {
    let score = 0;
    
    // Check exact matches (2 points each)
    for (const exactTag of patterns.exact) {
      if (normalizedTags.includes(exactTag)) {
        score += 2;
      }
    }
    
    // Check partial/contains matches (1 point each, but only if not already matched)
    for (const tag of normalizedTags) {
      for (const partial of patterns.contains) {
        if (tag.includes(partial) && !patterns.exact.includes(tag)) {
          score += 1;
          break; // Only count each tag once per genre
        }
      }
    }
    
    if (score > 0) {
      genreScores[genre] = score;
    }
  }
  
  // No matches
  if (Object.keys(genreScores).length === 0) {
    return undefined;
  }
  
  // Find max score
  const maxScore = Math.max(...Object.values(genreScores));
  
  // Get all genres with max score
  const topGenres = Object.entries(genreScores)
    .filter(([_, score]) => score === maxScore)
    .map(([genre]) => genre);
  
  // Single winner
  if (topGenres.length === 1) {
    return topGenres[0];
  }
  
  // Tie-break by priority
  for (const genre of GENRE_PRIORITY) {
    if (topGenres.includes(genre)) {
      return genre;
    }
  }
  
  return topGenres[0];
}

/**
 * Analyze series name to guess genre when tags are unavailable
 * Uses keyword patterns in the series name itself
 */
export function guessGenreFromName(seriesName: string): string | undefined {
  const name = seriesName.toLowerCase();
  
  // LitRPG patterns (highest priority)
  if (/\b(litrpg|gamelit|dungeon\s*core|cultivation|system\s*apocalypse|tower|isekai)\b/.test(name)) {
    return 'litrpg';
  }
  
  // Post-apocalyptic patterns
  if (/\b(apocalypse|apocalyptic|post-?apocal|wasteland|zombie|undead|survivor|collapse|extinction)\b/.test(name)) {
    return 'post-apocalyptic';
  }
  
  // Horror patterns
  if (/\b(horror|nightmare|terror|haunt|ghost|demon|vampire|werewolf|monster|dark|evil|death|dead|blood|shadow|fear)\b/.test(name)) {
    // But not if clearly fantasy (e.g., "Dark Fantasy")
    if (!/fantasy/.test(name)) {
      return 'horror';
    }
  }
  
  // Mystery patterns
  if (/\b(mystery|mysteries|detective|murder|crime|sleuth|investigation|noir|whodunit)\b/.test(name)) {
    return 'mystery';
  }
  
  // Thriller patterns
  if (/\b(thriller|suspense|spy|espionage|assassin|conspiracy)\b/.test(name)) {
    return 'thriller';
  }
  
  // Science fiction patterns (before fantasy to catch sci-fi specific terms)
  if (/\b(space|star|galactic|starship|planet|alien|robot|android|cyber|future|colony|empire|federation|fleet|ship|universe|quantum|dimension|warp|hyperspace|mech|tech)\b/.test(name)) {
    // Exclude fantasy-ish terms
    if (!/\b(magic|wizard|witch|dragon|elf|sword|fantasy|quest)\b/.test(name)) {
      return 'science-fiction';
    }
  }
  
  // Fantasy patterns (broadest, last check)
  if (/\b(fantasy|magic|wizard|witch|dragon|elf|elven|dwarf|orc|quest|kingdom|throne|crown|sword|sorcery|mage|knight|castle|realm|prophecy|chosen|fae|fairy|folk|myth|legend|enchant)\b/.test(name)) {
    return 'fantasy';
  }
  
  // Romance patterns
  if (/\b(romance|love|heart|passion|bride|wedding)\b/.test(name)) {
    return 'romance';
  }
  
  return undefined;
}

/**
 * Combined genre detection: tries tags first, then falls back to name analysis
 */
export function detectGenre(tags: string[] | undefined, seriesName: string): string | undefined {
  // First try tags
  const fromTags = tags ? mapTagsToGenre(tags) : undefined;
  if (fromTags) return fromTags;
  
  // Fall back to name analysis
  return guessGenreFromName(seriesName);
}

/**
 * Browse series by genre using keyword searches
 */
export async function browseSeriesByGenre(genre: string): Promise<Array<{ id: string; name: string }>> {
  const keywords = genreKeywords[genre] || [genre];
  const allSeries: Array<{ id: string; name: string }> = [];
  const seenIds = new Set<string>();
  
  for (const keyword of keywords) {
    const results = await searchSeriesKeyword(keyword, 50);
    
    for (const series of results) {
      if (!seenIds.has(series.id)) {
        seenIds.add(series.id);
        allSeries.push(series);
      }
    }
    
    // Be nice to ISFDB
    await rateLimit();
  }
  
  console.log(`[ISFDB] Total unique series for genre "${genre}": ${allSeries.length}`);
  return allSeries;
}
/**
 * Fetch list of popular authors (top novel authors)
 * Returns author IDs and names
 */
export async function fetchPopularAuthors(limit = 500): Promise<Array<{ id: string; name: string }>> {
  await rateLimit();
  
  const url = `${BASE_URL}/cgi-bin/popular_authors.cgi?1+all`;
  
  console.log(`[ISFDB] Fetching popular authors list...`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const authors: Array<{ id: string; name: string }> = [];
  
  // Author links follow pattern ea.cgi?{id}
  $('a[href*="ea.cgi"]').each((_, el) => {
    if (authors.length >= limit) return;
    
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/ea\.cgi\?(\d+)/);
    
    if (match && name && name.length > 0) {
      // Skip if already seen (there can be duplicates)
      if (!authors.find(a => a.id === match[1])) {
        authors.push({ id: match[1], name });
      }
    }
  });
  
  console.log(`[ISFDB] Found ${authors.length} popular authors`);
  return authors;
}

/**
 * Fetch all series by a specific author
 */
export async function fetchAuthorSeries(authorId: string): Promise<Array<{ id: string; name: string }>> {
  await rateLimit();
  
  const url = `${BASE_URL}/cgi-bin/ea.cgi?${authorId}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const series: Array<{ id: string; name: string }> = [];
  
  // Series links use pe.cgi?{id} format
  $('a[href*="pe.cgi"]').each((_, el) => {
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    const match = href?.match(/pe\.cgi\?(\d+)/);
    
    // Skip pe.cgi?0 which is "no series"
    if (match && match[1] !== '0' && name && name.length > 0) {
      if (!series.find(s => s.id === match[1])) {
        series.push({ id: match[1], name });
      }
    }
  });
  
  return series;
}

/**
 * Discovery mode: crawl popular authors and collect all their series
 */
export async function discoverSeriesFromAuthors(
  maxAuthors = 100,
  onProgress?: (current: number, total: number, author: string, seriesCount: number) => void
): Promise<Array<{ id: string; name: string; author: string }>> {
  const authors = await fetchPopularAuthors(maxAuthors);
  const allSeries: Array<{ id: string; name: string; author: string }> = [];
  const seenIds = new Set<string>();
  
  for (let i = 0; i < authors.length; i++) {
    const author = authors[i];
    
    try {
      const series = await fetchAuthorSeries(author.id);
      
      for (const s of series) {
        if (!seenIds.has(s.id)) {
          seenIds.add(s.id);
          allSeries.push({ ...s, author: author.name });
        }
      }
      
      onProgress?.(i + 1, authors.length, author.name, series.length);
    } catch (error) {
      console.error(`[ISFDB] Failed to fetch series for author ${author.name}: ${error}`);
    }
  }
  
  console.log(`[ISFDB] Discovered ${allSeries.length} unique series from ${authors.length} authors`);
  return allSeries;
}

/**
 * Scan series IDs directly (for comprehensive discovery)
 * Series IDs are sequential, so we can scan a range
 */
export async function scanSeriesRange(
  startId: number,
  endId: number,
  onProgress?: (current: number, total: number, found: number) => void
): Promise<Array<{ id: string; name: string }>> {
  const series: Array<{ id: string; name: string }> = [];
  const total = endId - startId + 1;
  
  for (let id = startId; id <= endId; id++) {
    await rateLimit();
    
    try {
      const url = `${BASE_URL}/cgi-bin/pe.cgi?${id}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'NachoSeries/0.1.0 (Series Indexer)',
        },
      });
      
      if (!response.ok) continue;
      
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // Check if it's a valid series page
      const pageTitle = $('title').text();
      if (pageTitle.startsWith('Series:')) {
        const name = pageTitle.replace('Series:', '').trim();
        if (name) {
          series.push({ id: id.toString(), name });
        }
      }
      
      onProgress?.(id - startId + 1, total, series.length);
    } catch (error) {
      // Skip errors, series ID might not exist
    }
  }
  
  return series;
}
