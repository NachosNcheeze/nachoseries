/**
 * Reconciliation Matcher
 * Compares series data from different sources and calculates confidence
 */
import type { SourceSeries, SourceResult, ComparisonResult } from '../types.js';
/**
 * Compare two source results and calculate confidence
 */
export declare function compareSources(resultA: SourceResult, resultB: SourceResult): ComparisonResult | null;
/**
 * Merge two series into one, preferring higher confidence data
 */
export declare function mergeSeries(seriesA: SourceSeries, seriesB: SourceSeries, preferSource?: 'a' | 'b'): SourceSeries;
/**
 * Check if a comparison result needs Talpa verification
 */
export declare function needsTalpaVerification(result: ComparisonResult): boolean;
//# sourceMappingURL=matcher.d.ts.map