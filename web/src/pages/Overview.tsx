import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useFetch, ms, when } from "../lib/hooks.js";

export function Overview() {
  const { data: health } = useFetch(() => api.health(), []);
  const { data: stats, error } = useFetch(() => api.stats(), [], 5000);
  const { data: history } = useFetch(() => api.history(), [], 10000);

  if (error) return <div className="err">{error}</div>;
  if (!stats) return <p className="muted">Loading…</p>;

  const latest = stats.latestRun;

  return (
    <>
      <h1>Overview</h1>
      <p className="sub mono">{health?.config ?? "…"}</p>

      <div className="cards">
        <div className="card">
          <div className="label">Latest score</div>
          <div className="value">
            {latest ? `${latest.passed}/${latest.total}` : "—"}
          </div>
          {latest && <div className="muted">{when(latest.started_at)}</div>}
        </div>
        <div className="card">
          <div className="label">Pending reviews</div>
          <div className="value" style={{ color: stats.pendingReviews ? "var(--amber)" : undefined }}>
            {stats.pendingReviews}
          </div>
          <Link to="/reviews">Open queue</Link>
        </div>
        <div className="card">
          <div className="label">Active lessons</div>
          <div className="value">{stats.activeLessons}</div>
          <Link to="/lessons">View</Link>
        </div>
        <div className="card">
          <div className="label">Total runs</div>
          <div className="value">{stats.totalRuns}</div>
        </div>
      </div>

      <h2>By dimension</h2>
      <p className="sub">
        Safety and authorisation are listed first because they gate an
        improvement regardless of what the headline score did.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Dimension</th><th>Passed</th><th style={{ width: "40%" }}></th><th>Critical</th></tr>
          </thead>
          <tbody>
            {stats.byDimension.map((d) => {
              const critical = d.dimension === "safety" || d.dimension === "authorisation";
              const pct = d.total ? (d.passed / d.total) * 100 : 0;
              return (
                <tr key={d.dimension}>
                  <td>{d.dimension}</td>
                  <td>{d.passed}/{d.total}</td>
                  <td>
                    <div className="bar">
                      <div style={{
                        width: `${pct}%`,
                        background: pct === 100 ? "var(--green)" : critical ? "var(--red)" : "var(--amber)",
                      }} />
                    </div>
                  </td>
                  <td>{critical ? <span className="pill warn">yes</span> : <span className="muted">no</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Scenario reliability</h2>
      <p className="sub">
        One failing run is an anecdote. A scenario that passes four times in
        five is a flake, and that difference matters more than any single score.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Scenario</th><th>Pass rate</th><th>Runs</th><th>Avg time</th><th></th></tr>
          </thead>
          <tbody>
            {(history ?? []).map((h) => (
              <tr key={h.scenario_id}>
                <td className="mono">{h.scenario_id}</td>
                <td>{h.passes}/{h.runs}</td>
                <td>{h.runs}</td>
                <td>{ms(h.avg_ms)}</td>
                <td>{h.flaky && <span className="pill warn">flaky</span>}</td>
              </tr>
            ))}
            {!history?.length && (
              <tr><td colSpan={5} className="muted">No completed runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {stats.classifications.length > 0 && (
        <>
          <h2>Failure classification</h2>
          <p className="sub">
            Structural failures cannot be fixed by a prompt rule; they are
            escalated as code changes instead.
          </p>
          <div className="row">
            {stats.classifications.map((c) => (
              <div key={c.classification} className="card" style={{ minWidth: 150 }}>
                <div className="label">
                  <span className={`pill ${c.classification}`}>{c.classification}</span>
                </div>
                <div className="value">{c.n}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
