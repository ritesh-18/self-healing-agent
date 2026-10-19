import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./lib/api.js";
import { useFetch } from "./lib/hooks.js";
import { Overview } from "./pages/Overview.js";
import { Runs } from "./pages/Runs.js";
import { RunDetail } from "./pages/RunDetail.js";
import { ResultDetailPage } from "./pages/ResultDetail.js";
import { Reviews } from "./pages/Reviews.js";
import { Scenarios } from "./pages/Scenarios.js";
import { Lessons } from "./pages/Lessons.js";
import { Guardrails } from "./pages/Guardrails.js";

export function App() {
  // Polled so a run started from any tab shows its progress everywhere.
  const { data: status } = useFetch(() => api.runStatus(), [], 3000);

  return (
    <BrowserRouter>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            med.ai
            <small>agent evaluation &amp; review</small>
          </div>
          <nav className="nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/runs">Runs</NavLink>
            <NavLink to="/reviews">Review queue</NavLink>
            <NavLink to="/scenarios">Scenarios</NavLink>
            <NavLink to="/lessons">Lessons</NavLink>
            <NavLink to="/guardrails">Guardrails</NavLink>
          </nav>
          {status?.active && (
            <div style={{ padding: "14px 18px", fontSize: 12 }}>
              <span className="pill info">running</span>
              <div className="muted" style={{ marginTop: 6 }}>{status.phase}</div>
            </div>
          )}
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/results/:id" element={<ResultDetailPage />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/scenarios" element={<Scenarios />} />
            <Route path="/lessons" element={<Lessons />} />
            <Route path="/guardrails" element={<Guardrails />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
