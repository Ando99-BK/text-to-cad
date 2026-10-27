import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { createToolbox, describeCall, toolDefinitions } from "./tools.mjs";

let projectDir;
let calls;
let toolbox;

/** A cadgen that records each call, "builds" by exit code, and "renders" by writing the PNG. */
function fakeCadgen(code = 0) {
  return async (tool, args, options) => {
    calls.push({ tool, args, cwd: options.cwd });
    if (tool === "cadgen" && code === 0) fs.writeFileSync(path.join(options.cwd, args[3]), Buffer.from("png"));
    return { code, output: code === 0 ? "[cadgen] wrote STEP: STEP/model.step\n" : "Traceback: boom\n", timedOut: false };
  };
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-tools-"));
  calls = [];
  toolbox = createToolbox({ projectDir, runCadgen: fakeCadgen(), readReference: (name) => (name === "kinematics.md" ? "# Kinematics" : null) });
});
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

test("Claude writes Python under src/ and checks/ only", async () => {
  assert.equal((await toolbox.run("write_file", { path: "src/model.py", content: "x = 1\n" })).isError, undefined);
  assert.equal(fs.readFileSync(path.join(projectDir, "src/model.py"), "utf8"), "x = 1\n");
  assert.equal((await toolbox.run("write_file", { path: "checks/fit.py", content: "" })).isError, undefined);
  for (const target of ["../model.py", "src/../../x.py", "model.py", "src/notes.txt", "project.json", "/tmp/x.py"]) {
    assert.equal((await toolbox.run("write_file", { path: target, content: "" })).isError, true, target);
  }
  // Eager input streaming hands the input over unvalidated: a truncated one is refused.
  assert.equal((await toolbox.run("write_file", { path: "src/model.py" })).isError, true);
  assert.equal((await toolbox.run("write_file", "not an object")).isError, true);
});

test("a build runs the script with cadgen's python from the project root", async () => {
  await toolbox.run("write_file", { path: "src/model.py", content: "" });
  const result = await toolbox.run("run_python", { path: "src/model.py" });
  assert.deepEqual(calls, [{ tool: "python", args: ["src/model.py"], cwd: projectDir }]);
  assert.equal(result.built, true);
  assert.match(result.content, /^exit code 0\n/u);
  assert.equal((await toolbox.run("run_python", { path: "src/missing.py" })).isError, true);

  const failing = createToolbox({ projectDir, runCadgen: fakeCadgen(1), readReference: () => null });
  const failed = await failing.run("run_python", { path: "src/model.py" });
  assert.equal(failed.isError, true);
  assert.equal(failed.built, false);
  assert.match(failed.content, /Traceback: boom/u);
});

test("a snapshot renders the saved file and returns the image to Claude", async () => {
  fs.mkdirSync(path.join(projectDir, "STEP"));
  fs.writeFileSync(path.join(projectDir, "STEP/model.step"), "");
  const result = await toolbox.run("snapshot", { path: "STEP/model.step", camera: "top", display: "xray" });
  assert.deepEqual(calls[0].args, ["step", "snapshot", "STEP/model.step", "tmp/snapshot-1.png", "--camera", "top", "--width", "800", "--height", "600", "--json", "--display", "xray"]);
  assert.equal(result.content[1].type, "image");
  assert.equal(Buffer.from(result.content[1].source.data, "base64").toString(), "png");
  assert.equal(fs.existsSync(path.join(projectDir, "tmp/snapshot-1.png")), false);

  assert.equal((await toolbox.run("snapshot", { path: "STEP/model.step", camera: "30:20" })).isError, undefined);
  assert.equal((await toolbox.run("snapshot", { path: "STEP/model.step", camera: "--evil" })).isError, true);
  assert.equal((await toolbox.run("snapshot", { path: "STEP/model.step", display: "nope" })).isError, true);
  assert.equal((await toolbox.run("snapshot", { path: "src/model.py" })).isError, true);
  assert.equal((await toolbox.run("snapshot", { path: "STEP/missing.step" })).isError, true);
});

test("references, listings and labels", async () => {
  assert.equal((await toolbox.run("read_reference", { name: "kinematics.md" })).content, "# Kinematics");
  assert.equal((await toolbox.run("read_reference", { name: "../SKILL.md" })).isError, true);
  assert.equal((await toolbox.run("list_files", {})).content, "The project is empty.");
  assert.equal((await toolbox.run("read_file", { path: "project.json" })).isError, true);
  assert.equal((await toolbox.run("nope", {})).isError, true);
  assert.equal(describeCall("run_python", { path: "src/model.py" }), "Built src/model.py");
  assert.deepEqual(toolDefinitions(["kinematics.md"]).map((tool) => tool.name),
    ["write_file", "read_file", "list_files", "run_python", "snapshot", "read_reference"]);
});
