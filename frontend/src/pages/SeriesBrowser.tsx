import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Series } from '../api';
import { useFetch } from '../hooks/useFetch';

const GENRES = ['all', 'fantasy', 'science-fiction', 'litrpg', 'post-apocalyptic'];
const PAGE_SIZE = 50;

export default function SeriesBrowser() {
  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState('all');
  const [offset, setOffset] = useState(0);
  const [searchResults, setSearchResults] = useState<Series[] | null>(null);
  const [searching, setSearching] = useState(false);

  const { data, loading } = useFetch(
    () => api.listSeries(PAGE_SIZE, offset, genre === 'all' ? undefined : genre),
    [offset, genre],
  );

  const handleSearch = async () => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const result = await api.searchSeries(search, 50);
      setSearchResults(result.results);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const clearSearch = () => {
    setSearch('');
    setSearchResults(null);
  };

  const displaySeries = searchResults ?? data?.series ?? [];
  const total = searchResults ? searchResults.length : data?.total ?? 0;

  const confidenceColor = (c: number | null) => {
    if (c === null) return 'text-gray-500';
    if (c >= 0.9) return 'text-green-400';
    if (c >= 0.7) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Series</h1>
        <span className="text-sm text-gray-400">{total.toLocaleString()} total</span>
      </div>

      {/* Search + Genre Filter */}
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search series by name..."
            className="input w-full"
          />
        </div>
        <button onClick={handleSearch} className="btn-primary" disabled={searching}>
          {searching ? 'Searching...' : 'Search'}
        </button>
        {searchResults && (
          <button onClick={clearSearch} className="btn-secondary">Clear</button>
        )}
        <select
          value={genre}
          onChange={(e) => { setGenre(e.target.value); setOffset(0); setSearchResults(null); }}
          className="input"
        >
          {GENRES.map((g) => (
            <option key={g} value={g}>{g === 'all' ? 'All Genres' : g}</option>
          ))}
        </select>
      </div>

      {/* Series Table */}
      {loading ? (
        <div className="text-center py-8 text-gray-400 animate-pulse">Loading series...</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="table-header">Name</th>
                <th className="table-header w-28">Genre</th>
                <th className="table-header w-20 text-center">Books</th>
                <th className="table-header w-24 text-center">Confidence</th>
                <th className="table-header w-20 text-center">Verified</th>
                <th className="table-header w-24">Years</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {displaySeries.map((s) => (
                <tr key={s.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="table-cell">
                    <Link to={`/series/${s.id}`} className="text-nacho-400 hover:text-nacho-300 font-medium">
                      {s.name}
                    </Link>
                    {s.author && <div className="text-xs text-gray-500">{s.author}</div>}
                    {s.parent_series_name && (
                      <div className="text-xs text-gray-500">↳ sub-series of {s.parent_series_name}</div>
                    )}
                  </td>
                  <td className="table-cell">
                    {s.genre ? (
                      <span className="badge-gray">{s.genre}</span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="table-cell text-center">{s.total_books || '—'}</td>
                  <td className="table-cell text-center">
                    <span className={confidenceColor(s.confidence)}>
                      {s.confidence !== null ? `${(s.confidence * 100).toFixed(0)}%` : '—'}
                    </span>
                  </td>
                  <td className="table-cell text-center">
                    {s.verified ? <span className="text-green-400">✓</span> : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="table-cell text-xs text-gray-400">
                    {s.year_start && s.year_end ? `${s.year_start}–${s.year_end}` : s.year_start || '—'}
                  </td>
                </tr>
              ))}
              {displaySeries.length === 0 && (
                <tr>
                  <td colSpan={6} className="table-cell text-center text-gray-500 py-8">
                    No series found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination (only for list, not search results) */}
      {!searchResults && data && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="btn-secondary btn-sm"
          >
            ← Previous
          </button>
          <span className="text-sm text-gray-400">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= data.total}
            className="btn-secondary btn-sm"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
