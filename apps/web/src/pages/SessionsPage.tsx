import { Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSessions } from "../api/queries";
import { formatCurrency, formatDuration, formatNumber } from "../types";

export default function SessionsPage() {
  const [search, setSearch] = useState("");
  const sessions = useSessions({ page: 1, pageSize: 50, search });

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Sessions</h1>
          <p>Browse agent runs sorted by most recent activity.</p>
        </div>
        <label className="search-box">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions" />
        </label>
      </div>

      {sessions.isError ? <div className="error-state">Could not load sessions. Confirm the API is running.</div> : null}
      {!sessions.isLoading && !sessions.data?.data.length ? <div className="empty-state">No sessions found. Seed the database or ingest events to populate this table.</div> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>LLM</th>
              <th>Tools</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {(sessions.data?.data ?? []).map((session) => (
              <tr key={session.id}>
                <td>
                  <Link to={`/sessions/${session.id}`}>{session.title ?? session.id}</Link>
                  <div className="muted">{session.agentName}</div>
                </td>
                <td><span className={`pill ${session.status}`}>{session.status}</span></td>
                <td>{new Date(session.startedAt).toLocaleString()}</td>
                <td>{formatDuration(session.durationMs)}</td>
                <td>{formatNumber(session.totalTokens)}</td>
                <td>{formatCurrency(session.estimatedCostUsd)}</td>
                <td>{session.llmRequestCount}</td>
                <td>{session.toolCallCount}</td>
                <td>{session.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
