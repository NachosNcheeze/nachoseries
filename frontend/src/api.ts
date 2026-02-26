const BASE = '/api';

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// === Types ===

export interface Stats {
  totalSeries: number;
  totalBooks: number;
  verifiedSeries: number;
  averageConfidence: number;
  genreBreakdown: Record<string, number>;
}

export interface DescriptionStats {
  totalBooks: number;
  withDescription: number;
  withoutDescription: number;
  percentage: number;
}

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

export interface CircuitBreakerStatus {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  cooldownMs: number;
  cooldownRemainingMs: number;
  totalTrips: number;
}

export interface QuotasResponse {
  quotas: Record<string, QuotaInfo>;
  resetInSeconds: number;
  circuitBreaker: {
    openLibrary: CircuitBreakerStatus;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  uptime: number;
  startedAt: string;
  database: Record<string, unknown>;
}

export interface Series {
  id: string;
  name: string;
  author: string | null;
  genre: string | null;
  total_books: number;
  year_start: number | null;
  year_end: number | null;
  description: string | null;
  confidence: number | null;
  verified: number;
  parent_series_id: string | null;
  parent_series_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeriesWithBooks extends Series {
  books: Book[];
  children?: Series[];
  parent?: Series | null;
  siblings?: Series[];
}

export interface Book {
  id: string;
  series_id: string;
  position: number | null;
  title: string;
  author: string | null;
  year_published: number | null;
  description: string | null;
  description_checked_at: string | null;
  isbn: string | null;
  openlibrary_key: string | null;
  confidence: number | null;
  series_name?: string;
  series_genre?: string;
}

export interface EnrichmentStatus {
  running: boolean;
  mode: string | null;
  genre: string | null;
  pid: number | null;
}

export interface EnrichmentLogEntry {
  timestamp: string;
  bookTitle: string;
  seriesName: string;
  source: string;
  type: 'enriched' | 'no-result' | 'error' | 'skipped';
}

// === API Functions ===

export const api = {
  // Health & Stats
  health: () => fetchJSON<HealthResponse>('/health'),
  stats: () => fetchJSON<Stats>('/stats'),
  descriptionStats: () => fetchJSON<DescriptionStats>('/books/description-stats'),
  quotas: () => fetchJSON<QuotasResponse>('/quotas'),

  // Auto-enrich controls
  enrichStatus: () => fetchJSON<EnrichmentStatus>('/enrich/status'),
  enrichStart: (mode?: string, genre?: string) => {
    const params = new URLSearchParams();
    if (mode) params.set('mode', mode);
    if (genre) params.set('genre', genre);
    return fetchJSON<{ success: boolean }>(`/enrich/start?${params}`, { method: 'POST' });
  },
  enrichStop: () => fetchJSON<{ success: boolean }>('/enrich/stop', { method: 'POST' }),
  enrichLog: (limit = 50) => fetchJSON<{ entries: EnrichmentLogEntry[] }>(`/enrich/log?limit=${limit}`),

  // Series
  searchSeries: (q: string, limit = 20) =>
    fetchJSON<{ results: Series[]; count: number }>(`/series/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  
  listSeries: (limit = 50, offset = 0, genre?: string) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (genre) params.set('genre', genre);
    return fetchJSON<{ series: Series[]; count: number; total: number; offset: number; limit: number }>(
      `/series?${params}`
    );
  },

  getSeries: (id: string) => fetchJSON<SeriesWithBooks>(`/series/${id}`),

  unifiedSearch: (q: string, limit = 20) =>
    fetchJSON<{ seriesMatches: Series[]; bookMatches: Book[]; totalMatches: number }>(
      `/search?q=${encodeURIComponent(q)}&limit=${limit}`
    ),

  // Books
  booksByGenre: (genre: string, limit = 48, offset = 0) =>
    fetchJSON<{ books: Book[]; count: number; total: number; offset: number; limit: number; hasMore: boolean }>(
      `/books/genre?genre=${encodeURIComponent(genre)}&limit=${limit}&offset=${offset}`
    ),
};
