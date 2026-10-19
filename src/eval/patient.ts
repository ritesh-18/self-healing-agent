import type { LlmProvider } from "../providers/types.js";

/**
 * The simulated patient.
 *
 * Deliberately not a script. A fixed script would only ever test the paths we
 * imagined; a persona with a goal will improvise, mishear, and push back, which
 * is where real agents break. The trade-off is run-to-run variance, which is
 * why scenarios assert on outcomes rather than on exact wording.
 */

const SYSTEM = `You are role-playing a patient phoning a medical clinic. You are
NOT an assistant and you never break character.

Rules:
- Speak one short, natural sentence or two. This is a phone call.
- Only reveal details when asked, the way a real caller would.
- Pursue your goal. If the receptionist deflects something you asked, you may
  press once, then move on.
- Never mention that you are an AI, a simulation, or a test.
- When your goal is met or clearly refused, say a brief goodbye and then output
  the token [END_CALL] on its own at the end of that message.

Your character and goal:
`;

export class SimulatedPatient {
  private readonly history: { role: "user" | "assistant"; text: string }[] = [];

  constructor(
    private readonly provider: LlmProvider,
    private readonly persona: string,
  ) {}

  /**
   * Produces the patient's next utterance. `mayaSaid` is undefined on the
   * opening turn, where the patient speaks first.
   */
  async next(mayaSaid?: string): Promise<{ text: string; ended: boolean }> {
    if (mayaSaid !== undefined) {
      // Maya is the "user" from the patient's point of view.
      this.history.push({ role: "user", text: mayaSaid });
    }

    const res = await this.provider.complete({
      system: SYSTEM + this.persona,
      turns:
        this.history.length > 0
          ? this.history.map((h) => ({
              role: h.role,
              kind: "text" as const,
              text: h.text,
            }))
          : [
              {
                role: "user" as const,
                kind: "text" as const,
                text: "(The line connects. Speak first.)",
              },
            ],
      // Higher than the agent: a patient who phrases things the same way every
      // run would make the suite easier than reality.
      temperature: 0.8,
    });

    const raw = res.text.trim();
    const ended = raw.includes("[END_CALL]");
    const text = raw.replace("[END_CALL]", "").trim() || "Thanks, bye.";

    this.history.push({ role: "assistant", text });
    return { text, ended };
  }
}
