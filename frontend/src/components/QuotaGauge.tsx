interface Props {
  label: string;
  used: number;
  limit: number;
  exhausted: boolean;
  resetDisplay?: string;
}

export default function QuotaGauge({ label, used, limit, exhausted, resetDisplay }: Props) {
  const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const remaining = limit - used;

  let barColor = 'bg-green-500';
  if (percent > 80) barColor = 'bg-yellow-500';
  if (exhausted) barColor = 'bg-red-500';

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="card-header mb-0">{label}</span>
        {exhausted && <span className="badge-red">Exhausted</span>}
      </div>
      <div className="w-full bg-gray-800 rounded-full h-3 mb-2">
        <div
          className={`h-3 rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-400">
        <span>{used.toLocaleString()} / {limit.toLocaleString()} used</span>
        <span>{remaining.toLocaleString()} remaining</span>
      </div>
      {resetDisplay && (
        <div className="text-xs text-gray-500 mt-1">Resets in {resetDisplay}</div>
      )}
    </div>
  );
}
