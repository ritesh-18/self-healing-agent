import { useState } from "react";
import { useParams } from "react-router-dom";
import { Conversation } from "../components/Conversation.js";
import { api } from "../lib/api.js";
import { useFetch, ms } from "../lib/hooks.js";

type Tab = "conversation" | "evidence" | "events" | "raw";

/**
 * One scenario, with all three kinds of evidence.
 *
 * State assertions are deterministic. The rubric is an LLM judging words.
 * The event log is what actually happened. A reviewer needs all three,
 * because the characteristic failure here is a transcript that reads
 * perfectly while the database says otherwise.
 */
export function ResultDetailPage() {
  const { id = "" } = useParams();
  const { data, error } = useFetch(() => api.result(id), [id]);
  const [tab, setTab] = useState<Tab>("conversation");

  if (error) return <div className="err">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>{data.title}</h1>
      <p className="sub">
        <span className={`pill ${data.passed ? "pass" : "fail"}`}>
          {data.passed ? "pass" : "fail"}
        </span>{" "}
        <span className="pill muted">{data.dimension}</span>{" "}
        <span className="muted">{data.turns} turns · {ms(data.duration_ms)}</span>
      </p>

      {data.summary && (
        <div className="banner">
          <strong>Summary (from events, not from what the agent claimed):</strong>{" "}
          {data.summary.narrative}
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        {(["conversation", "evidence", "events", "raw"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "primary" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "evidence" && (
        <div className="grid2">
          <div>
            <h2>State assertions</h2>
            <p className="sub">Deterministic. The witness the judge cannot be fooled about.</p>
            <div className="panel">
              <table>
                <tbody>
                  {data.assertions.map((a) => (
                    <tr key={a.id}>
                      <td style={{ width: 60 }}>
                        <span className={`pill ${a.pass ? "pass" : "fail"}`}>
                          {a.pass ? "ok" : "fail"}
                        </span>
                      </td>
                      <td>{a.describe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h2>Rubric (LLM judge)</h2>
            <p className="sub">Words only. Explicitly barred from ruling on the database.</p>
            <div className="panel">
              <table>
                <tbody>
                  {data.rubric.map((r, i) => (
                    <tr key={i}>
                      <td style={{ width: 60 }}>
                        <span className={`pill ${r.pass ? "pass" : "fail"}`}>
                          {r.pass ? "ok" : "fail"}
                        </span>
                      </td>
                      <td>
                        {r.item}
                        {!r.pass && <div className="muted" style={{ fontSize: 12 }}>{r.why}</div>}
                      </td>
                    </tr>
                  ))}
                  {!data.rubric.length && (
                    <tr><td className="muted">No rubric items.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.audit && (
            <div style={{ gridColumn: "1 / -1" }}>
              <h2>Tool-call audit</h2>
              <p className="sub">
                {data.audit.totalCalls} calls, {data.audit.failedCalls} refused.
                A refusal is usually a guardrail working, not a bug.
              </p>
              <div className="panel">
                <table>
                  <thead><tr><th>#</th><th>Tool</th><th>Outcome</th></tr></thead>
                  <tbody>
                    {data.audit.calls.map((c, i) => (
                      <tr key={i}>
                        <td className="muted">{c.seq}</td>
                        <td className="mono">{c.name}</td>
                        <td>
                          {c.ok
                            ? <span className="pill pass">ok</span>
                            : <span className="pill fail">{c.error ?? "refused"}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.audit.findings.map((f, i) => (
                <div key={i} className="banner" style={{ marginTop: 10 }}>
                  <span className={`pill ${f.severity === "error" ? "fail" : "warn"}`}>
                    {f.code}
                  </span>{" "}
                  {f.detail}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "conversation" && (
        <>
          <p className="sub">
            What was said, and what the agent did about it. Tool results are
            collapsed — expand one to check whether a slot it offered was
            really returned by the system.
          </p>
          <Conversation transcript={data.transcript} />
        </>
      )}

      {tab === "raw" && <pre>{data.transcript}</pre>}

      {tab === "events" && (
        <div className="panel">
          <table>
            <thead><tr><th>#</th><th>Event</th><th>Payload</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.seq}>
                  <td className="muted">{e.seq}</td>
                  <td className="mono">{e.name}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {JSON.stringify(e.payload).slice(0, 160)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
