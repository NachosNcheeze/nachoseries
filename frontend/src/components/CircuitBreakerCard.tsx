import type { CircuitBreakerStatus } from '../api';

interface Props {
  label: string;
  status: CircuitBreakerStatus;
}

const stateConfig = {
  CLOSED: { color: 'text-green-400', bg: 'bg-green-500', label: 'Healthy' },
  OPEN: { color: 'text-red-400', bg: 'bg-red-500', label: 'Open (Blocked)' },
  HALF_OPEN: { color: 'text-yellow-400', bg: 'bg-yellow-500', label: 'Testing...' },
};

export default function CircuitBreakerCard({ label, status }: Props) {
  const config = stateConfig[status.state];

  return (
    <div className="card">
      <div className="card-header">{label}</div>
      <div className="flex items-center gap-3 mt-1">
        <div className={`w-3 h-3 rounded-full ${config.bg} ${status.state !== 'CLOSED' ? 'animate-pulse' : ''}`} />
        <span className={`text-lg font-semibold ${config.color}`}>{config.label}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
        <span>Failures:</span>
        <span className="text-gray-300">{status.consecutiveFailures}</span>
        <span>Total trips:</span>
        <span className="text-gray-300">{status.totalTrips}</span>
        {status.state === 'OPEN' && status.cooldownRemainingMs > 0 && (
          <>
            <span>Cooldown:</span>
            <span className="text-yellow-400">{Math.ceil(status.cooldownRemainingMs / 1000)}s</span>
          </>
        )}
      </div>
    </div>
  );
}
