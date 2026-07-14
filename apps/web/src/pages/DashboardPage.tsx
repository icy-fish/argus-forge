import { AlertTriangle, Clock, DollarSign, Gauge, Server, Zap } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import MetricCard from "../components/MetricCard";
import LatencyChart from "../components/charts/LatencyChart";
import ModelUsageChart from "../components/charts/ModelUsageChart";
import ThroughputChart from "../components/charts/ThroughputChart";
import ToolUsageChart from "../components/charts/ToolUsageChart";
import { useLatencyMetrics, useModelMetrics, useSummary, useThroughput, useToolMetrics } from "../api/queries";
import { formatCurrency, formatDuration, formatNumber, timeRangeToQuery, type TimeRangeKey } from "../types";

const DASHBOARD_REFRESH_ROUNDS = 5;
const DASHBOARD_REFRESH_BASE_MS = 10_000;
const DASHBOARD_REFRESH_JITTER_MS = 3_000;

function getDashboardRefreshDelayMs() {
  const jitter = Math.random() * DASHBOARD_REFRESH_JITTER_MS * 2 - DASHBOARD_REFRESH_JITTER_MS;
  return DASHBOARD_REFRESH_BASE_MS + jitter;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<TimeRangeKey>("24h");
  const params = useMemo(() => timeRangeToQuery(range), [range]);
  const summary = useSummary(params);
  const tools = useToolMetrics(params);
  const models = useModelMetrics(params);
  const latency = useLatencyMetrics(params);
  const throughput = useThroughput(params);
  const totals = summary.data?.data;
  const isEmpty = totals && totals.sessions === 0 && totals.llmRequests === 0 && totals.toolCalls === 0;

  useEffect(() => {
    let isDisposed = false;
    let refreshRound = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleRefresh = () => {
      if (isDisposed || refreshRound >= DASHBOARD_REFRESH_ROUNDS) {
        return;
      }

      timeoutId = setTimeout(() => {
        refreshRound += 1;
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["summary", params], exact: true }),
          queryClient.invalidateQueries({ queryKey: ["tools", params], exact: true }),
          queryClient.invalidateQueries({ queryKey: ["models", params], exact: true }),
          queryClient.invalidateQueries({ queryKey: ["latency", params], exact: true }),
          queryClient.invalidateQueries({ queryKey: ["throughput", params], exact: true })
        ]).finally(scheduleRefresh);
      }, getDashboardRefreshDelayMs());
    };

    scheduleRefresh();

    return () => {
      isDisposed = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [params, queryClient]);

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Operational Dashboard</h1>
          <p>LLM requests, tool calls, latency, cost, and throughput across local agent sessions.</p>
        </div>
        <select value={range} onChange={(event) => setRange(event.target.value as TimeRangeKey)}>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7d</option>
          <option value="30d">Last 30d</option>
          <option value="all">All time</option>
        </select>
      </div>

      {summary.isError ? <div className="error-state">Could not load metrics. Confirm the API is running.</div> : null}
      {isEmpty ? <div className="empty-state">No events found. Run the seed command or post events to the ingestion endpoint.</div> : null}

      <div className="metric-grid">
        <MetricCard icon={Server} label="Sessions" value={formatNumber(totals?.sessions)} detail={`${formatNumber(totals?.llmRequests)} LLM requests`} />
        <MetricCard icon={Zap} label="Tokens" value={formatNumber(totals?.totalTokens)} detail={`${formatNumber(totals?.completionTokens)} generated`} />
        <MetricCard icon={DollarSign} label="Estimated Cost" value={formatCurrency(totals?.estimatedCostUsd)} />
        <MetricCard icon={Clock} label="P95 Latency" value={formatDuration(totals?.p95LatencyMs)} detail={`avg ${formatDuration(totals?.averageLatencyMs)}`} />
        <MetricCard icon={Gauge} label="Throughput" value={`${totals?.throughputPerMinute ?? 0}/min`} />
        <MetricCard icon={AlertTriangle} label="Error Rate" value={`${(((totals?.errorRate ?? 0) * 100)).toFixed(1)}%`} detail={`${formatNumber(totals?.errorCount)} errors`} />
      </div>

      <div className="chart-grid">
        <section className="panel">
          <h2>Tool Usage</h2>
          <ToolUsageChart data={tools.data?.data ?? []} />
        </section>
        <section className="panel">
          <h2>Model Usage</h2>
          <ModelUsageChart data={models.data?.data ?? []} />
        </section>
        <section className="panel">
          <h2>Latency</h2>
          <LatencyChart data={latency.data?.data.buckets ?? []} />
        </section>
        <section className="panel">
          <h2>Throughput</h2>
          <ThroughputChart data={throughput.data?.data ?? []} />
        </section>
      </div>
    </section>
  );
}
