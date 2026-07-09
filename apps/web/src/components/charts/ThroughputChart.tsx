import type { ThroughputPoint } from "@argus-forge/shared";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function ThroughputChart({ data }: { data: ThroughputPoint[] }) {
  const chartData = data.map((item) => ({ ...item, time: new Date(item.bucketStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  if (!chartData.length) return <div className="empty-chart">No throughput samples yet</div>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="time" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Line type="monotone" dataKey="requestCount" stroke="#2563eb" strokeWidth={2} />
        <Line type="monotone" dataKey="generatedTokens" stroke="#ea580c" strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}
