import { api } from "../lib/api.js";
import { useFetch, when } from "../lib/hooks.js";

/**
 * What the agent has learned.
 *
 * Additive and revertible on purpose: a bad lesson is one row to retire
 * rather than a prompt to reconstruct, and the review that approved it is
 * recorded alongside.
 */
export function Lessons() {
  const { data: lessons, error, reload } = useFetch(() => api.lessons(), []);

  const active = (lessons ?? []).filter((l) => l.active);
  const retired = (lessons ?? []).filter((l) => !l.active);

  return (
    <>
      <h1>Lessons</h1>
      <p className="sub">
        Appended to the agent's prompt beneath the hand-written guardrails,
        which the system never edits. Rules in safety, authorisation and
        escalation are pinned: they load on every turn and are never subject
        to retrieval.
      </p>

      {error && <div className="err">{error}</div>}

      <h2>Active ({active.length})</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Rule</th><th>Dimension</th><th>From</th><th>Added</th><th></th>
            </tr>
          </thead>
          <tbody>
            {active.map((l) => (
              <tr key={l.id}>
                <td>{l.rule}</td>
                <td>
                  <span className="pill muted">{l.dimension}</span>
                  {l.always_load && <span className="pill warn"> pinned</span>}
                </td>
                <td className="mono">{l.from_scenario}</td>
                <td className="muted">{when(l.created_at)}</td>
                <td>
                  <button
                    className="danger"
                    onClick={async () => {
                      await api.retireLesson(l.id);
                      void reload();
                    }}
                  >
                    Retire
                  </button>
                </td>
              </tr>
            ))}
            {!active.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No lessons yet. Approve a review to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {retired.length > 0 && (
        <>
          <h2>Retired ({retired.length})</h2>
          <div className="panel">
            <table>
              <tbody>
                {retired.map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{l.rule}</td>
                    <td className="mono muted">{l.from_scenario}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
