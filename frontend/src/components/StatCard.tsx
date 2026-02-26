interface Props {
  label: string;
  value: string | number;
  subtitle?: string;
  color?: 'default' | 'green' | 'yellow' | 'red' | 'nacho';
}

const colorMap = {
  default: 'text-white',
  green: 'text-green-400',
  yellow: 'text-yellow-400',
  red: 'text-red-400',
  nacho: 'text-nacho-400',
};

export default function StatCard({ label, value, subtitle, color = 'default' }: Props) {
  return (
    <div className="card">
      <div className="card-header">{label}</div>
      <div className={`card-value ${colorMap[color]}`}>{value}</div>
      {subtitle && <div className="text-xs text-gray-500 mt-1">{subtitle}</div>}
    </div>
  );
}
