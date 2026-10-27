import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_MODEL, repairHistory, runTurn, transcript } from "./agent.mjs";
import { createCadgenRunner } from "./cadgen.mjs";
import { createProjectStore } from "./projects.mjs";
import { buildSystemPrompt, onDemandReferences, readReference } from "./prompt.mjs";
import { createToolbox, toolDefinitions } from "./tools.mjs";
import { startViewer, viewerLink } from "./viewer.mjs";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const STATIC = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"] };
const DOWNLOAD_TYPES = { step: "application/step", stl: "model/stl", "3mf": "model/3mf", glb: "model/gltf-binary" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 64 * 1024;

function hostName(value) {
  return String(value || "").replace(/:\d+$/u, "").toLowerCase();
}

/**
 * Whether a request may reach the studio. The studio runs code Claude writes, so a web page in
 * the person's browser must never drive it: the Host must be a loopback name (no DNS
 * rebinding), a browser's Origin must be the studio itself, and every request that changes
 * something carries a custom header, which a cross-origin page cannot send without a preflight
 * the studio never answers.
 */
export function allowed(request) {
  const host = request.headers.host;
  if (!LOOPBACK.has(hostName(host))) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return request.method === "GET" || request.headers["x-studio"] === "1";
}

function send(response, status, body, type = "application/json") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(data);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("The request is too large.");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** A message from an API failure the person can act on. */
function describeFailure(cause) {
  if (cause instanceof Anthropic.AuthenticationError) return "The Anthropic API key was refused. Check ANTHROPIC_API_KEY and restart the studio.";
  if (cause instanceof Anthropic.RateLimitError) return "The Anthropic API is rate limiting this key. Wait a moment and send again.";
  if (cause instanceof Anthropic.APIError && cause.status) return `The Anthropic API answered ${cause.status}: ${cause.message}`;
  if (cause instanceof Anthropic.APIError) return `Could not reach the Anthropic API: ${cause.message}`;
  if (/api key|apiKey|authToken|credentials/iu.test(cause?.message ?? "")) {
    return "No Anthropic credentials: set ANTHROPIC_API_KEY (or run `ant auth login`) and restart the studio.";
  }
  return cause?.message ?? String(cause);
}

/**
 * The studio's HTTP server. Everything it needs comes in, so tests can hand it a fake Claude
 * client and a fake cadgen.
 */
export function createStudio({ store, createClient, runCadgen, system, tools, viewer, model = DEFAULT_MODEL, effort = "high" }) {
  const running = new Map();
  let client = null;

  function projectView(record) {
    const outputs = store.outputs(record.id).map(({ path: relative, absolute, kind }) => ({
      path: relative, kind, download: `/api/projects/${record.id}/files/${relative}`,
      ...(viewer.url ? { view: viewerLink(viewer.url, absolute) } : {}),
    }));
    return { id: record.id, title: record.title, transcript: transcript(record.messages), outputs, running: running.has(record.id) };
  }

  async function converse(request, response, record) {
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return send(response, 400, { error: "Write what to model." });
    if (running.has(record.id)) return send(response, 409, { error: "This model is still working on the last message." });

    const controller = new AbortController();
    running.set(record.id, controller);
    // The run ends when the person closes the page or presses Stop (both close this response).
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    const emit = (event) => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };

    repairHistory(record.messages);
    if (!record.messages.length) record.title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
    record.messages.push({ role: "user", content: text });
    store.save(record);
    try {
      client ??= createClient();
      await runTurn({
        client, model, effort, system, tools, messages: record.messages,
        toolbox: createToolbox({ projectDir: store.dir(record.id), runCadgen, readReference, signal: controller.signal }),
        persist: () => store.save(record),
        onEvent: emit,
        signal: controller.signal,
      });
    } catch (cause) {
      if (!controller.signal.aborted) emit({ type: "error", message: describeFailure(cause) });
    } finally {
      running.delete(record.id);
      store.save(record);
      emit({ type: "project", project: projectView(record) });
      response.end();
    }
  }

  async function route(request, response) {
    if (!allowed(request)) return send(response, 403, { error: "Forbidden." });
    const url = new URL(request.url, "http://studio.invalid");
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(response, 200, fs.readFileSync(path.join(PUBLIC, file)), `${type}; charset=utf-8`);
    }
    if (parts[0] !== "api") return send(response, 404, { error: "Not found." });

    if (parts[1] === "config" && request.method === "GET") {
      return send(response, 200, { model, viewer: viewer.url ? "ready" : viewer.error ? "failed" : "starting", viewerError: viewer.error ?? null });
    }
    if (parts[1] !== "projects") return send(response, 404, { error: "Not found." });
    if (parts.length === 2 && request.method === "GET") return send(response, 200, { projects: store.list() });
    if (parts.length === 2 && request.method === "POST") return send(response, 201, projectView(store.create()));

    const record = store.get(parts[2]);
    if (!record) return send(response, 404, { error: "No such model." });
    if (parts.length === 3 && request.method === "GET") return send(response, 200, projectView(record));
    if (parts.length === 4 && parts[3] === "messages" && request.method === "POST") return converse(request, response, record);
    if (parts[3] === "files" && request.method === "GET") {
      const relative = parts.slice(4).map(decodeURIComponent).join("/");
      const file = store.outputFile(record.id, relative);
      if (!file) return send(response, 404, { error: "No such file." });
      const kind = store.outputs(record.id).find((output) => output.absolute === file)?.kind;
      response.writeHead(200, {
        "content-type": DOWNLOAD_TYPES[kind] ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${path.basename(file).replace(/["\\]/gu, "_")}"`,
        "cache-control": "no-store",
      });
      return fs.createReadStream(file).pipe(response);
    }
    return send(response, 404, { error: "Not found." });
  }

  return http.createServer((request, response) => {
    route(request, response).catch((cause) => {
      if (!response.headersSent) send(response, 500, { error: cause.message });
      else response.end();
    });
  });
}

async function main() {
  const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), ".text-to-cad-studio"));
  const port = Number(process.env.PORT || 4317);
  const store = createProjectStore(path.join(dataDir, "projects"));
  const viewer = { url: null, error: null };
  const server = createStudio({
    store,
    viewer,
    createClient: () => new Anthropic(),
    runCadgen: createCadgenRunner(),
    system: buildSystemPrompt(),
    tools: toolDefinitions(onDemandReferences()),
    model: process.env.STUDIO_MODEL || DEFAULT_MODEL,
    effort: process.env.STUDIO_EFFORT || "high",
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`text-to-cad Studio: http://127.0.0.1:${port}/ (models in ${store.root})`);
  });
  // The viewer starts beside the studio; until it answers, the page shows downloads alone.
  startViewer({ cwd: dataDir }).then((started) => {
    viewer.url = started.url;
    console.log(`CAD Viewer: ${started.url}`);
  }, (cause) => {
    viewer.error = cause.message;
    console.error(cause.message);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
