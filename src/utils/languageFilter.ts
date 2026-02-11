/**
 * Language Detection and Filtering
 * Detects non-English series titles and filters them out
 */

import { config } from '../config.js';

/**
 * Strong non-English indicators - these almost certainly mean non-English
 * Only trigger on patterns that DON'T commonly appear in English titles
 */
const STRONG_NON_ENGLISH_PATTERNS: Array<{ pattern: RegExp; language: string; weight: number }> = [
  // Non-ASCII characters (strongest signal)
  { pattern: /[äöüßÄÖÜ]/, language: 'german', weight: 100 },
  { pattern: /[éèêëàâùûôîïç]/, language: 'french', weight: 100 },
  { pattern: /[ñ¿¡]/, language: 'spanish', weight: 100 },
  { pattern: /[ãõ]/, language: 'portuguese', weight: 100 },
  { pattern: /[ąćęłńśźżĄĆĘŁŃŚŹŻ]/, language: 'polish', weight: 100 },
  { pattern: /[ěščřžďťňĚŠČŘŽĎŤŇ]/, language: 'czech', weight: 100 },
  { pattern: /[åøæÅØÆ]/, language: 'nordic', weight: 100 },
  { pattern: /[а-яА-ЯёЁ]/, language: 'russian', weight: 100 },
  { pattern: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/, language: 'asian', weight: 100 },
  
  // German-specific words (not used in English)
  { pattern: /\bZyklus\b/i, language: 'german', weight: 90 },
  { pattern: /\b(und|oder|mit|zur|zum|einer|des|dem)\b/i, language: 'german', weight: 80 },
  { pattern: /\b(Welt|Zeit|Macht|Krieg|Reich|König|Götter)\b/, language: 'german', weight: 70 },
  
  // French-specific (avoiding "de" and "le" which appear in English names)
  { pattern: /\b(avec|pour|dans|sous|sur|entre|chez)\b/i, language: 'french', weight: 80 },
  
  // Dutch-specific
  { pattern: /\bverhalen\b/i, language: 'dutch', weight: 90 },
  { pattern: /\b(het|naar|voor)\b/i, language: 'dutch', weight: 60 },
  
  // Spanish-specific (avoiding "del" which appears in English names like "Del Rey")
  { pattern: /\b(los|las|unos|unas)\b/i, language: 'spanish', weight: 70 },
  
  // Patterns that indicate translated/parallel titles
  { pattern: /\s\/\s.*[а-яА-Я]/, language: 'russian', weight: 100 }, // "Title / Заголовок"
  { pattern: /\([^)]*[äöüéèêàâ][^)]*\)/, language: 'mixed', weight: 80 }, // Parenthetical with accents
];

/**
 * Words that appear in English titles frequently - boost English score
 */
const ENGLISH_BOOST_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /^The\s/i, weight: 30 },
  { pattern: /\bof\s+the\b/i, weight: 25 },
  { pattern: /\b(Chronicles?|Saga|Trilogy|Series|Tales?|Stories)\b/i, weight: 20 },
  { pattern: /\b(Dragon|Wizard|Witch|Magic|Sword|Knight|King|Queen|Lord|Empire|Kingdom)\b/i, weight: 15 },
  { pattern: /\b(War|World|Time|Book|Volume)\b/i, weight: 10 },
];

interface LanguageResult {
  isEnglish: boolean;
  detectedLanguage: string | null;
  confidence: number;  // 0-100
  matchedPatterns: string[];
}

/**
 * Detect if a series title is likely English
 * Uses weighted scoring - strong non-English signals override English words
 */
export function detectLanguage(title: string): LanguageResult {
  const matchedNonEnglish: Array<{ language: string; pattern: string; weight: number }> = [];
  let englishScore = 0;
  let nonEnglishScore = 0;
  
  // Check for English boost patterns
  for (const { pattern, weight } of ENGLISH_BOOST_PATTERNS) {
    if (pattern.test(title)) {
      englishScore += weight;
    }
  }
  
  // Check for non-English patterns
  for (const { pattern, language, weight } of STRONG_NON_ENGLISH_PATTERNS) {
    if (pattern.test(title)) {
      matchedNonEnglish.push({ language, pattern: pattern.source, weight });
      nonEnglishScore += weight;
    }
  }
  
  // Strong non-English signals (special chars, Cyrillic, CJK) are definitive
  const hasStrongSignal = matchedNonEnglish.some(m => m.weight >= 100);
  
  // Decision: if strong signal, definitely not English
  // Otherwise, compare scores with bias toward English (since most content is English)
  const isEnglish = !hasStrongSignal && (nonEnglishScore < 50 || englishScore > nonEnglishScore);
  
  // Determine most likely non-English language
  let detectedLanguage: string | null = null;
  if (!isEnglish && matchedNonEnglish.length > 0) {
    const langScores: Record<string, number> = {};
    for (const match of matchedNonEnglish) {
      langScores[match.language] = (langScores[match.language] || 0) + match.weight;
    }
    detectedLanguage = Object.entries(langScores)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  
  const totalScore = englishScore + nonEnglishScore;
  const confidence = totalScore > 0 
    ? Math.min(100, Math.round((isEnglish ? englishScore : nonEnglishScore) / totalScore * 100))
    : 50;
  
  return {
    isEnglish,
    detectedLanguage,
    confidence,
    matchedPatterns: matchedNonEnglish.map(m => `${m.language}: ${m.pattern}`),
  };
}

/**
 * Check if a series should be filtered out based on language
 */
export function shouldFilterSeries(seriesName: string): boolean {
  if (!config.language?.filterEnabled) {
    return false;
  }
  
  const result = detectLanguage(seriesName);
  return !result.isEnglish;
}

/**
 * SQL WHERE clause patterns for finding non-English series
 * Returns an array of LIKE patterns
 */
export function getNonEnglishSqlPatterns(): string[] {
  return [
    // German
    "name LIKE '% der %'",
    "name LIKE '% die %'",
    "name LIKE '% das %'",
    "name LIKE '% und %'",
    "name LIKE '% des %'",
    "name LIKE '%Zyklus%'",
    // French
    "name LIKE '% le %'",
    "name LIKE '% la %'",
    "name LIKE '% les %'",
    "name LIKE '% et %'",
    // Spanish
    "name LIKE '% el %'",
    "name LIKE '% los %'",
    "name LIKE '% las %'",
    // Dutch
    "name LIKE '%verhalen%'",
  ];
}
