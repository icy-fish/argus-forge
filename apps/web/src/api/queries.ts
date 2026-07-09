import { useQuery } from "@tanstack/react-query";
import type {
  LatencyMetricsResponse,
  MetricsSummaryResponse,
  ModelMetricsResponse,
  SessionDetailResponse,
  SessionListResponse,
  SessionMetricsResponse,
  ThroughputResponse,
  TimelineResponse,
  ToolMetricsResponse
} from "@argus-forge/shared";
import { apiGet, type QueryParams } from "./client";

export function useSummary(params: QueryParams) {
  return useQuery({ queryKey: ["summary", params], queryFn: () => apiGet<MetricsSummaryResponse>("/v1/metrics/summary", params) });
}

export function useToolMetrics(params: QueryParams) {
  return useQuery({ queryKey: ["tools", params], queryFn: () => apiGet<ToolMetricsResponse>("/v1/metrics/tools", params) });
}

export function useModelMetrics(params: QueryParams) {
  return useQuery({ queryKey: ["models", params], queryFn: () => apiGet<ModelMetricsResponse>("/v1/metrics/models", params) });
}

export function useLatencyMetrics(params: QueryParams) {
  return useQuery({ queryKey: ["latency", params], queryFn: () => apiGet<LatencyMetricsResponse>("/v1/metrics/latency", params) });
}

export function useThroughput(params: QueryParams) {
  return useQuery({ queryKey: ["throughput", params], queryFn: () => apiGet<ThroughputResponse>("/v1/metrics/throughput", params) });
}

export function useSessions(params: QueryParams) {
  return useQuery({ queryKey: ["sessions", params], queryFn: () => apiGet<SessionListResponse>("/v1/sessions", params) });
}

export function useSession(id: string | undefined) {
  return useQuery({ queryKey: ["session", id], queryFn: () => apiGet<SessionDetailResponse>(`/v1/sessions/${id}`), enabled: Boolean(id) });
}

export function useSessionTimeline(id: string | undefined) {
  return useQuery({ queryKey: ["timeline", id], queryFn: () => apiGet<TimelineResponse>(`/v1/sessions/${id}/timeline`), enabled: Boolean(id) });
}

export function useSessionMetrics(id: string | undefined) {
  return useQuery({ queryKey: ["session-metrics", id], queryFn: () => apiGet<SessionMetricsResponse>(`/v1/sessions/${id}/metrics`), enabled: Boolean(id) });
}
