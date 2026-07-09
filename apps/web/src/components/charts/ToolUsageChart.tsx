import type { ToolMetricsItem } from "@argus-forge/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function ToolUsageChart({ data }: { data: ToolMetricsItem[] }) {
  if (!data.length) return <div className="empty-chart">No tool calls yet</div>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="toolName" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" fill="#2563eb" />
        <Bar dataKey="errorCount" fill="#dc2626" />
      </BarChart>
    </ResponsiveContainer>
  );
}
