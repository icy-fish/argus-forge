import { AlertTriangle, ArrowLeft, Clock, DollarSign, Hammer, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { TraceSpan } from "@argus-forge/shared";
import { useSession, useSessionMetrics, useSessionTimeline } from "../api/queries";
import MetricCard from "../components/MetricCard";
import TraceTimeline from "../components/TraceTimeline";
import { formatCurrency, formatDuration, formatNumber } from "../types";

export default function SessionDetailPage() {
  const { sessionId } = useParams();
  const session = useSession(sessionId);
  const metrics = useSessionMetrics(sessionId);
  const timeline = useSessionTimeline(sessionId);
  const [selected, setSelected] = useState<TraceSpan | null>(null);
  const selectedSpan = selected ?? timeline.data?.data.spans[0] ?? null;
  const totals = metrics.data?.data;
  const rawEvents = useMemo(() => selectedSpan?.events ?? timeline.data?.data.events ?? [], [selectedSpan, timeline.data?.data.events]);

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
