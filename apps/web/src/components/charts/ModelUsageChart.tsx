import type { ModelMetricsItem } from "@argus-forge/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function ModelUsageChart({ data }: { data: ModelMetricsItem[] }) {
  const chartData = data.map((item) => ({ ...item, name: `${item.provider}/${item.model}` }));
  if (!chartData.length) return <div className="empty-chart">No model usage yet</div>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="requestCount" fill="#0f766e" />
        <Bar dataKey="totalTokens" fill="#f59e0b" />
      </BarChart>
    </ResponsiveContainer>
  );
}
