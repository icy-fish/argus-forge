import { AlertTriangle, ArrowLeft, Clock, DollarSign, Hammer, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ToolMetricsItem, TraceSpan } from "@argus-forge/shared";
import { useSession, useSessionMetrics, useSessionTimeline } from "../api/queries";
import MetricCard from "../components/MetricCard";
import ToolUsageChart from "../components/charts/ToolUsageChart";
import TraceTimeline from "../components/TraceTimeline";
import { formatCurrency, formatDuration, formatNumber } from "../types";

function flattenSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((span) => [span, ...flattenSpans(span.children)]);
}

function toToolMetrics(spans: TraceSpan[]): ToolMetricsItem[] {
  const groups = new Map<string, { toolName: string; count: number; errorCount: number; latencies: number[] }>();
  for (const span of flattenSpans(spans)) {
    if (span.type !== "tool" || !span.toolName) continue;
    const group = groups.get(span.toolName) ?? { toolName: span.toolName, count: 0, errorCount: 0, latencies: [] };
    group.count += 1;
    if (span.status === "failed") group.errorCount += 1;
    if (span.durationMs != null) group.latencies.push(span.durationMs);
    groups.set(span.toolName, group);
  }

  return [...groups.values()]
    .map((group) => ({
      toolName: group.toolName,
      count: group.count,
      errorCount: group.errorCount,
      averageLatencyMs: group.latencies.length
        ? Math.round(group.latencies.reduce((sum, latency) => sum + latency, 0) / group.latencies.length)
        : null
    }))
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName));
}

export default function SessionDetailPage() {
  const { sessionId } = useParams();
  const session = useSession(sessionId);
  const metrics = useSessionMetrics(sessionId);
  const timeline = useSessionTimeline(sessionId);
  const [selected, setSelected] = useState<TraceSpan | null>(null);
  const selectedSpan = selected ?? timeline.data?.data.spans[0] ?? null;
  const totals = metrics.data?.data;
  const rawEvents = useMemo(() => selectedSpan?.events ?? timeline.data?.data.events ?? [], [selectedSpan, timeline.data?.data.events]);
  const toolMetrics = useMemo(() => toToolMetrics(timeline.data?.data.spans ?? []), [timeline.data?.data.spans]);

  return (
    <section>
      <Link className="back-link" to="/sessions">
        <ArrowLeft size={16} /> Sessions
      </Link>
      <div className="page-header">
        <div>
          <h1>{session.data?.data.title ?? sessionId}</h1>
          <p>{session.data?.data.agentName ?? "Agent session"} · {session.data?.data.status ?? "loading"}</p>
        </div>
      </div>

      {session.isError || metrics.isError || timeline.isError ? <div className="error-state">Could not load the session detail.</div> : null}

      <div className="metric-grid">
        <MetricCard icon={Zap} label="Tokens" value={formatNumber(totals?.totalTokens)} detail={`${formatNumber(totals?.llmRequests)} requests`} />
        <MetricCard icon={Hammer} label="Tool Calls" value={formatNumber(totals?.toolCalls)} />
        <MetricCard icon={DollarSign} label="Estimated Cost" value={formatCurrency(totals?.estimatedCostUsd)} />
        <MetricCard icon={Clock} label="P95 Latency" value={formatDuration(totals?.p95LatencyMs)} />
        <MetricCard icon={AlertTriangle} label="Errors" value={formatNumber(totals?.errorCount)} detail={`${(((totals?.errorRate ?? 0) * 100)).toFixed(1)}%`} />
      </div>

      <section className="panel session-tool-panel">
        <h2>Tool Calls by Tool</h2>
        <ToolUsageChart data={toolMetrics} />
        {toolMetrics.length ? (
          <div className="tool-stats-table">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                  <th>Errors</th>
                  <th>Average Latency</th>
                </tr>
              </thead>
              <tbody>
                {toolMetrics.map((tool) => (
                  <tr key={tool.toolName}>
                    <td>{tool.toolName}</td>
                    <td>{formatNumber(tool.count)}</td>
                    <td>{formatNumber(tool.errorCount)}</td>
                    <td>{formatDuration(tool.averageLatencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="detail-grid">
        <section className="panel">
          <h2>Trace Timeline</h2>
          <TraceTimeline spans={timeline.data?.data.spans ?? []} onSelect={setSelected} />
        </section>
        <section className="panel detail-panel">
          <h2>Selected Span</h2>
          {selectedSpan ? (
            <>
              <dl className="detail-list">
                <dt>Name</dt><dd>{selectedSpan.name}</dd>
                <dt>Status</dt><dd>{selectedSpan.status}</dd>
                <dt>Duration</dt><dd>{formatDuration(selectedSpan.durationMs)}</dd>
                <dt>Events</dt><dd>{selectedSpan.events.length}</dd>
              </dl>
              <pre>{JSON.stringify(rawEvents.map((item) => item.raw), null, 2)}</pre>
            </>
          ) : (
            <div className="empty-state">Select a timeline item to inspect its raw event payload.</div>
          )}
        </section>
      </div>
    </section>
  );
}
