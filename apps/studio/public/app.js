// The studio's page: a conversation on the left, the CAD Viewer on the right. It talks only to
// its own server, whose state-changing routes want the `x-studio` header (src/server.mjs).

import { pickLocale, stepText, strings } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const projectsSelect = $("projects");
const locale = pickLocale(navigator.languages ?? [navigator.language]);
const words = strings(locale);
const EXAMPLE_ICONS = ["i-stand", "i-box", "i-pipe", "i-gear"];

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

/** One of the page's own icons (index.html's symbols). */
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

function spinner() {
  return element("span", "spinner");
}

function translatePage() {
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = words[node.dataset.i18n];
  input.placeholder = words.placeholder;
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

function errorView(message) {
  const node = element("div", "message error");
  node.append(icon("i-x"), element("span", "", message));
  return node;
}

/** One reply of Claude's: its steps, a live progress line, then its text as Markdown. */
function replyView({ live = false } = {}) {
  const root = element("div", "message assistant");
  const avatar = element("div", "avatar");
  avatar.append(icon("i-sparkle"));
  const body = element("div", "assistant-body");
  const steps = element("ul", "steps");
  const progress = element("div", "progress");
  const text = element("div", "reply-text");
  body.append(steps, progress, text);
  root.append(avatar, body);
  log.append(root);
  let markdown = "";
  let thinking = "";
  const items = new Map();
  const waiting = () => {
    const dots = element("span", "typing");
    dots.append(element("i"), element("i"), element("i"));
    progress.replaceChildren(dots);
  };
  if (live) waiting();

  function stepItem(step, state) {
    const item = element("li", state);
    item.append(state === "pending" ? spinner() : icon(state === "fail" ? "i-x" : "i-check"), element("span", "", stepText(words, step, state === "pending")));
    return item;
  }

  return {
    step(step, id, state = "ok") {
      const item = stepItem(step, state);
      if (id) items.set(id, { item, step });
      steps.append(item);
      progress.replaceChildren();
    },
    settle(id, ok) {
      const entry = items.get(id);
      if (entry) entry.item.replaceWith(entry.item = stepItem(entry.step, ok ? "ok" : "fail"));
      if (live) waiting();
    },
    progress(delta) {
      // Claude's short notes between tool calls: the latest line, as it is written.
      thinking = (thinking + delta).split("\n").filter(Boolean).at(-1) ?? "";
      progress.replaceChildren(spinner(), element("span", "", thinking));
    },
    text(delta) {
      progress.replaceChildren();
      markdown += delta;
      text.replaceChildren(...renderMarkdown(document, markdown));
    },
    finish() { progress.remove(); },
  };
}

function exampleButton([title, prompt], index) {
  const button = element("button", "example");
  button.type = "button";
  const badge = element("span", "example-icon");
  badge.append(icon(EXAMPLE_ICONS[index % EXAMPLE_ICONS.length]));
  const label = element("span");
  label.append(element("b", "", title), element("span", "example-text", prompt));
  button.append(badge, label);
  button.addEventListener("click", () => {
    input.value = prompt;
    autosize();
    input.focus();
  });
  return button;
}

function renderTranscript() {
  log.replaceChildren();
  if (!project || !project.transcript.length) {
    log.append($("empty-chat").content.cloneNode(true));
    for (const node of log.querySelectorAll("[data-i18n]")) node.textContent = words[node.dataset.i18n];
    log.querySelector(".examples").append(...words.examples.map(exampleButton));
    return;
  }
  for (const entry of project.transcript) {
    if (entry.role === "user") {
      log.append(element("div", "message user", entry.text));
      continue;
    }
    const reply = replyView();
    for (const step of entry.steps) reply.step(step);
    reply.text(entry.text);
    reply.finish();
  }
  scrollToEnd();
}

/** The newest file of each format as a download, and the viewer on the newest model. */
function renderStage() {
  const outputs = project?.outputs ?? [];
  const newest = (kind) => outputs.find((output) => output.kind === kind);
  const downloads = $("downloads");
  downloads.replaceChildren();
  for (const [kind, label] of [["step", "STEP"], ["stl", "STL"], ["3mf", "3MF"], ["glb", "GLB"]]) {
    const output = newest(kind);
    if (!output) continue;
    const link = element("a");
    link.href = output.download;
    link.download = "";
    link.title = `${words.download} ${output.path}`;
    link.append(icon("i-download"), element("span", "", label));
    downloads.append(link);
  }
  const shown = newest("step") ?? newest("stl") ?? newest("3mf") ?? newest("glb");
  const kind = $("file-kind");
  kind.hidden = !shown;
  kind.textContent = shown?.kind.toUpperCase() ?? "";
  $("file-name").textContent = shown ? shown.path : words.noModel;

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
  $("stage-title").textContent = words.stageEmptyTitle;
  if (shown && config.viewer === "starting") $("stage-text").textContent = words.viewerStarting;
  else if (shown && config.viewer === "failed") $("stage-text").textContent = words.viewerFailed(config.viewerError);
  else $("stage-text").textContent = words.stageEmpty;
}

async function renderProjects() {
  const { projects } = await getJson("/api/projects");
  projectsSelect.replaceChildren();
  if (!project) projectsSelect.append(new Option(words.newModel, "", true, true));
  for (const item of projects) projectsSelect.append(new Option(item.title, item.id, false, item.id === project?.id));
  // Nothing to pick until a model exists.
  projectsSelect.closest(".picker").hidden = !projects.length;
}

async function open(id) {
  project = id ? await getJson(`/api/projects/${id}`) : null;
  history.replaceState(null, "", id ? `#${id}` : location.pathname);
  renderTranscript();
  renderStage();
  await renderProjects();
  input.focus();
}

async function refresh() {
  if (!project) return;
  project = await getJson(`/api/projects/${project.id}`);
  renderStage();
}

function setRunning(active) {
  $("send").hidden = active;
  $("stop").hidden = !active;
  projectsSelect.disabled = active;
  $("new").disabled = active;
  const status = $("status");
  status.replaceChildren(...(active ? [spinner(), element("span", "", words.working)] : []));
  if (!active) $("building").hidden = true;
}

async function send(text) {
  if (!project) project = await (await api("/api/projects", { method: "POST" })).json();
  history.replaceState(null, "", `#${project.id}`);
  if (!project.transcript.length) log.replaceChildren();
  log.append(element("div", "message user", text));
  const reply = replyView({ live: true });
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
    if (error.name === "AbortError") log.append(element("div", "message notice", words.stopped));
    else log.append(errorView(error.message));
  } finally {
    reply.finish();
    run = null;
    setRunning(false);
    // The chat on screen already shows the run, errors included: refresh only the files.
    await refresh().catch(() => {});
    await renderProjects().catch(() => {});
    scrollToEnd();
  }
}

