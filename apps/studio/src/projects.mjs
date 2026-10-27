import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = /^[a-z0-9]+-[a-f0-9]{6}$/;
/** The folders a model's declared outputs land in, and the only ones the studio serves. */
export const OUTPUT_DIRS = ["STEP", "STL", "3MF", "GLB"];
const OUTPUT_KINDS = { ".step": "step", ".stp": "step", ".stl": "stl", ".3mf": "3mf", ".glb": "glb" };

/**
 * `relative` resolved inside `root`, or null when it is absolute or climbs out. Lexical: the
 * routes that serve files also compare real paths, since a model's own code can make links.
 */
export function resolveInside(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  const rest = path.relative(root, target);
  if (!rest || rest === ".." || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)) return null;
  return target;
}

function walk(dir, visit, prefix = "") {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), visit, relative);
    else if (entry.isFile()) visit(relative, path.join(dir, entry.name));
  }
}

/**
 * The projects on disk, one folder each under `root`: `project.json` (title and the whole
 * conversation with Claude, in Messages API form) beside an ordinary cadgen project — `src/`
 * for model scripts, one folder per output format, `tmp/` for snapshots.
 */
export function createProjectStore(root, { now = () => new Date() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = (id) => path.join(root, id);
  const recordPath = (id) => path.join(dir(id), "project.json");

  function get(id) {
    if (typeof id !== "string" || !ID.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(recordPath(id), "utf8")); } catch { return null; }
  }

  function save(record) {
    record.updated = now().toISOString();
    const file = recordPath(record.id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
  }

  function create(title = "Untitled model") {
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    fs.mkdirSync(path.join(dir(id), "src"), { recursive: true });
    const created = now().toISOString();
    const record = { id, title, created, updated: created, messages: [] };
    save(record);
    return record;
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(root); } catch { /* empty */ }
    return names.map(get).filter(Boolean)
      .map(({ id, title, updated }) => ({ id, title, updated }))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Every file a build wrote, newest first, by its project-relative path. */
  function outputs(id) {
    const files = [];
    for (const folder of OUTPUT_DIRS) {
      walk(path.join(dir(id), folder), (relative, absolute) => {
        const kind = OUTPUT_KINDS[path.extname(relative).toLowerCase()];
        if (kind) files.push({ path: `${folder}/${relative}`, absolute, kind, modified: fs.statSync(absolute).mtimeMs });
      });
    }
    return files.sort((a, b) => b.modified - a.modified);
  }

  /** An output file's absolute path for download, or null for anything else in the project. */
  function outputFile(id, relative) {
    const base = dir(id);
    const target = resolveInside(base, relative);
    if (!target || !OUTPUT_DIRS.includes(path.relative(base, target).split(path.sep)[0])) return null;
    try {
      const realBase = fs.realpathSync(base);
      const real = fs.realpathSync(target);
      return resolveInside(realBase, path.relative(realBase, real)) && fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  return { root, dir, get, save, create, list, outputs, outputFile };
}

/** A project's files as a listing for Claude, without the snapshot scratch folder. */
export function listFiles(projectDir) {
  const files = [];
  walk(projectDir, (relative) => {
    if (relative === "project.json" || relative.startsWith("tmp/") || relative.includes("__pycache__/")) return;
    files.push(relative);
  });
  return files;
}
