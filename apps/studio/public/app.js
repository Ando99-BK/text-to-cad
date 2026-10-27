// The studio's page: a conversation on the left, the CAD Viewer on the right. It talks only to
// its own server, whose state-changing routes want the `x-studio` header (src/server.mjs).

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const projectsSelect = $("projects");

let project = null;
let config = { viewer: "starting" };
let run = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", "x-studio": "1", ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `The studio answered ${response.status}.`);
  }
  return response;
}

const getJson = async (path) => (await api(path)).json();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

/** One reply of Claude's: its tool-call labels, a live progress line, then its text. */
function replyView() {
  const root = element("div", "message assistant");
  const steps = element("ul", "steps");
  const progress = element("div", "progress");
  const text = element("div", "reply-text");
  root.append(steps, progress, text);
  log.append(root);
  const items = new Map();
  return {
    step(label, id, state = "ok") {
      const item = element("li", state, label);
      if (id) items.set(id, item);
      steps.append(item);
    },
    settle(id, ok) {
      const item = items.get(id);
      if (item) item.className = ok ? "ok" : "fail";
    },
    progress(delta) { progress.textContent = (progress.textContent + delta).split("\n").filter(Boolean).at(-1) ?? ""; },
    text(delta) { progress.textContent = ""; text.textContent += delta; },
    finish() { progress.remove(); },
  };
}

function renderTranscript() {
  log.replaceChildren();
  if (!project || !project.transcript.length) {
    log.append($("empty-chat").content.cloneNode(true));
    for (const example of log.querySelectorAll(".examples button")) {
      example.addEventListener("click", () => { input.value = example.textContent; input.focus(); });
    }
    return;
  }
  for (const entry of project.transcript) {
    if (entry.role === "user") {
      log.append(element("div", "message user", entry.text));
      continue;
    }
    const reply = replyView();
    for (const label of entry.steps) reply.step(label);
    reply.text(entry.text);
    reply.finish();
  }
  scrollToEnd();
}

/** The newest file of each format, and the viewer on the newest STEP. */
function renderStage() {
  const outputs = project?.outputs ?? [];
  const newest = (kind) => outputs.find((output) => output.kind === kind);
  const downloads = $("downloads");
  downloads.replaceChildren();
  for (const [kind, label] of [["step", "STEP"], ["stl", "STL"], ["3mf", "3MF"], ["glb", "GLB"]]) {
    const output = newest(kind);
    if (!output) continue;
    const link = element("a", "", `Download ${label}`);
    link.href = output.download;
    link.download = "";
    downloads.append(link);
  }
  const shown = newest("step") ?? newest("stl") ?? newest("3mf");
  $("file-name").textContent = shown ? shown.path : "No model yet";
  const viewer = $("viewer");
  const empty = $("stage-empty");
  if (shown?.view) {
    // The viewer reloads a file a build rewrites on its own: set the page only when it changes.
    if (viewer.dataset.view !== shown.view) {
      viewer.src = shown.view;
      viewer.dataset.view = shown.view;
    }
    viewer.hidden = false;
    empty.hidden = true;
    return;
  }
  viewer.hidden = true;
  empty.hidden = false;
  if (shown && config.viewer === "starting") empty.textContent = "The CAD Viewer is starting (the first start downloads it)…";
  else if (shown && config.viewer === "failed") empty.textContent = `The CAD Viewer could not start: ${config.viewerError}. The files can still be downloaded above.`;
  else empty.textContent = "Your model appears here once it is built.";
}

async function renderProjects() {
  const { projects } = await getJson("/api/projects");
  projectsSelect.replaceChildren();
  if (!project) projectsSelect.append(new Option("New model", "", true, true));
  for (const item of projects) projectsSelect.append(new Option(item.title, item.id, false, item.id === project?.id));
  // Nothing to pick until a model exists.
  projectsSelect.hidden = !projects.length;
}

async function open(id) {
  project = id ? await getJson(`/api/projects/${id}`) : null;
  history.replaceState(null, "", id ? `#${id}` : location.pathname);
  renderTranscript();
  renderStage();
  await renderProjects();
}

async function refresh() {
  if (!project) return;
  project = await getJson(`/api/projects/${project.id}`);
  renderStage();
}

function setRunning(active) {
  $("send").disabled = active;
  $("stop").hidden = !active;
  projectsSelect.disabled = active;
  $("new").disabled = active;
  $("status").textContent = active ? "Working…" : "";
}

async function send(text) {
  if (!project) project = await (await api("/api/projects", { method: "POST" })).json();
  history.replaceState(null, "", `#${project.id}`);
  if (!project.transcript.length) log.replaceChildren();
  log.append(element("div", "message user", text));
  const reply = replyView();
  scrollToEnd();
  run = new AbortController();
  setRunning(true);
  try {
    const response = await api(`/api/projects/${project.id}/messages`, { method: "POST", body: JSON.stringify({ text }), signal: run.signal });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) if (line) handle(JSON.parse(line), reply);
      scrollToEnd();
    }
  } catch (error) {
    if (error.name !== "AbortError") log.append(element("div", "message error", error.message));
  } finally {
    reply.finish();
    run = null;
    setRunning(false);
    // The chat on screen already shows the run, errors included: refresh only the files.
    await refresh().catch(() => {});
    await renderProjects().catch(() => {});
  }
}

function handle(event, reply) {
  switch (event.type) {
    case "text": reply.text(event.delta); break;
    case "progress": reply.progress(event.delta); break;
    case "tool": reply.step(event.label, event.id, "pending"); break;
    case "tool_result": reply.settle(event.id, event.ok); break;
    case "built": refresh().catch(() => {}); break;
    case "notice": log.append(element("div", "message notice", event.text)); break;
    case "error": log.append(element("div", "message error", event.message)); break;
    case "project": project = event.project; break;
  }
}

async function watchViewer() {
  while (config.viewer === "starting") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    config = await getJson("/api/config").catch(() => config);
  }
  await refresh().catch(() => {});
  renderStage();
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || run) return;
  input.value = "";
  send(text);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("composer").requestSubmit();
});
$("stop").addEventListener("click", () => run?.abort());
$("new").addEventListener("click", () => open(null));
projectsSelect.addEventListener("change", () => open(projectsSelect.value || null));

config = await getJson("/api/config").catch(() => config);
await open(location.hash.slice(1) || null).catch(() => open(null));
watchViewer();