const building = new Set();

function handle(event, reply) {
  switch (event.type) {
    case "text": reply.text(event.delta); break;
    case "progress": reply.progress(event.delta); break;
    case "tool":
      reply.step(event.step, event.id, "pending");
      if (event.step?.action === "build") building.add(event.id);
      $("building").hidden = !building.size;
      break;
    case "tool_result":
      reply.settle(event.id, event.ok);
      building.delete(event.id);
      $("building").hidden = !building.size;
      break;
    case "built": refresh().catch(() => {}); break;
    case "notice": log.append(element("div", "message notice", event.text)); break;
    case "error": log.append(errorView(event.message)); break;
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

/** The box grows with what is typed, up to its CSS max-height. */
function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || run) return;
  input.value = "";
  autosize();
  send(text);
});
input.addEventListener("input", autosize);
input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter is a new line. An input method composing a word (Vietnamese
  // Telex, for one) owns Enter until the word is done.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("stop").addEventListener("click", () => run?.abort());
$("new").addEventListener("click", () => open(null));
projectsSelect.addEventListener("change", () => open(projectsSelect.value || null));
// A link to another model (`#<id>`) opens it; the page's own replaceState fires no event.
window.addEventListener("hashchange", () => { if (!run) open(location.hash.slice(1) || null).catch(() => open(null)); });

translatePage();
config = await getJson("/api/config").catch(() => config);
await open(location.hash.slice(1) || null).catch(() => open(null));
watchViewer();
