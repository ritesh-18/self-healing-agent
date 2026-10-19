/**
 * Renders a transcript as a readable conversation.
 *
 * The stored transcript is a flat string with four line shapes: PATIENT,
 * MAYA, [tool] and [result]. Showing it raw makes the thing a reviewer most
 * needs - what was actually said, and what the agent did about it - hard to
 * pick out of a wall of JSON.
 *
 * Tool results are collapsed by default. A find_slots response is hundreds of
 * characters of slot data that buries the dialogue around it, but it is
 * exactly what you need when the question is "did she offer a slot the system
 * never returned".
 */
import { useState } from "react";

type Line =
  | { kind: "patient" | "agent"; text: string }
  | { kind: "tool"; name: string; args: string }
  | { kind: "result"; name: string; payload: string; ok: boolean };

function parse(transcript: string): Line[] {
  const lines: Line[] = [];

  for (const raw of transcript.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("PATIENT:")) {
      lines.push({ kind: "patient", text: line.slice(8).trim() });
      continue;
    }

    if (line.startsWith("MAYA:")) {
      const text = line.slice(5).trim();
      // Some models leak a control marker into their visible text. It is not
      // addressed to the caller, so it is dropped here as well as in the
      // provider adapter.
      const cleaned = text.replace(/<\s*\/?\s*DSML[\s\S]*$/i, "").trim();
      if (cleaned) lines.push({ kind: "agent", text: cleaned });
      continue;
    }

    const tool = line.match(/^\s*\[tool\]\s+(\w+)\((.*)\)\s*$/);
    if (tool) {
      lines.push({ kind: "tool", name: tool[1]!, args: tool[2]! });
      continue;
    }

    const result = line.match(/^\s*\[result\]\s+(\w+)\s*->\s*(.*)$/);
    if (result) {
      const payload = result[2]!;
      lines.push({
        kind: "result",
        name: result[1]!,
        payload,
        ok: !payload.includes('"ok":false'),
      });
      continue;
    }

    // Anything else is a continuation of the previous speaker's text.
    const last = lines[lines.length - 1];
    if (last && (last.kind === "patient" || last.kind === "agent")) {
      last.text += ` ${line.trim()}`;
    }
  }

  return lines;
}

export function Conversation({ transcript }: { transcript: string }) {
  const lines = parse(transcript);

  if (!lines.length) {
    return <p className="muted">No conversation recorded.</p>;
  }

  return (
    <div className="convo">
      {lines.map((l, i) => {
        if (l.kind === "patient" || l.kind === "agent") {
          return (
            <div key={i} className={`bubble ${l.kind}`}>
              <div className="who">{l.kind === "patient" ? "Patient" : "Maya"}</div>
              <div>{l.text}</div>
            </div>
          );
        }
        if (l.kind === "tool") {
          return <ToolCall key={i} name={l.name} args={l.args} />;
        }
        if (l.kind === "result") {
          return (
            <ToolResult key={i} name={l.name} payload={l.payload} ok={l.ok} />
          );
        }
        return null;
      })}
    </div>
  );
}

function ToolCall({ name, args }: { name: string; args: string }) {
  let pretty = args;
  try {
    pretty = Object.entries(JSON.parse(args) as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
  } catch {
    // Leave the raw arguments if they are not valid JSON - a malformed call
    // is itself worth seeing.
  }

  return (
    <div className="tool-line">
      <span className="pill info">called</span>
      <span className="mono"> {name}</span>
      {pretty && <span className="muted"> — {pretty}</span>}
    </div>
  );
}

function ToolResult({
  name,
  payload,
  ok,
}: {
  name: string;
  payload: string;
  ok: boolean;
}) {
  const [open, setOpen] = useState(false);

  // A one-line gist, so the common case needs no expanding.
  let gist = "";
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (!ok) {
      gist = `refused: ${String(parsed.error ?? "")}`;
    } else if (typeof parsed.count === "number") {
      gist = `${parsed.count} slot(s) available`;
    } else if (parsed.appointment) {
      const a = parsed.appointment as Record<string, unknown>;
      gist = `booked ${String(a.date)} ${String(a.time)}`;
    } else if (parsed.patient) {
      const p = parsed.patient as Record<string, unknown>;
      const appts = (parsed.appointments as unknown[] | undefined)?.length ?? 0;
      gist = `verified ${String(p.name)}, ${appts} existing appointment(s)`;
    } else if (parsed.cancelled) {
      gist = "cancelled";
    } else {
      gist = "ok";
    }
  } catch {
    gist = payload.slice(0, 80);
  }

  return (
    <div className="tool-line">
      <span className={`pill ${ok ? "pass" : "fail"}`}>
        {ok ? "returned" : "refused"}
      </span>
      <span className="mono"> {name}</span>
      <span className="muted"> — {gist}</span>
      <button
        onClick={() => setOpen(!open)}
        style={{ marginLeft: 8, padding: "1px 7px", fontSize: 11 }}
      >
        {open ? "hide" : "raw"}
      </button>
      {open && <pre style={{ marginTop: 6, maxHeight: 220 }}>{payload}</pre>}
    </div>
  );
}
