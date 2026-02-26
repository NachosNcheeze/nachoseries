import { useState } from 'react';
import { api } from '../api';
import { useFetch } from '../hooks/useFetch';

const POLL_INTERVAL = 10_000;

export default function EnrichmentControls() {
  const { data: status, refetch } = useFetch(() => api.enrichStatus(), [], POLL_INTERVAL);
  const { data: log } = useFetch(() => api.enrichLog(20), [], POLL_INTERVAL);
  const [mode, setMode] = useState('books-only');
  const [genre, setGenre] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const handleStart = async () => {
    setActionLoading(true);
    try {
      await api.enrichStart(mode, genre || undefined);
      await refetch();
    } catch (err) {
      console.error('Failed to start enrichment:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await api.enrichStop();
      await refetch();
    } catch (err) {
      console.error('Failed to stop enrichment:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const isRunning = status?.running ?? false;

  const sourceColors: Record<string, string> = {
    'open-library': 'text-blue-400',
    'google-books': 'text-yellow-400',
    'itunes': 'text-purple-400',
  };

  const typeIcons: Record<string, string> = {
    enriched: '✅',
    'no-result': '⬜',
    error: '❌',
    skipped: '⏭️',
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="card-header mb-0">Auto-Enrichment</div>
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
          <span className={`text-sm font-medium ${isRunning ? 'text-green-400' : 'text-gray-500'}`}>
            {isRunning ? 'Running' : 'Stopped'}
          </span>
          {status?.mode && (
            <span className="badge-gray ml-2">{status.mode}</span>
          )}
          {status?.genre && (
            <span className="badge-yellow ml-1">{status.genre}</span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-end gap-3 mb-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="input text-sm"
            disabled={isRunning}
          >
            <option value="both">Both (Series + Books)</option>
            <option value="books-only">Books Only</option>
            <option value="series-only">Series Only</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Genre (optional)</label>
          <input
            type="text"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="All genres"
            className="input text-sm w-40"
            disabled={isRunning}
          />
        </div>
        <div className="flex gap-2">
          {!isRunning ? (
            <button onClick={handleStart} disabled={actionLoading} className="btn-primary btn-sm">
              {actionLoading ? 'Starting...' : 'Start'}
            </button>
          ) : (
            <button onClick={handleStop} disabled={actionLoading} className="btn-danger btn-sm">
              {actionLoading ? 'Stopping...' : 'Stop'}
            </button>
          )}
        </div>
      </div>

      {/* Recent Activity Log */}
      {log && log.entries.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Recent Activity</div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {log.entries.map((entry, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-gray-800 last:border-0">
                <span>{typeIcons[entry.type] ?? '❓'}</span>
                <span className="text-gray-500 w-16 flex-shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-gray-200 truncate flex-1">{entry.bookTitle}</span>
                <span className="text-gray-500 truncate max-w-32">{entry.seriesName}</span>
                <span className={`${sourceColors[entry.source] ?? 'text-gray-400'} flex-shrink-0`}>
                  {entry.source}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
