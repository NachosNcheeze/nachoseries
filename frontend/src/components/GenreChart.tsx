import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

interface Props {
  data: Record<string, number>;
}

const COLORS = [
  '#eab308', // nacho
  '#3b82f6', // blue
  '#10b981', // green
  '#f43f5e', // rose
  '#a855f7', // purple
  '#f97316', // orange
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#6366f1', // indigo
  '#84cc16', // lime
];

export default function GenreChart({ data }: Props) {
  const chartData = Object.entries(data)
    .map(([name, value]) => ({ name: name || 'untagged', value }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="card">
      <div className="card-header">Genre Distribution</div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((_entry, index) => (
                <Cell key={index} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelStyle={{ color: '#9ca3af' }}
              itemStyle={{ color: '#f3f4f6' }}
              formatter={(value: number) => [value.toLocaleString(), 'Series']}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 gap-1 mt-2">
        {chartData.map((entry, i) => (
          <div key={entry.name} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
            <span className="text-gray-400 truncate">{entry.name}</span>
            <span className="text-gray-300 ml-auto">{entry.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
