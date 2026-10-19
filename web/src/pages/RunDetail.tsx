import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useFetch, ms, when } from "../lib/hooks.js";

export function RunDetail() {
  const { id = "" } = useParams();
  const { data, error } = useFetch(() => api.run(id), [id], 4000);

  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { run, results } = data;
  const failed = results.filter((r) => !r.passed);

  return (
    <>
      <Link to="/runs">← Runs</Link>
      <h1>{run.kind} run</h1>
      <p className="sub mono">{run.config}</p>

      <div className="cards">
        <div className="card">
          <div className="label">Score</div>
          <div className="value">{run.passed}/{run.total}</div>
        </div>
        <div className="card">
          <div className="label">Duration</div>
          <div className="value">{ms(run.duration_ms)}</div>
        </div>
        <div className="card">
          <div className="label">Lessons applied</div>
          <div className="value">{run.lessons_count}</div>
        </div>
        <div className="card">
          <div className="label">Started</div>
          <div className="value" style={{ fontSize: 14 }}>{when(run.started_at)}</div>
        </div>
      </div>

      {failed.length > 0 && (
        <>
          <h2>Failures ({failed.length})</h2>
          <div className="panel">
            <table>
              <thead><tr><th>Scenario</th><th>Dimension</th><th>Failed checks</th></tr></thead>
              <tbody>
                {failed.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/results/${r.id}`}>{r.title}</Link></td>
                    <td><span className="pill muted">{r.dimension}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {r.failures.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>All scenarios</h2>
      <p className="sub">
        The call column shows the route the agent took. A passing scenario can
        still reach the right answer the wrong way.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th></th><th>Scenario</th><th>Turns</th><th>Calls</th>
              <th>Time</th><th>Route</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className={`pill ${r.passed ? "pass" : "fail"}`}>
                    {r.passed ? "pass" : "fail"}
                  </span>
                </td>
                <td><Link to={`/results/${r.id}`}>{r.title}</Link></td>
                <td>{r.turns}</td>
                <td>
                  {r.audit?.totalCalls ?? 0}
                  {!!r.audit?.failedCalls && (
                    <span className="muted"> ({r.audit.failedCalls} refused)</span>
                  )}
                </td>
                <td>{ms(r.duration_ms)}</td>
                <td className="mono muted" style={{ fontSize: 11 }}>
                  {(r.audit?.calls ?? [])
                    .map((c) => (c.ok ? c.name : `${c.name}!`))
                    .join(" → ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
