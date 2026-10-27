import Anthropic from "@anthropic-ai/sdk";

import { describeStep } from "./tools.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";
// Server-side fallback when a safety classifier declines ("default" routes by category), and
// the short progress notes Claude writes between tool calls, which the person sees as it works.
const BETAS = ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"];
const MAX_ROUNDS = 40;
const CANCELLED = "Cancelled: the person stopped this run before the tool ran.";

/**
 * A history that ends in tool calls with no results (a run stopped, or the server went down,
 * between the two) is answered with cancellations, so the next request is valid. Appends only:
 * an edited earlier turn would invalidate the thinking blocks after it.
 */
export function repairHistory(messages) {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return false;
  const uses = last.content.filter((block) => block.type === "tool_use");
  if (!uses.length) return false;
  messages.push({ role: "user", content: uses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: CANCELLED, is_error: true })) });
  return true;
}

/**
 * The conversation as the person's chat shows it: their messages, and per reply Claude's text
 * with a step for each tool call. Tool results and thinking are not shown.
 */
export function transcript(messages) {
  const entries = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "user") {
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (text) entries.push({ role: "user", text });
      continue;
    }
    let reply = entries.at(-1);
    if (reply?.role !== "assistant") entries.push(reply = { role: "assistant", text: "", steps: [] });
    for (const block of blocks) {
      if (block.type === "text") reply.text += (reply.text ? "\n\n" : "") + block.text;
      if (block.type === "tool_use") reply.steps.push(describeStep(block.name, block.input));
    }
  }
  return entries;
}

/**
 * One turn of the person's conversation: Claude's replies and tool calls until it answers
 * without calling a tool. `messages` is appended to in place, and `persist()` is called after
 * every complete round so a stopped run keeps what it did. Events for the person's chat go to
 * `onEvent`: text and progress deltas, tool calls and their outcomes, `built` after a
 * successful build, and `error`.
 */
export async function runTurn({ client, model = DEFAULT_MODEL, effort = "high", system, tools, toolbox, messages, persist, onEvent, signal }) {
  let jsonRetries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      betas: BETAS,
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }, { signal });
    stream.on("text", (delta) => onEvent({ type: "text", delta }));
    stream.on("thinking", (delta) => onEvent({ type: "progress", delta }));

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (cause) {
      // Only a tool input the SDK could not parse at all is retried; anything else, an abort and
      // repeated bad input end the turn. The SDK has no class of its own for that failure (its
      // stream wraps every other error in the same base class), so its message names it.
      const unparseable = cause instanceof Anthropic.AnthropicError && !(cause instanceof Anthropic.APIError)
        && cause.message.startsWith("Unable to parse tool parameter JSON");
      if (!unparseable || signal?.aborted || jsonRetries++ >= 2) throw cause;
      onEvent({ type: "notice", text: "Claude's tool input was cut off; asking again." });
      continue;
    }

    if (message.stop_reason === "refusal") {
      onEvent({ type: "error", message: "Claude declined this request. Try describing the part differently." });
      return;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      persist();
      continue;
    }
    const uses = message.content.filter((block) => block.type === "tool_use");
    // A tool input cut off by max_tokens can still parse; never run it.
    if (message.stop_reason === "max_tokens" && uses.length) {
      onEvent({ type: "error", message: "Claude's reply was too long to finish. Ask for a smaller change." });
      return;
    }
    messages.push({ role: "assistant", content: message.content });
    persist();
    if (!uses.length) {
      onEvent({ type: "done" });
      return;
    }

    const results = [];
    for (const use of uses) {
      if (signal?.aborted) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: CANCELLED, is_error: true });
        continue;
      }
      onEvent({ type: "tool", id: use.id, step: describeStep(use.name, use.input) });
      const result = await toolbox.run(use.name, use.input);
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      onEvent({ type: "tool_result", id: use.id, ok: !result.isError });
      if (result.built) onEvent({ type: "built" });
    }
    messages.push({ role: "user", content: results });
    persist();
    if (signal?.aborted) return;
  }
  onEvent({ type: "error", message: `Stopped after ${MAX_ROUNDS} rounds of tool calls. Send a message to continue.` });
}
