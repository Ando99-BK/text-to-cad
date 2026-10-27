import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";

import { repairHistory, runTurn, transcript } from "./agent.mjs";
import { fakeClient } from "./test-support.mjs";

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

function turn(script, toolbox, messages = [{ role: "user", content: "a 40 mm cube" }]) {
  const client = fakeClient(script);
  const events = [];
  let saves = 0;
  const done = runTurn({
    client, system: "SYSTEM", tools: [], toolbox, messages,
    persist: () => { saves++; }, onEvent: (event) => events.push(event),
  });
  return done.then(() => ({ client, events, messages, saves }));
}

test("a turn runs Claude's tool calls until it answers, and keeps every round", async () => {
  const ran = [];
  const toolbox = { run: async (name, input) => { ran.push([name, input]); return name === "run_python" ? { content: "exit code 0", built: true } : { content: "ok" }; } };
  const { client, events, messages, saves } = await turn([
    { stop_reason: "tool_use", content: [toolUse("t1", "write_file", { path: "src/model.py", content: "" }), toolUse("t2", "run_python", { path: "src/model.py" })] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "A 40 mm cube." }] },
  ], toolbox);

  assert.deepEqual(ran.map(([name]) => name), ["write_file", "run_python"]);
  assert.equal(messages.length, 4);
  // Both results go back in ONE user message, in call order.
  assert.deepEqual(messages[2].content.map((block) => block.tool_use_id), ["t1", "t2"]);
  assert.equal(saves, 3);
  assert.deepEqual(events.map((event) => event.type), ["tool", "tool_result", "tool", "tool_result", "built", "text", "done"]);
  const [request] = client.requests;
  assert.equal(request.model, "claude-opus-5-5");
  assert.equal(request.fallbacks, "default");
  assert.deepEqual(request.thinking, { type: "adaptive", display: "updates" });
  assert.deepEqual(request.system, [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
});

test("a refusal and a truncated tool call end the turn without running anything", async () => {
  const toolbox = { run: async () => assert.fail("no tool may run") };
  const refused = await turn([{ stop_reason: "refusal", content: [toolUse("t1", "write_file", {})] }], toolbox);
  assert.equal(refused.events.at(-1).type, "error");
  assert.equal(refused.messages.length, 1);

  const truncated = await turn([{ stop_reason: "max_tokens", content: [toolUse("t1", "write_file", { path: "src/m" })] }], toolbox);
  assert.equal(truncated.events.at(-1).type, "error");
  assert.equal(truncated.messages.length, 1);
});

test("an unparseable tool input is asked again; any other failure is not", async () => {
  const unparseable = new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model.");
  const { events } = await turn([unparseable, { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] }], { run: async () => ({}) });
  assert.deepEqual(events.map((event) => event.type), ["notice", "text", "done"]);
  // The stream wraps a failure that is not the SDK's own in its base error class.
  const noCredentials = new Anthropic.AnthropicError("Could not resolve authentication method.");
  await assert.rejects(turn([noCredentials], { run: async () => ({}) }), noCredentials);
  const overloaded = new Anthropic.APIError(529, undefined, "Overloaded", new Headers());
  await assert.rejects(turn([overloaded], { run: async () => ({}) }), overloaded);
});

test("tool calls left without results are answered with cancellations, appended", () => {
  const messages = [
    { role: "user", content: "a cube" },
    { role: "assistant", content: [{ type: "text", text: "Building." }, toolUse("t1", "run_python", { path: "src/model.py" })] },
  ];
  assert.equal(repairHistory(messages), true);
  assert.equal(messages[2].content[0].tool_use_id, "t1");
  assert.equal(messages[2].content[0].is_error, true);
  assert.equal(repairHistory(messages), false);
});

test("the chat shows the person's messages and Claude's replies with their steps", () => {
  assert.deepEqual(transcript([
    { role: "user", content: "a cube" },
    { role: "assistant", content: [{ type: "thinking", thinking: "" }, toolUse("t1", "run_python", { path: "src/model.py" })] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "exit code 0" }] },
    { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
    { role: "user", content: "taller" },
  ]), [
    { role: "user", text: "a cube" },
    { role: "assistant", text: "Here it is.", steps: [{ action: "build", target: "src/model.py" }] },
    { role: "user", text: "taller" },
  ]);
});
