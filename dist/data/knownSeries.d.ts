/**
 * Known Series Test Data
 * These are series with verified correct information for testing accuracy
 */
export interface KnownSeries {
    name: string;
    author: string;
    bookCount: number;
    genre: string;
    books: Array<{
        position: number;
        title: string;
    }>;
}
export declare const knownSeries: KnownSeries[];
/**
 * Get known series by genre
 */
export declare function getKnownSeriesByGenre(genre: string): KnownSeries[];
/**
 * Get a specific known series by name
 */
export declare function getKnownSeries(name: string): KnownSeries | undefined;
//# sourceMappingURL=knownSeries.d.ts.map