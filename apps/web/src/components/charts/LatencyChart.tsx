import type { LatencyBucket } from "@argus-forge/shared";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function LatencyChart({ data }: { data: LatencyBucket[] }) {
  if (!data.some((item) => item.llmRequests || item.toolCalls)) return <div className="empty-chart">No latency samples yet</div>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="label" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="llmRequests" fill="#7c3aed" />
        <Bar dataKey="toolCalls" fill="#16a34a" />
      </BarChart>
    </ResponsiveContainer>
  );
}
