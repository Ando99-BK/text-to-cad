import fs from "node:fs";
import path from "node:path";

import { tail } from "./cadgen.mjs";
import { listFiles, resolveInside } from "./projects.mjs";

const WRITABLE = ["src/", "checks/"];
const CAMERAS = ["iso", "front", "back", "left", "right", "top", "bottom"];
const DISPLAYS = ["solid", "shaded", "parts", "xray", "hidden-line", "wireframe"];
const SNAPSHOT_FORMATS = { ".step": "step", ".stp": "step", ".stl": "stl", ".3mf": "3mf", ".glb": "glb" };
const MAX_WRITE = 512 * 1024;
const MAX_READ = 200 * 1024;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;

/** The tools Claude has, as the Messages API takes them. */
export function toolDefinitions(references) {
  return [
    {
      name: "write_file",
      description: "Write a whole text file in the project, replacing it if it exists. Only .py files under src/ or checks/.",
      // A model script can be long: stream it as it is written (validated before it runs).
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path, e.g. src/model.py" },
          content: { type: "string", description: "The full file contents" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description: "Read a text file in the project.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Project-relative path" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "list_files",
      description: "List every file in the project (model scripts and the outputs builds wrote).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "run_python",
      description: "Run a Python script under src/ or checks/ with cadgen's interpreter, from the project root, and return its exit code and output. Running a model script builds it and writes its declared outputs.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Project-relative script path, e.g. src/model.py" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "snapshot",
      description: "Render a saved STEP, STL, 3MF or GLB file to an image and return it, to check the model visually.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path of the saved file, e.g. STEP/model.step" },
          camera: { type: "string", description: `A preset (${CAMERAS.join(", ")}) or "azimuth:elevation" in degrees. Default iso.` },
          display: { type: "string", enum: DISPLAYS, description: "Display mode. Default solid; modes other than solid need a STEP file." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "read_reference",
      description: "Read one of the cad skill's references that is not in your instructions.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", enum: references } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
}

const STEP_ACTIONS = { write_file: "write", read_file: "read", list_files: "list", run_python: "build", snapshot: "look", read_reference: "reference" };

/**
 * What a tool call did, for the person's chat, without its contents: an action the page words
 * in the person's language, and the file or reference it was about.
 */
export function describeStep(name, input) {
  const target = typeof input?.path === "string" ? input.path : typeof input?.name === "string" ? input.name : "";
  const step = { action: STEP_ACTIONS[name] ?? "other", target: STEP_ACTIONS[name] ? target : name };
  if (name === "snapshot" && typeof input?.camera === "string") step.view = input.camera;
  return step;
}

const error = (message) => ({ content: message, isError: true });
const isString = (value) => typeof value === "string";

/**
 * Runs Claude's tool calls against one project. Every input is checked here: with eager input
 * streaming the API no longer validates it, and a path is untrusted output either way.
 * `runCadgen(tool, args, options)` runs a cadgen tool (`createCadgenRunner`).
 */
export function createToolbox({ projectDir, runCadgen, readReference, signal }) {
  let snapshots = 0;

  function scriptPath(relative) {
    if (!isString(relative) || !relative.endsWith(".py") || !WRITABLE.some((prefix) => relative.startsWith(prefix))) return null;
    return resolveInside(projectDir, relative);
  }

  const handlers = {
    write_file({ path: relative, content }) {
      if (!isString(content)) return error("write_file needs `content`, the whole file as a string.");
      const target = scriptPath(relative);
      if (!target) return error(`Cannot write ${JSON.stringify(relative)}: only .py files under ${WRITABLE.join(" or ")}.`);
      if (Buffer.byteLength(content) > MAX_WRITE) return error("The file is too large (512 KiB at most).");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return { content: `Wrote ${relative} (${content.split("\n").length} lines).` };
    },

    read_file({ path: relative }) {
      const target = resolveInside(projectDir, relative);
      if (!target || relative === "project.json") return error(`No readable file at ${JSON.stringify(relative)}.`);
      let stat;
      try { stat = fs.statSync(target); } catch { return error(`${relative} does not exist.`); }
      if (!stat.isFile()) return error(`${relative} is not a file.`);
      const text = fs.readFileSync(target, "utf8");
      return { content: stat.size > MAX_READ ? `${text.slice(0, MAX_READ)}\n[... cut at ${MAX_READ} bytes of ${stat.size} ...]` : text };
    },

    list_files() {
      const files = listFiles(projectDir);
      return { content: files.length ? files.join("\n") : "The project is empty." };
    },

    async run_python({ path: relative }) {
      const target = scriptPath(relative);
      if (!target || !fs.existsSync(target)) return error(`No script at ${JSON.stringify(relative)} (a .py file under ${WRITABLE.join(" or ")}).`);
      const result = await runCadgen("python", [relative], { cwd: projectDir, timeoutMs: BUILD_TIMEOUT_MS, signal });
      const status = result.timedOut ? "timed out after 10 minutes" : `exit code ${result.code}`;
      return { content: `${status}\n${tail(result.output, 20_000)}`, isError: result.code !== 0, built: result.code === 0 };
    },

    async snapshot({ path: relative, camera = "iso", display }) {
      const target = resolveInside(projectDir, relative);
      const format = isString(relative) && SNAPSHOT_FORMATS[path.extname(relative).toLowerCase()];
      if (!target || !format || !fs.existsSync(target)) return error(`No saved STEP, STL, 3MF or GLB file at ${JSON.stringify(relative)}; build the model first.`);
      if (!isString(camera) || !(CAMERAS.includes(camera) || /^-?\d+(\.\d+)?:-?\d+(\.\d+)?$/u.test(camera))) {
        return error(`camera must be one of ${CAMERAS.join(", ")} or "azimuth:elevation".`);
      }
      if (display !== undefined && !DISPLAYS.includes(display)) return error(`display must be one of ${DISPLAYS.join(", ")}.`);
      const out = `tmp/snapshot-${++snapshots}.png`;
      fs.mkdirSync(path.join(projectDir, "tmp"), { recursive: true });
      const args = [format, "snapshot", relative, out, "--camera", camera, "--width", "800", "--height", "600", "--json"];
      if (display) args.push("--display", display);
      const result = await runCadgen("cadgen", args, { cwd: projectDir, timeoutMs: SNAPSHOT_TIMEOUT_MS, signal });
      const image = path.join(projectDir, out);
      if (result.code !== 0 || !fs.existsSync(image)) return error(`The snapshot failed (exit code ${result.code}).\n${tail(result.output, 8_000)}`);
      const data = fs.readFileSync(image).toString("base64");
      fs.rmSync(image, { force: true });
      return {
        content: [
          { type: "text", text: `${relative}, camera ${camera}${display ? `, ${display}` : ""}:` },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
        ],
      };
    },

    read_reference({ name }) {
      const text = isString(name) ? readReference(name) : null;
      return text === null ? error(`No reference named ${JSON.stringify(name)}.`) : { content: text };
    },
  };

  return {
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) return error(`There is no tool named ${name}.`);
      if (input === null || typeof input !== "object" || Array.isArray(input)) return error(`${name} needs a JSON object.`);
      try {
        return await handler(input);
      } catch (cause) {
        return error(`${name} failed: ${cause.message}`);
      }
    },
  };
}
