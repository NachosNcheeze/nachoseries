/**
 * FlareSolverr Client
 * Bypasses Cloudflare protection using FlareSolverr proxy
 */

import { config } from '../config.js';

interface FlareSolverrResponse {
  status: string;
  message: string;
  startTimestamp: number;
  endTimestamp: number;
  version: string;
  solution: {
    url: string;
    status: number;
    headers: Record<string, string>;
    response: string;
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
    }>;
    userAgent: string;
  };
}

/**
 * Fetch a URL through FlareSolverr to bypass Cloudflare
 */
export async function fetchWithFlaresolverr(url: string): Promise<{
  html: string;
  status: number;
  cookies: Array<{ name: string; value: string }>;
} | null> {
  const endpoint = config.flareSolverr.url;
  
  if (!endpoint) {
    console.warn('[FlareSolverr] No endpoint configured');
    return null;
  }
  
  try {
    console.log(`[FlareSolverr] Fetching: ${url}`);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cmd: 'request.get',
        url: url,
        maxTimeout: config.flareSolverr.timeout,
      }),
    });
    
    if (!response.ok) {
      console.error(`[FlareSolverr] HTTP error: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as FlareSolverrResponse;
    
    if (data.status !== 'ok') {
      console.error(`[FlareSolverr] Error: ${data.message}`);
      return null;
    }
    
    console.log(`[FlareSolverr] Success - Status: ${data.solution.status}`);
    
    return {
      html: data.solution.response,
      status: data.solution.status,
      cookies: data.solution.cookies.map(c => ({
        name: c.name,
        value: c.value,
      })),
    };
  } catch (error) {
    console.error('[FlareSolverr] Request failed:', error);
    return null;
  }
}

/**
 * Check if FlareSolverr is available
 */
export async function checkFlareSolverr(): Promise<boolean> {
  const endpoint = config.flareSolverr.url;
  
  if (!endpoint) {
    return false;
  }
  
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cmd: 'sessions.list',
      }),
    });
    
    return response.ok;
  } catch {
    return false;
  }
}
