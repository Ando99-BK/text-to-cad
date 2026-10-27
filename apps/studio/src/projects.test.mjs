import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { createProjectStore, listFiles, resolveInside } from "./projects.mjs";

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-projects-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test("a path resolves only inside its root", () => {
  assert.equal(resolveInside(root, "src/model.py"), path.join(root, "src/model.py"));
  for (const escape of ["../x.py", "src/../../x.py", "/etc/passwd", "", ".", "a\0b", 42]) {
    assert.equal(resolveInside(root, escape), null, String(escape));
  }
});

test("a project keeps its conversation, and the list is newest first", () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const store = createProjectStore(root, { now: () => new Date(clock += 1000) });
  const first = store.create("First");
  const second = store.create("Second");
  second.messages.push({ role: "user", content: "a bracket" });
  store.save(second);
  assert.deepEqual(store.get(second.id).messages, [{ role: "user", content: "a bracket" }]);
  assert.deepEqual(store.list().map((item) => item.id), [second.id, first.id]);
  assert.ok(fs.statSync(path.join(store.dir(first.id), "src")).isDirectory());
  assert.equal(store.get("../escape"), null);
  assert.equal(store.get("nothing-000000"), null);
});

test("only build outputs are served, and never through a link that leaves the project", () => {
  const store = createProjectStore(root);
  const { id } = store.create();
  const dir = store.dir(id);
  fs.mkdirSync(path.join(dir, "STEP"));
  fs.mkdirSync(path.join(dir, "STL"));
  fs.writeFileSync(path.join(dir, "STEP/model.step"), "ISO-10303-21;");
  fs.writeFileSync(path.join(dir, "STL/model.stl"), "solid");
  fs.writeFileSync(path.join(dir, "src/model.py"), "print()");
  const outside = path.join(root, "secret.step");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(dir, "STEP/link.step"));

  // A link is never listed, and never served.
  assert.deepEqual(store.outputs(id).map((output) => output.path).sort(), ["STEP/model.step", "STL/model.stl"]);
  assert.equal(store.outputFile(id, "STEP/model.step"), fs.realpathSync(path.join(dir, "STEP/model.step")));
  assert.equal(store.outputFile(id, "src/model.py"), null);
  assert.equal(store.outputFile(id, "project.json"), null);
  assert.equal(store.outputFile(id, "STEP/../src/model.py"), null);
  assert.equal(store.outputFile(id, "STEP/link.step"), null);
  assert.deepEqual(listFiles(dir), ["STEP/model.step", "STL/model.stl", "src/model.py"]);
});
