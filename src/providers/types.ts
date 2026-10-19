/**
 * A provider-neutral chat surface.
 *
 * Every adapter (Gemini, OpenAI, Anthropic) normalises to these shapes so the
 * agent loop, the patient simulator, the judge and the reflector never care
 * which vendor is behind them. Swapping providers must not change behaviour
 * that the eval harness measures.
 */

export type Role = "user" | "assistant";

/** A tool the model may call. Parameters are a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A model's request to invoke a tool. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Opaque provider state that must be echoed back verbatim in history.
   *
   * Gemini 3.x attaches an encrypted `thoughtSignature` to each function call
   * and rejects follow-up requests that omit it. Nothing outside the provider
   * adapter should read or construct this - it is carried, not interpreted.
   */
  providerMeta?: Record<string, unknown>;
}

/** The result of running a tool, fed back to the model. */
export interface ToolResult {
  id: string;
  name: string;
  /** JSON-serialisable payload returned by the tool. */
  content: unknown;
}

/**
 * One turn of conversation. A turn is either plain text, a batch of tool
 * calls the model wants run, or the results of those calls.
 */
export type Turn =
  | { role: Role; kind: "text"; text: string }
  | { role: "assistant"; kind: "tool_calls"; text?: string; calls: ToolCall[] }
  | { role: "user"; kind: "tool_results"; results: ToolResult[] };

export interface CompletionRequest {
  system: string;
  turns: Turn[];
  tools?: ToolSpec[];
  temperature?: number;
  /** Ask the provider for a raw JSON object rather than prose. */
  json?: boolean;
}

export interface CompletionResponse {
  text: string;
  calls: ToolCall[];
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
