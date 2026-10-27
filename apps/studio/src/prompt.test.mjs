import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { launchCommand, REPO_ROOT } from "./cadgen.mjs";
import { buildSystemPrompt, INLINE_REFERENCES, onDemandReferences, readReference } from "./prompt.mjs";

test("the system prompt carries the cad skill as this checkout has it", () => {
  const prompt = buildSystemPrompt();
  const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/cad/SKILL.md"), "utf8");
  assert.match(prompt, /^You are the modelling engine of text-to-cad Studio/u);
  assert.ok(prompt.includes(skill.split("\n---\n")[1].trim().slice(0, 200)));
  assert.ok(!prompt.includes("\nname: cad\n"), "the skill's frontmatter is left out");
  for (const name of INLINE_REFERENCES) assert.ok(prompt.includes(`# Reference: references/${name}`), name);
  assert.equal(buildSystemPrompt(), prompt, "the same text every time, so it caches");
});

test("every other reference can be read on demand, and nothing else can", () => {
  const others = onDemandReferences();
  assert.ok(others.length > 0);
  assert.equal(others.some((name) => INLINE_REFERENCES.includes(name)), false);
  assert.ok(readReference(others[0]).length > 0);
  assert.equal(readReference(INLINE_REFERENCES[0]), null);
  assert.equal(readReference("../SKILL.md"), null);
});

test("cadgen runs as the one launch command, pinned to VERSION", () => {
  const version = fs.readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
  assert.deepEqual(launchCommand("python", { env: {} }), {
    command: "uvx",
    args: ["--no-config", "--managed-python", "--python", "3.13", "--from", `cadgen==${version}`, "python"],
  });
  assert.equal(launchCommand("cadgen", { env: { STUDIO_CADGEN_FROM: "./packages/cadgen" } }).args.at(-2), "./packages/cadgen");
});
