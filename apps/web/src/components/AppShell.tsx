import { Activity, BarChart3, ListTree } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { PropsWithChildren } from "react";

export default function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={24} />
          <span>Argus Forge</span>
        </div>
        <nav>
          <NavLink to="/" end>
            <BarChart3 size={18} /> Dashboard
          </NavLink>
          <NavLink to="/sessions">
            <ListTree size={18} /> Sessions
          </NavLink>
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
