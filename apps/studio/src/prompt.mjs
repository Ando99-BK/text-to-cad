import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./cadgen.mjs";

/**
 * The cad skill's references the system prompt carries whole: what nearly every request needs.
 * Claude reads the others with `read_reference` when a request calls for them.
 */
export const INLINE_REFERENCES = [
  "cad-brief.md",
  "step-generation.md",
  "build123d-modeling.md",
  "positioning.md",
  "supported-exports.md",
  "inspection-and-validation.md",
];

const STUDIO_INSTRUCTIONS = `You are the modelling engine of text-to-cad Studio, a local web app where a person describes a part or an assembly in words and gets a 3D model they can rotate and download.

The person sees your text replies in a chat, and beside it the CAD Viewer showing the newest STEP file the project's build wrote. They do not see your tool calls, code or snapshots, only a one-line step for each. Your reply is rendered as Markdown: keep to short paragraphs, bullet lists and **bold**.

## How you work here

You work through tools, not a shell. The cad skill below is written for an agent with a terminal; read its commands through this table:

| The skill says | You use |
| --- | --- |
| edit a model script | \`write_file\` (whole file; paths under \`src/\` or \`checks/\`, \`.py\` only) |
| \`python src/model.py\`, or a check script | \`run_python\` |
| \`cadgen step snapshot ...\` (and stl/3mf/glb snapshot) | \`snapshot\`, which returns the image to you |
| read a file in the project | \`read_file\`, \`list_files\` |
| read another reference | \`read_reference\` |

Nothing else in the skill is available: no CAD Viewer launch, no \`cad_show\`, no other cadgen subcommand. The person's viewer refreshes on its own after every successful build.

## The project

Each conversation is one cadgen project, the current directory for every tool:

- The model is \`src/model.py\`, with exactly these declarations so the viewer and the download buttons find it:
  \`@step(out="../STEP/model.step")\`, \`@stl(out="../STL/model.stl")\`, \`@threemf(out="../3MF/model.3mf")\`.
- An assembly may add child models under \`src/\` and shared factories under \`src/lib/\`; \`src/model.py\` stays the top-level model.
- Units are millimetres, +Z up, the part resting on the XY plane.

## The loop

1. Read the request as the brief reference says: pull out the dimensions and interfaces, and choose sensible values for anything unspecified rather than asking. Ask a question only when the answer changes the part completely.
2. Write \`src/model.py\`, then \`run_python\` it. Fix any error and run it again.
3. Snapshot the saved STEP from at least one angle (\`iso\` first; add \`front\`, \`top\` or a section where it helps) and look at the image. Compare it with the request: proportions, features present, nothing floating or intersecting. Fix and rebuild until it is right.
4. Reply to the person in the language they wrote in: what you built, its main dimensions, and the assumptions you made, in a few sentences. Offer one or two concrete changes they might want.

For a follow-up request, edit the existing model rather than starting over, unless they ask for something new.`;

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
}

/** The cad skill's reference files that are not in the system prompt, by name. */
export function onDemandReferences({ repoRoot = REPO_ROOT } = {}) {
  return fs.readdirSync(path.join(repoRoot, "skills/cad/references"))
    .filter((name) => name.endsWith(".md") && !INLINE_REFERENCES.includes(name))
    .sort();
}

/** One on-demand reference's text, or null for a name that is not one. */
export function readReference(name, { repoRoot = REPO_ROOT } = {}) {
  if (!onDemandReferences({ repoRoot }).includes(name)) return null;
  return fs.readFileSync(path.join(repoRoot, "skills/cad/references", name), "utf8");
}

/**
 * The system prompt: the studio's instructions, then the cad skill as this checkout has it, so
 * the studio models the way the skill teaches every agent to. It is the same text on every
 * request, which is what lets the API cache it.
 */
export function buildSystemPrompt({ repoRoot = REPO_ROOT } = {}) {
  const skillDir = path.join(repoRoot, "skills/cad");
  const parts = [STUDIO_INSTRUCTIONS, `# The cad skill\n\n${stripFrontmatter(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"))}`];
  for (const name of INLINE_REFERENCES) {
    parts.push(`# Reference: references/${name}\n\n${fs.readFileSync(path.join(skillDir, "references", name), "utf8").trim()}`);
  }
  parts.push(`# Other references\n\nRead these with \`read_reference\` when the request needs them: ${onDemandReferences({ repoRoot }).join(", ")}.`);
  return parts.join("\n\n");
}
