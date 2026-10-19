import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Review } from "../lib/api.js";
import { useFetch, when } from "../lib/hooks.js";

/**
 * The human gate.
 *
 * Nothing the system learns reaches the agent without passing through here.
 * Each entry carries what a reviewer needs to judge it without digging
 * through logs: the diagnosis, the exact proposed change, and what that
 * change did to the whole suite when it was trialled.
 */
export function Reviews() {
  const [filter, setFilter] = useState<string>("pending");
  const { data: reviews, error, reload } = useFetch(
    () => api.reviews(filter === "all" ? undefined : filter),
    [filter],
    6000,
  );

  return (
    <>
      <div className="spread">
        <div>
          <h1>Review queue</h1>
          <p className="sub">
            Approving is the only way a learned rule reaches the agent.
            Structural findings cannot be approved into one — they need a code
            change.
          </p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 150 }}
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <div className="err">{error}</div>}

      {(reviews ?? []).map((r) => (
        <ReviewCard key={r.id} review={r} onChange={reload} />
      ))}

      {!reviews?.length && (
        <div className="panel" style={{ padding: 20 }}>
          <p className="muted">
            Nothing {filter === "all" ? "" : filter} in the queue.
            {filter === "pending" && " Run a loop to populate it."}
          </p>
        </div>
      )}
    </>
  );
}

function ReviewCard({
  review,
  onChange,
}: {
  review: Review;
  onChange: () => void;
}) {
  const [rule, setRule] = useState(review.proposed_rule ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const canApprove = review.status === "pending" && !!review.proposed_rule;
  const improved =
    review.effect_after != null &&
    review.effect_before != null &&
    review.effect_after > review.effect_before;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
      <div className="spread">
        <div className="row">
          <span className={`pill ${review.classification}`}>
            {review.classification}
          </span>
          <strong className="mono">{review.scenario_id}</strong>
          <span className="pill muted">{review.confidence} confidence</span>
          {review.status !== "pending" && (
            <span className={`pill ${review.status === "approved" ? "pass" : "muted"}`}>
              {review.status}
            </span>
          )}
          {review.safety_regressed && (
            <span className="pill fail">safety regressed</span>
          )}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{when(review.created_at)}</span>
      </div>

      <p style={{ margin: "12px 0 6px" }}>{review.diagnosis}</p>

      {review.failed_checks.length > 0 && (
        <div className="mono muted" style={{ fontSize: 11, marginBottom: 8 }}>
          {review.failed_checks.join(" · ")}
        </div>
      )}

      {/* Structural: no rule, a code change instead. */}
      {review.classification === "structural" && review.proposed_code_change && (
        <div className="banner">
          <strong>Code change needed.</strong> This cannot be fixed by a prompt
          rule: {review.proposed_code_change}
        </div>
      )}

      {/* Behavioural: the proposed rule, editable before approval. */}
      {review.proposed_rule && (
        <>
          <label>Proposed rule {review.dimension && `(${review.dimension})`}</label>
          <textarea
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            disabled={review.status !== "pending"}
          />
          {review.effect_total != null && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">Trialled against the full suite:</span>
              <span className={improved ? "pill pass" : "pill muted"}>
                {review.effect_before} → {review.effect_after} / {review.effect_total}
              </span>
              {review.regressions.length > 0 ? (
                <span className="pill fail">
                  regressed: {review.regressions.join(", ")}
                </span>
              ) : (
                <span className="pill pass">no regressions</span>
              )}
            </div>
          )}
        </>
      )}

      {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

      {review.status === "pending" && (
        <>
          <label>Reviewer note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="ok"
              disabled={!canApprove || busy}
              onClick={() => act(async () => {
                if (rule !== review.proposed_rule) {
                  await api.editRule(review.id, rule);
                }
                await api.approve(review.id, note || undefined);
              })}
              title={canApprove ? "" : "Structural and harness findings have no rule to approve"}
            >
              Approve
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => act(() => api.reject(review.id, note || undefined))}
            >
              Reject
            </button>
            {review.result_id && (
              <Link to={`/results/${review.result_id}`}>
                <button>View evidence</button>
              </Link>
            )}
            <button onClick={() => setOpen(!open)}>
              {open ? "Hide" : "Show"} raw
            </button>
          </div>
        </>
      )}

      {review.reviewer_note && (
        <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Note: {review.reviewer_note}
        </p>
      )}

      {open && <pre style={{ marginTop: 12 }}>{JSON.stringify(review, null, 2)}</pre>}
    </div>
  );
}
