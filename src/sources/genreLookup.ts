/**
 * Genre Lookup Module
 * Looks up genres from external sources using book titles/authors
 * This is SEPARATE from series structure - only used for genre tagging
 */

import { config } from '../config.js';

// Rate limiter for Open Library
let lastOLRequest = 0;
const OL_MIN_INTERVAL = 1000 / (config.rateLimit?.openLibrary || 5);

async function rateLimitOL(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastOLRequest;
  if (elapsed < OL_MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, OL_MIN_INTERVAL - elapsed));
  }
  lastOLRequest = Date.now();
}

/**
 * Map Open Library subjects to our genre categories
 * Uses hierarchical matching - more specific subjects take priority
 */
const SUBJECT_GENRE_MAP: Record<string, { genre: string; weight: number }> = {
  // LitRPG / GameLit (highest priority)
  'litrpg': { genre: 'litrpg', weight: 100 },
  'gamelit': { genre: 'litrpg', weight: 100 },
  'progression fantasy': { genre: 'litrpg', weight: 95 },
  'cultivation': { genre: 'litrpg', weight: 95 },
  
  // Post-Apocalyptic
  'post-apocalyptic fiction': { genre: 'post-apocalyptic', weight: 90 },
  'apocalyptic fiction': { genre: 'post-apocalyptic', weight: 85 },
  'dystopian fiction': { genre: 'post-apocalyptic', weight: 80 },
  'dystopia': { genre: 'post-apocalyptic', weight: 80 },
  'dystopias': { genre: 'post-apocalyptic', weight: 80 },
  'survival': { genre: 'post-apocalyptic', weight: 50 },
  
  // Horror
  'horror': { genre: 'horror', weight: 90 },
  'horror fiction': { genre: 'horror', weight: 90 },
  'horror tales': { genre: 'horror', weight: 85 },
  'ghost stories': { genre: 'horror', weight: 80 },
  'vampires': { genre: 'horror', weight: 75 },
  'werewolves': { genre: 'horror', weight: 75 },
  'supernatural': { genre: 'horror', weight: 60 },
  'occult fiction': { genre: 'horror', weight: 70 },
  'gothic fiction': { genre: 'horror', weight: 65 },
  
  // Mystery
  'mystery fiction': { genre: 'mystery', weight: 90 },
  'mystery': { genre: 'mystery', weight: 85 },
  'detective fiction': { genre: 'mystery', weight: 85 },
  'detective and mystery stories': { genre: 'mystery', weight: 85 },
  'crime fiction': { genre: 'mystery', weight: 80 },
  'murder': { genre: 'mystery', weight: 60 },
  'private investigators': { genre: 'mystery', weight: 70 },
  
  // Thriller
  'thriller': { genre: 'thriller', weight: 85 },
  'thrillers': { genre: 'thriller', weight: 85 },
  'suspense fiction': { genre: 'thriller', weight: 80 },
  'spy stories': { genre: 'thriller', weight: 80 },
  'espionage': { genre: 'thriller', weight: 75 },
  'political fiction': { genre: 'thriller', weight: 50 },
  
  // Romance
  'romance': { genre: 'romance', weight: 85 },
  'romance fiction': { genre: 'romance', weight: 85 },
  'love stories': { genre: 'romance', weight: 80 },
  'paranormal romance': { genre: 'romance', weight: 85 },
  'romantic suspense': { genre: 'romance', weight: 75 },
  
  // Science Fiction (before fantasy - both can match, but sf-specific terms win)
  'science fiction': { genre: 'science-fiction', weight: 90 },
  'science fiction, american': { genre: 'science-fiction', weight: 85 },
  'science fiction, english': { genre: 'science-fiction', weight: 85 },
  'space opera': { genre: 'science-fiction', weight: 90 },
  'space flight': { genre: 'science-fiction', weight: 70 },
  'space warfare': { genre: 'science-fiction', weight: 80 },
  'interplanetary voyages': { genre: 'science-fiction', weight: 80 },
  'interstellar travel': { genre: 'science-fiction', weight: 80 },
  'time travel': { genre: 'science-fiction', weight: 75 },
  'robots': { genre: 'science-fiction', weight: 70 },
  'artificial intelligence': { genre: 'science-fiction', weight: 75 },
  'cyberpunk': { genre: 'science-fiction', weight: 85 },
  'aliens': { genre: 'science-fiction', weight: 70 },
  'extraterrestrial beings': { genre: 'science-fiction', weight: 75 },
  'life on other planets': { genre: 'science-fiction', weight: 75 },
  'space colonies': { genre: 'science-fiction', weight: 80 },
  'military science fiction': { genre: 'science-fiction', weight: 90 },
  'hard science fiction': { genre: 'science-fiction', weight: 90 },
  'galactic empire': { genre: 'science-fiction', weight: 80 },
  'future': { genre: 'science-fiction', weight: 40 },
  
  // Fantasy (broadest - last resort)
  'fantasy': { genre: 'fantasy', weight: 85 },
  'fantasy fiction': { genre: 'fantasy', weight: 85 },
  'epic fantasy': { genre: 'fantasy', weight: 90 },
  'high fantasy': { genre: 'fantasy', weight: 90 },
  'urban fantasy': { genre: 'fantasy', weight: 85 },
  'dark fantasy': { genre: 'fantasy', weight: 80 },
  'sword and sorcery': { genre: 'fantasy', weight: 85 },
  'magic': { genre: 'fantasy', weight: 70 },
  'wizards': { genre: 'fantasy', weight: 75 },
  'witches': { genre: 'fantasy', weight: 70 },
  'dragons': { genre: 'fantasy', weight: 80 },
  'elves': { genre: 'fantasy', weight: 80 },
  'dwarves': { genre: 'fantasy', weight: 75 },
  'imaginary places': { genre: 'fantasy', weight: 50 },
  'imaginary wars and battles': { genre: 'fantasy', weight: 50 },
  'quests (expeditions)': { genre: 'fantasy', weight: 60 },
  'fairy tales': { genre: 'fantasy', weight: 70 },
  'mythology': { genre: 'fantasy', weight: 60 },
  'legends': { genre: 'fantasy', weight: 55 },
};

