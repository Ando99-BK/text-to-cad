import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { fakeClient } from "./test-support.mjs";
import { createProjectStore } from "./projects.mjs";
import { allowed, createStudio } from "./server.mjs";
import { toolDefinitions } from "./tools.mjs";

let root;
let server;
let origin;
let script;

/** A cadgen whose "build" writes the STEP a model declares. */
async function fakeCadgen(tool, args, { cwd }) {
  if (tool === "python") {
    fs.mkdirSync(path.join(cwd, "STEP"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "STEP/model.step"), "ISO-10303-21;");
  }
  return { code: 0, output: "", timedOut: false };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-server-"));
  script = [];
  server = createStudio({
    store: createProjectStore(root),
    viewer: { url: "http://127.0.0.1:9", error: null },
    createClient: () => fakeClient(script),
    runCadgen: fakeCadgen,
    system: "SYSTEM",
    tools: toolDefinitions([]),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (headers, method = "POST") => ({ method, headers });

test("only the studio's own page on a loopback host can drive it", () => {
  assert.equal(allowed(request({ host: "127.0.0.1:4317", "x-studio": "1" })), true);
  assert.equal(allowed(request({ host: "localhost:4317", origin: "http://localhost:4317", "x-studio": "1" })), true);
  assert.equal(allowed(request({ host: "127.0.0.1:4317" }, "GET")), true);
  // A page elsewhere, a rebound DNS name, or a POST a form could send.
  assert.equal(allowed(request({ host: "127.0.0.1:4317", origin: "https://evil.example", "x-studio": "1" })), false);
  assert.equal(allowed(request({ host: "evil.example:4317", "x-studio": "1" })), false);
  assert.equal(allowed(request({ host: "127.0.0.1:4317" })), false);
});

test("a message builds a model, streams the run, and the files can be downloaded", async () => {
  const headers = { "content-type": "application/json", "x-studio": "1" };
  const created = await (await fetch(`${origin}/api/projects`, { method: "POST", headers })).json();
  script.push(
    { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "t1", name: "write_file", input: { path: "src/model.py", content: "x = 1\n" } },
      { type: "tool_use", id: "t2", name: "run_python", input: { path: "src/model.py" } },
    ] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "A 40 mm cube." }] },
  );
  const response = await fetch(`${origin}/api/projects/${created.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "a 40 mm cube" }) });
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["tool", "tool_result", "tool", "tool_result", "built", "text", "done", "project"]);

  const project = events.at(-1).project;
  assert.equal(project.title, "a 40 mm cube");
  assert.deepEqual(project.transcript.map((entry) => entry.role), ["user", "assistant"]);
  const [step] = project.outputs;
  assert.equal(step.path, "STEP/model.step");
  assert.match(step.view, /^http:\/\/127\.0\.0\.1:9\/\?file=/u);
  const download = await fetch(`${origin}${step.download}`);
  assert.equal(await download.text(), "ISO-10303-21;");
  assert.match(download.headers.get("content-disposition"), /model\.step/u);

  assert.equal((await fetch(`${origin}/api/projects/${created.id}/files/project.json`)).status, 404);
  assert.equal((await fetch(`${origin}/api/projects/${created.id}/messages`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${origin}/api/projects/${created.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: " " }) })).status, 400);
  assert.equal((await fetch(`${origin}/`)).status, 200);
});
