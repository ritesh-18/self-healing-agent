import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cleanText } from "./bedrock.js";

/**
 * Text cleaning for Bedrock-hosted models.
 *
 * Every case here was observed in a live response. Left in place, each one
 * reaches the transcript the judge reads, so the judge ends up grading
 * formatting noise instead of the agent's behaviour.
 */
describe("cleanText", () => {
  it("removes a closed thinking block", () => {
    assert.equal(cleanText("<thinking>reasoning</thinking>Hello"), "Hello");
  });

  it("removes a thinking block truncated by the token limit", () => {
    assert.equal(cleanText("Hello<thinking>unclosed reasoning"), "Hello");
  });

  it("removes DeepSeek control markers", () => {
    assert.equal(cleanText("Hi<｜tool▁calls▁begin｜>"), "Hi");
  });

  it("removes a truncated DSML preamble, as seen live", () => {
    // The real failure: a correct toolUse block arrived alongside this
    // unterminated marker in the text channel.
    assert.equal(
      cleanText("Let me verify your information.\n\n<DSMLfunction_calls"),
      "Let me verify your information.",
    );
  });

  it("leaves ordinary replies untouched", () => {
    const reply = "You're booked for Tuesday 10 March at 9 AM.";
    assert.equal(cleanText(reply), reply);
  });

  it("does not eat legitimate angle brackets", () => {
    assert.equal(cleanText("Arrive <10 minutes early."), "Arrive <10 minutes early.");
  });
});
