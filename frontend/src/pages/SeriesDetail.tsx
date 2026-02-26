import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useFetch } from '../hooks/useFetch';

export default function SeriesDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: series, loading, error } = useFetch(() => api.getSeries(id!), [id]);

  if (loading) {
    return <div className="text-center py-8 text-gray-400 animate-pulse">Loading series...</div>;
  }

  if (error || !series) {
    return (
      <div className="text-center py-8">
        <p className="text-red-400 mb-4">{error || 'Series not found'}</p>
        <Link to="/series" className="btn-secondary btn-sm">← Back to Series</Link>
      </div>
    );
  }

  const confidenceColor = series.confidence !== null
    ? series.confidence >= 0.9 ? 'text-green-400' : series.confidence >= 0.7 ? 'text-yellow-400' : 'text-red-400'
    : 'text-gray-500';

  return (
    <div className="space-y-6">
      {/* Back Link */}
      <Link to="/series" className="text-sm text-gray-400 hover:text-gray-300">← Back to Series</Link>

      {/* Series Header */}
      <div className="card">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{series.name}</h1>
            {series.author && <p className="text-gray-400 mt-1">{series.author}</p>}
            {series.parent && (
              <p className="text-sm text-gray-500 mt-1">
                Sub-series of{' '}
                <Link to={`/series/${series.parent.id}`} className="text-nacho-400 hover:text-nacho-300">
                  {series.parent.name}
                </Link>
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {series.genre && <span className="badge-gray">{series.genre}</span>}
            {series.verified ? <span className="badge-green">Verified</span> : <span className="badge-yellow">Unverified</span>}
            <span className={`text-sm font-medium ${confidenceColor}`}>
              {series.confidence !== null ? `${(series.confidence * 100).toFixed(0)}% confidence` : 'No confidence'}
            </span>
          </div>
        </div>

        {series.description && (
          <p className="text-gray-300 mt-4 leading-relaxed">{series.description}</p>
        )}

        <div className="flex items-center gap-6 mt-4 text-sm text-gray-400">
          {series.year_start && (
            <span>{series.year_start}{series.year_end ? `–${series.year_end}` : '–ongoing'}</span>
          )}
          <span>{series.total_books} books</span>
          <span>{series.books?.filter(b => b.description).length ?? 0} with descriptions</span>
        </div>
      </div>

      {/* Sub-series */}
      {series.children && series.children.length > 0 && (
        <div className="card">
          <div className="card-header">Sub-Series ({series.children.length})</div>
          <div className="space-y-2">
            {series.children.map((child) => (
              <Link
                key={child.id}
                to={`/series/${child.id}`}
                className="block p-3 rounded-lg bg-gray-800/50 hover:bg-gray-800 transition-colors"
              >
                <span className="text-nacho-400 font-medium">{child.name}</span>
                <span className="text-gray-500 text-sm ml-3">{child.total_books} books</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Siblings */}
      {series.siblings && series.siblings.length > 0 && (
        <div className="card">
          <div className="card-header">Related Series ({series.siblings.length})</div>
          <div className="flex flex-wrap gap-2">
            {series.siblings.map((sib) => (
              <Link
                key={sib.id}
                to={`/series/${sib.id}`}
                className="badge-gray hover:bg-gray-700 transition-colors"
              >
                {sib.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Books Table */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <span className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Books ({series.books?.length ?? 0})
          </span>
        </div>
        <table className="w-full">
          <thead className="bg-gray-800/50">
            <tr>
              <th className="table-header w-16">#</th>
              <th className="table-header">Title</th>
              <th className="table-header w-32">Author</th>
              <th className="table-header w-16 text-center">Year</th>
              <th className="table-header w-20 text-center">Desc</th>
              <th className="table-header w-24">ISBN</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {series.books?.sort((a, b) => (a.position ?? 999) - (b.position ?? 999)).map((book) => (
              <tr key={book.id} className="hover:bg-gray-800/30 transition-colors">
                <td className="table-cell text-gray-500 text-center">
                  {book.position !== null ? book.position : '—'}
                </td>
                <td className="table-cell">
                  <span className="text-gray-200">{book.title}</span>
                  {book.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{book.description}</p>
                  )}
                </td>
                <td className="table-cell text-gray-400 text-sm">{book.author || '—'}</td>
                <td className="table-cell text-center text-gray-400 text-sm">{book.year_published || '—'}</td>
                <td className="table-cell text-center">
                  {book.description ? (
                    <span className="text-green-400">✓</span>
                  ) : book.description_checked_at ? (
                    <span className="text-yellow-400" title={`Checked ${book.description_checked_at}`}>⬜</span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                <td className="table-cell text-xs text-gray-500 font-mono">{book.isbn || '—'}</td>
              </tr>
            ))}
            {(!series.books || series.books.length === 0) && (
              <tr>
                <td colSpan={6} className="table-cell text-center text-gray-500 py-8">No books</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
