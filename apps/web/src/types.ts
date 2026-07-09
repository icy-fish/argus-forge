export type TimeRangeKey = "24h" | "7d" | "30d" | "all";

export function timeRangeToQuery(range: TimeRangeKey) {
  if (range === "all") return {};
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return { from: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString() };
}

export function formatNumber(value: number | null | undefined) {
  if (value == null) return "-";
  return new Intl.NumberFormat().format(value);
}

export function formatCurrency(value: number | null | undefined) {
  if (value == null) return "unknown";
  return `$${value.toFixed(4)}`;
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
