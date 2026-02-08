/**
 * FlareSolverr Client
 * Bypasses Cloudflare protection using FlareSolverr proxy
 */
/**
 * Fetch a URL through FlareSolverr to bypass Cloudflare
 */
export declare function fetchWithFlaresolverr(url: string): Promise<{
    html: string;
    status: number;
    cookies: Array<{
        name: string;
        value: string;
    }>;
} | null>;
/**
 * Check if FlareSolverr is available
 */
export declare function checkFlareSolverr(): Promise<boolean>;
//# sourceMappingURL=flareSolverr.d.ts.map