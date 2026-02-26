import { useState } from 'react';
import { api, type Book } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Link } from 'react-router-dom';

const GENRES = ['fantasy', 'science-fiction', 'litrpg', 'post-apocalyptic'];
const PAGE_SIZE = 50;

export default function BookBrowser() {
  const [genre, setGenre] = useState(GENRES[0]);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Book[] | null>(null);
  const [searching, setSearching] = useState(false);

  const { data, loading } = useFetch(
    () => api.booksByGenre(genre, PAGE_SIZE, offset),
    [genre, offset],
  );

  const handleSearch = async () => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const result = await api.unifiedSearch(search, 50);
      setSearchResults(result.bookMatches);
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

  const displayBooks = searchResults ?? data?.books ?? [];
  const total = searchResults ? searchResults.length : data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Books</h1>
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
            placeholder="Search books by title..."
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
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>

      {/* Books Table */}
      {loading ? (
        <div className="text-center py-8 text-gray-400 animate-pulse">Loading books...</div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="table-header">Title</th>
                <th className="table-header w-40">Series</th>
                <th className="table-header w-28">Author</th>
                <th className="table-header w-16 text-center">Year</th>
                <th className="table-header w-20 text-center">Desc</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {displayBooks.map((b) => (
                <tr key={b.id} className="hover:bg-gray-800/30 transition-colors">
                  <td className="table-cell">
                    <span className="text-gray-200">{b.title}</span>
                    {b.position !== null && (
                      <span className="text-gray-500 text-xs ml-2">#{b.position}</span>
                    )}
                  </td>
                  <td className="table-cell">
                    {b.series_name ? (
                      <Link to={`/series/${b.series_id}`} className="text-nacho-400 hover:text-nacho-300 text-sm">
                        {b.series_name}
                      </Link>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="table-cell text-sm text-gray-400">{b.author || '—'}</td>
                  <td className="table-cell text-center text-sm text-gray-400">{b.year_published || '—'}</td>
                  <td className="table-cell text-center">
                    {b.description ? (
                      <span className="text-green-400" title="Has description">✓</span>
                    ) : b.description_checked_at ? (
                      <span className="text-yellow-400" title="Checked, no result">⬜</span>
                    ) : (
                      <span className="text-gray-600" title="Not checked">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {displayBooks.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-cell text-center text-gray-500 py-8">No books found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
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
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!data.hasMore}
            className="btn-secondary btn-sm"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
