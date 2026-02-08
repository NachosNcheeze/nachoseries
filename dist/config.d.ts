/**
 * NachoSeries Configuration
 * Series database builder for Bookarr
 */
export declare const config: {
    database: {
        path: string;
    };
    genres: string[];
    yearRange: {
        start: number;
        end: number;
    };
    confidence: {
        autoAccept: number;
        needsVerify: number;
        manualReview: number;
    };
    quotas: {
        talpa: number;
        thingISBN: number;
        thingTitle: number;
    };
    rateLimit: {
        librarything: number;
        openLibrary: number;
        isfdb: number;
    };
    schedule: {
        crawlTime: string;
        verifyTime: string;
    };
    libraryThing: {
        apiKey: string;
    };
    flareSolverr: {
        url: string;
        timeout: number;
    };
};
export type Config = typeof config;
//# sourceMappingURL=config.d.ts.map