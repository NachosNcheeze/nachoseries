interface Props {
  label: string;
  current: number;
  total: number;
  color?: string;
}

export default function ProgressBar({ label, current, total, color = 'bg-nacho-500' }: Props) {
  const percent = total > 0 ? (current / total) * 100 : 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="card-header mb-0">{label}</span>
        <span className="text-sm font-semibold text-nacho-400">{percent.toFixed(1)}%</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-4">
        <div
          className={`h-4 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-400 mt-1">
        <span>{current.toLocaleString()} enriched</span>
        <span>{total.toLocaleString()} total</span>
      </div>
    </div>
  );
}
