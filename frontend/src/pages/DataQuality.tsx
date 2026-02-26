import { api } from '../api';
import { useFetch } from '../hooks/useFetch';
import StatCard from '../components/StatCard';

const POLL_INTERVAL = 60_000;

export default function DataQuality() {
  const { data: stats, loading } = useFetch(() => api.stats(), [], POLL_INTERVAL);
  const { data: descStats } = useFetch(() => api.descriptionStats(), [], POLL_INTERVAL);

  if (loading) {
    return <div className="text-center py-8 text-gray-400 animate-pulse">Loading data quality metrics...</div>;
  }

  const totalSeries = stats?.totalSeries ?? 0;
  const verifiedSeries = stats?.verifiedSeries ?? 0;
  const unverifiedSeries = totalSeries - verifiedSeries;
  const avgConfidence = stats?.averageConfidence ?? 0;

  const totalBooks = descStats?.totalBooks ?? 0;
  const withDesc = descStats?.withDescription ?? 0;
  const withoutDesc = descStats?.withoutDescription ?? 0;

  // Genre breakdown - find untagged
  const genreBreakdown = stats?.genreBreakdown ?? {};
  const untaggedCount = genreBreakdown[''] ?? genreBreakdown['null'] ?? 0;
  const taggedGenres = Object.entries(genreBreakdown).filter(
    ([g]) => g && g !== 'null' && g !== ''
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Data Quality</h1>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Unverified Series"
          value={unverifiedSeries.toLocaleString()}
          subtitle={`${((unverifiedSeries / totalSeries) * 100).toFixed(1)}% of total`}
          color={unverifiedSeries > totalSeries * 0.5 ? 'red' : 'yellow'}
        />
        <StatCard
          label="Avg Confidence"
          value={`${(avgConfidence * 100).toFixed(1)}%`}
          color={avgConfidence >= 0.8 ? 'green' : avgConfidence >= 0.6 ? 'yellow' : 'red'}
        />
        <StatCard
          label="Books Without Desc"
          value={withoutDesc.toLocaleString()}
          subtitle={`${((withoutDesc / totalBooks) * 100).toFixed(1)}% of total`}
          color={withoutDesc > totalBooks * 0.5 ? 'red' : 'yellow'}
        />
        <StatCard
          label="Untagged Series"
          value={untaggedCount.toLocaleString()}
          subtitle={untaggedCount > 0 ? 'Need genre assignment' : 'All tagged!'}
          color={untaggedCount > 0 ? 'yellow' : 'green'}
        />
      </div>

      {/* Confidence Distribution (simplified) */}
      <div className="card">
        <div className="card-header">Quality Breakdown</div>
        <div className="space-y-4 mt-2">

          {/* Verification Status */}
          <div>
            <div className="text-sm text-gray-300 mb-2">Series Verification</div>
            <div className="flex h-6 rounded-full overflow-hidden bg-gray-800">
              <div
                className="bg-green-600 transition-all duration-500"
                style={{ width: `${(verifiedSeries / totalSeries) * 100}%` }}
                title={`${verifiedSeries} verified`}
              />
              <div
                className="bg-yellow-600 transition-all duration-500"
                style={{ width: `${(unverifiedSeries / totalSeries) * 100}%` }}
                title={`${unverifiedSeries} unverified`}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span className="text-green-400">{verifiedSeries.toLocaleString()} verified</span>
              <span className="text-yellow-400">{unverifiedSeries.toLocaleString()} unverified</span>
            </div>
          </div>

          {/* Description Coverage */}
          <div>
            <div className="text-sm text-gray-300 mb-2">Book Description Coverage</div>
            <div className="flex h-6 rounded-full overflow-hidden bg-gray-800">
              <div
                className="bg-nacho-600 transition-all duration-500"
                style={{ width: `${(withDesc / totalBooks) * 100}%` }}
                title={`${withDesc} with description`}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span className="text-nacho-400">{withDesc.toLocaleString()} with desc ({descStats?.percentage.toFixed(1)}%)</span>
              <span>{withoutDesc.toLocaleString()} without</span>
            </div>
          </div>
        </div>
      </div>

      {/* Genre Coverage */}
      <div className="card">
        <div className="card-header">Genre Coverage</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          {taggedGenres
            .sort(([, a], [, b]) => b - a)
            .map(([genre, count]) => (
              <div key={genre} className="flex items-center justify-between p-2 rounded-lg bg-gray-800/50">
                <span className="text-gray-300">{genre}</span>
                <span className="text-sm text-gray-400">{count.toLocaleString()} series</span>
              </div>
            ))}
          {untaggedCount > 0 && (
            <div className="flex items-center justify-between p-2 rounded-lg bg-red-900/20 border border-red-800/50">
              <span className="text-red-400">untagged</span>
              <span className="text-sm text-red-400">{untaggedCount.toLocaleString()} series</span>
            </div>
          )}
        </div>
      </div>

      {/* TODO: Future sections */}
      <div className="card border-dashed">
        <div className="text-center text-gray-500 py-4">
          <p className="text-sm">Future: Duplicate detection, orphan books, stale data, discrepancy queue</p>
        </div>
      </div>
    </div>
  );
}
