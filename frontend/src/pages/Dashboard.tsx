import { api } from '../api';
import { useFetch, useCountdown } from '../hooks/useFetch';
import StatCard from '../components/StatCard';
import QuotaGauge from '../components/QuotaGauge';
import CircuitBreakerCard from '../components/CircuitBreakerCard';
import GenreChart from '../components/GenreChart';
import ProgressBar from '../components/ProgressBar';
import EnrichmentControls from '../components/EnrichmentControls';

const POLL_INTERVAL = 30_000; // 30 seconds

export default function Dashboard() {
  const { data: stats, loading: statsLoading } = useFetch(() => api.stats(), [], POLL_INTERVAL);
  const { data: descStats, loading: descLoading } = useFetch(() => api.descriptionStats(), [], POLL_INTERVAL);
  const { data: quotas } = useFetch(() => api.quotas(), [], POLL_INTERVAL);
  const { data: health } = useFetch(() => api.health(), [], POLL_INTERVAL);

  const resetCountdown = useCountdown(quotas?.resetInSeconds ?? 0);

  const uptimeDisplay = health
    ? (() => {
        const s = health.uptime;
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
      })()
    : '—';

  if (statsLoading || descLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400 animate-pulse">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${health?.status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm text-gray-400">
            Uptime: {uptimeDisplay}
          </span>
        </div>
      </div>

      {/* Top Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Series" value={stats?.totalSeries.toLocaleString() ?? '—'} color="nacho" />
        <StatCard label="Total Books" value={stats?.totalBooks.toLocaleString() ?? '—'} />
        <StatCard
          label="Verified Series"
          value={stats?.verifiedSeries.toLocaleString() ?? '—'}
          subtitle={stats ? `${((stats.verifiedSeries / stats.totalSeries) * 100).toFixed(1)}%` : undefined}
          color="green"
        />
        <StatCard
          label="Avg Confidence"
          value={stats ? `${(stats.averageConfidence * 100).toFixed(1)}%` : '—'}
          color={stats && stats.averageConfidence >= 0.8 ? 'green' : 'yellow'}
        />
      </div>

      {/* Enrichment Progress */}
      {descStats && (
        <ProgressBar
          label="Book Description Enrichment"
          current={descStats.withDescription}
          total={descStats.totalBooks}
        />
      )}

      {/* Enrichment Controls */}
      <EnrichmentControls />

      {/* Quotas + Circuit Breaker */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {quotas && (
          <>
            <QuotaGauge
              label="Google Books"
              used={quotas.quotas['google-books']?.used ?? 0}
              limit={quotas.quotas['google-books']?.limit ?? 900}
              exhausted={quotas.quotas['google-books']?.exhausted ?? false}
              resetDisplay={resetCountdown.display}
            />
            <QuotaGauge
              label="iTunes"
              used={quotas.quotas['itunes']?.used ?? 0}
              limit={quotas.quotas['itunes']?.limit ?? 5000}
              exhausted={quotas.quotas['itunes']?.exhausted ?? false}
              resetDisplay={resetCountdown.display}
            />
            <CircuitBreakerCard label="Open Library" status={quotas.circuitBreaker.openLibrary} />
          </>
        )}
      </div>

      {/* Genre Chart */}
      {stats && stats.genreBreakdown && (
        <GenreChart data={stats.genreBreakdown} />
      )}
    </div>
  );
}
