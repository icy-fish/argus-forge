export type TimeRange = { from?: Date; to?: Date; projectId?: string };

export function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

export function durationMs(start: Date, end?: Date | null): number | null {
  if (!end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

export function parseTimeRange(query: Record<string, unknown>): TimeRange {
  const range: TimeRange = {};
  if (typeof query.projectId === "string" && query.projectId) range.projectId = query.projectId;
  if (typeof query.from === "string" && query.from) range.from = parseTimestamp(query.from);
  if (typeof query.to === "string" && query.to) range.to = parseTimestamp(query.to);
  return range;
}

export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}
