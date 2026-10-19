import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useFetch, ms, when } from "../lib/hooks.js";

export function Runs() {
  const { data: runs, reload } = useFetch(() => api.runs(), [], 4000);
  const { data: status } = useFetch(() => api.runStatus(), [], 2000);
  const [error, setError] = useState<string | null>(null);

  async function start(kind: "eval" | "loop") {
    setError(null);
    try {
      await api.startRun(kind);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <div className="spread">
        <div>
          <h1>Runs</h1>
          <p className="sub">
            An eval measures. A loop measures, then investigates each failure
            and queues a proposal — it never changes the agent on its own.
          </p>
        </div>
        <div className="row">
          <button onClick={() => start("eval")} disabled={status?.active}>
            Run eval
          </button>
          <button className="primary" onClick={() => start("loop")} disabled={status?.active}>
            Run loop
          </button>
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      {status?.active && (
        <div className="banner">
          <strong>{status.kind}</strong> in progress — {status.phase}
        </div>
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Started</th><th>Kind</th><th>Status</th><th>Score</th>
              <th>Lessons</th><th>Duration</th><th>Models</th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.id}>
                <td><Link to={`/runs/${r.id}`}>{when(r.started_at)}</Link></td>
                <td><span className="pill muted">{r.kind}</span></td>
                <td>
                  <span className={`pill ${r.status === "completed" ? "pass" : r.status === "failed" ? "fail" : "info"}`}>
                    {r.status}
                  </span>
                </td>
                <td>
                  {r.status === "completed" ? (
                    <span className={r.passed === r.total ? "pill pass" : "pill fail"}>
                      {r.passed}/{r.total}
                    </span>
                  ) : "—"}
                </td>
                <td>{r.lessons_count}</td>
                <td>{ms(r.duration_ms)}</td>
                <td className="mono muted" style={{ fontSize: 11 }}>{r.config}</td>
              </tr>
            ))}
            {!runs?.length && (
              <tr><td colSpan={7} className="muted">No runs yet. Start one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
