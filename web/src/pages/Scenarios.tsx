import { useState } from "react";
import { api, type Scenario } from "../lib/api.js";
import { useFetch } from "../lib/hooks.js";

const ASSERTION_KINDS = [
  "appointment_exists",
  "appointment_absent",
  "appointment_count",
  "appointment_cancelled",
  "escalation_raised",
  "no_escalation",
  "event_emitted",
  "event_absent",
  "no_event_after",
  "never_verified",
] as const;

interface DraftAssertion {
  id: string;
  describe: string;
  kind: string;
  params: string;
}

export function Scenarios() {
  const { data: scenarios, error, reload } = useFetch(() => api.scenarios(), []);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="spread">
        <div>
          <h1>Scenarios</h1>
          <p className="sub">
            Built-ins are the regression corpus and keep their code-defined
            assertions. They can be disabled but not deleted.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(!creating)}>
          {creating ? "Cancel" : "New scenario"}
        </button>
      </div>

      {error && <div className="err">{error}</div>}
      {creating && (
        <NewScenario
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Source</th>
              <th>Turns</th>
              <th>Rubric</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(scenarios ?? []).map((s) => (
              <Row key={s.id} s={s} onChange={reload} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ s, onChange }: { s: Scenario; onChange: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr>
        <td className="mono">{s.id}</td>
        <td>{s.title}</td>
        <td>
          <span className={`pill ${s.source === "builtin" ? "info" : "muted"}`}>
            {s.source}
          </span>
        </td>
        <td>{s.max_turns}</td>
        <td>{s.rubric.length}</td>
        <td>
          <input
            type="checkbox"
            checked={s.enabled}
            style={{ width: "auto" }}
            onChange={async (e) => {
              await api.setEnabled(s.id, e.target.checked);
              onChange();
            }}
          />
        </td>
        <td>
          <div className="row">
            <button onClick={() => setOpen(!open)}>
              {open ? "Hide" : "View"}
            </button>
            {s.source === "user" && (
              <button
                className="danger"
                onClick={async () => {
                  await api.deleteScenario(s.id);
                  onChange();
                }}
              >
                Delete
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              {s.probes}
            </p>
            <strong style={{ fontSize: 12 }}>Patient persona</strong>
            <pre style={{ maxHeight: 160 }}>{s.patient}</pre>
            <strong style={{ fontSize: 12 }}>Rubric</strong>
            <ul className="muted" style={{ fontSize: 12 }}>
              {s.rubric.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Scenario authoring.
 *
 * Assertions are declarative descriptors, not code. A scenario written here
 * cannot supply a function, because that would mean executing user-supplied
 * code on the server; the interpreter in src/db/scenarios.ts covers the
 * checks the catalogued failure classes actually need.
 */
function NewScenario({ onCreated }: { onCreated: () => void }) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [probes, setProbes] = useState("");
  const [patient, setPatient] = useState("");
  const [maxTurns, setMaxTurns] = useState(8);
  const [dimension, setDimension] = useState("conversation");
  const [rubric, setRubric] = useState("");
  const [assertions, setAssertions] = useState<DraftAssertion[]>([
    {
      id: "a1",
      describe: "",
      kind: "appointment_exists",
      params: '{"patientId":"p1"}',
    },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(i: number, patch: Partial<DraftAssertion>) {
    setAssertions(assertions.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createScenario({
        id,
        title,
        probes,
        patient,
        maxTurns,
        dimension,
        rubric: rubric
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean),
        assertions: assertions.map((a) => ({
          id: a.id,
          describe: a.describe,
          kind: a.kind,
          params: JSON.parse(a.params || "{}"),
        })),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
      <h2 style={{ marginTop: 0 }}>New scenario</h2>
      {error && <div className="err">{error}</div>}

      <div className="grid2">
        <div>
          <label>ID (lowercase, hyphens)</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="double-booking-attempt"
          />
        </div>
        <div>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>

      <label>What this probes</label>
      <input
        value={probes}
        onChange={(e) => setProbes(e.target.value)}
        placeholder="Why this scenario exists — shown in reports"
      />

      <label>Patient persona and goal</label>
      <textarea
        value={patient}
        onChange={(e) => setPatient(e.target.value)}
        placeholder="You are Tom Alvarez, DOB 1971-11-02. You want… Push back once if deflected."
      />

      <div className="grid2">
        <div>
          <label>Max turns</label>
          <input
            type="number"
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
          />
        </div>
        <div>
          <label>Dimension</label>
          <select
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          >
            {["safety", "authorisation", "honesty", "accuracy", "conversation"].map(
              (d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ),
            )}
          </select>
        </div>
      </div>

      <label>Rubric items (one per line — judged from the transcript)</label>
      <textarea
        value={rubric}
        onChange={(e) => setRubric(e.target.value)}
        placeholder="Maya verified the patient before booking."
      />

      <label>State assertions (deterministic)</label>
      {assertions.map((a, i) => (
        <div key={i} className="row" style={{ marginBottom: 8 }}>
          <input
            style={{ width: 90 }}
            value={a.id}
            onChange={(e) => update(i, { id: e.target.value })}
            placeholder="id"
          />
          <select
            style={{ width: 190 }}
            value={a.kind}
            onChange={(e) => update(i, { kind: e.target.value })}
          >
            {ASSERTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            style={{ flex: 1 }}
            value={a.describe}
            onChange={(e) => update(i, { describe: e.target.value })}
            placeholder="what this checks"
          />
          <input
            style={{ width: 240 }}
            className="mono"
            value={a.params}
            onChange={(e) => update(i, { params: e.target.value })}
            placeholder='{"patientId":"p1"}'
          />
          <button
            className="danger"
            onClick={() => setAssertions(assertions.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          setAssertions([
            ...assertions,
            {
              id: `a${assertions.length + 1}`,
              describe: "",
              kind: "appointment_exists",
              params: "{}",
            },
          ])
        }
      >
        Add assertion
      </button>

      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="primary"
          onClick={submit}
          disabled={busy || !id || !title || !patient}
        >
          Create
        </button>
      </div>
    </div>
  );
}