interface GenreResult {
  genre: string;
  confidence: number;  // 0-100
  source: string;
  matchedSubjects: string[];
}

/**
 * Look up genre from Open Library using a book title and optional author
 */
export async function lookupGenreOpenLibrary(
  title: string, 
  author?: string
): Promise<GenreResult | null> {
  try {
    await rateLimitOL();
    
    // Build search query
    let query = encodeURIComponent(title);
    if (author) {
      query += `+author:${encodeURIComponent(author)}`;
    }
    
    const url = `https://openlibrary.org/search.json?q=${query}&fields=key,title,subject&limit=5`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'NachoSeries/0.1.0 (Genre Lookup)',
      },
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json() as {
      docs: Array<{
        key: string;
        title: string;
        subject?: string[];
      }>;
    };
    
    if (!data.docs || data.docs.length === 0) {
      return null;
    }
    
    // Collect all subjects from matching results
    const allSubjects: string[] = [];
    for (const doc of data.docs) {
      if (doc.subject) {
        allSubjects.push(...doc.subject.map(s => s.toLowerCase()));
      }
    }
    
    if (allSubjects.length === 0) {
      return null;
    }
    
    // Score genres based on subject matches
    const genreScores: Record<string, { score: number; matches: string[] }> = {};
    
    for (const subject of allSubjects) {
      const mapping = SUBJECT_GENRE_MAP[subject];
      if (mapping) {
        if (!genreScores[mapping.genre]) {
          genreScores[mapping.genre] = { score: 0, matches: [] };
        }
        genreScores[mapping.genre].score += mapping.weight;
        if (!genreScores[mapping.genre].matches.includes(subject)) {
          genreScores[mapping.genre].matches.push(subject);
        }
      }
    }
    
    // Find highest scoring genre
    let bestGenre: string | null = null;
    let bestScore = 0;
    let bestMatches: string[] = [];
    
    for (const [genre, data] of Object.entries(genreScores)) {
      if (data.score > bestScore) {
        bestScore = data.score;
        bestGenre = genre;
        bestMatches = data.matches;
      }
    }
    
    if (!bestGenre || bestScore < 50) {
      return null;  // Not confident enough
    }
    
    // Normalize confidence to 0-100
    const confidence = Math.min(100, bestScore);
    
    return {
      genre: bestGenre,
      confidence,
      source: 'openlibrary',
      matchedSubjects: bestMatches,
    };
    
  } catch (error) {
    console.error(`[GenreLookup] Error looking up "${title}":`, error);
    return null;
  }
}

/**
 * Look up genre for a series by checking its books
 * Returns as soon as we get a confident match
 */
export async function lookupGenreForSeries(
  books: Array<{ title: string; author?: string }>,
  maxAttempts = 3
): Promise<GenreResult | null> {
  // Try up to maxAttempts books
  const booksToTry = books.slice(0, maxAttempts);
  
  for (const book of booksToTry) {
    const result = await lookupGenreOpenLibrary(book.title, book.author);
    
    if (result && result.confidence >= 70) {
      return result;
    }
  }
  
  return null;
}

/**
 * Batch lookup - returns first successful genre match
 */
export async function batchLookupGenre(
  titles: string[],
  author?: string
): Promise<GenreResult | null> {
  for (const title of titles.slice(0, 5)) {
    const result = await lookupGenreOpenLibrary(title, author);
    if (result) {
      return result;
    }
  }
  return null;
}
