import type { LucideIcon } from "lucide-react";

export default function MetricCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail?: string; icon: LucideIcon }) {
  return (
    <div className="metric-card">
      <div className="metric-icon">
        <Icon size={18} />
      </div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        {detail ? <div className="metric-detail">{detail}</div> : null}
      </div>
    </div>
  );
}
