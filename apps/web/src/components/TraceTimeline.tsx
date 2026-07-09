import { AlertTriangle, Bot, CheckCircle2, Hammer, Loader2 } from "lucide-react";
import type { TraceSpan } from "@argus-forge/shared";
import { formatCurrency, formatDuration, formatNumber } from "../types";

function StatusIcon({ status }: { status: TraceSpan["status"] }) {
  if (status === "failed") return <AlertTriangle className="status failed" size={18} />;
  if (status === "completed") return <CheckCircle2 className="status completed" size={18} />;
  return <Loader2 className="status running" size={18} />;
}

function SpanRow({ span, onSelect }: { span: TraceSpan; onSelect: (span: TraceSpan) => void }) {
  const isTool = span.type === "tool";
  return (
    <li>
      <button className="span-row" onClick={() => onSelect(span)}>
        <span className="span-kind">{isTool ? <Hammer size={16} /> : <Bot size={16} />}</span>
        <span className="span-main">
          <span className="span-name">{span.name}</span>
          <span className="span-meta">
            {formatDuration(span.durationMs)}
            {span.totalTokens ? ` · ${formatNumber(span.totalTokens)} tok` : ""}
            {span.estimatedCostUsd != null ? ` · ${formatCurrency(span.estimatedCostUsd)}` : ""}
            {span.errorMessage ? ` · ${span.errorMessage}` : ""}
          </span>
        </span>
        <StatusIcon status={span.status} />
      </button>
      {span.children.length ? (
        <ol className="span-children">
          {span.children.map((child) => (
            <SpanRow key={child.id} span={child} onSelect={onSelect} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export default function TraceTimeline({ spans, onSelect }: { spans: TraceSpan[]; onSelect: (span: TraceSpan) => void }) {
  if (!spans.length) return <div className="empty-state">No trace spans have been recorded for this session.</div>;
  return (
    <ol className="trace-timeline">
      {spans.map((span) => (
        <SpanRow key={span.id} span={span} onSelect={onSelect} />
      ))}
    </ol>
  );
}
