# text-to-cad Studio

A local web app: describe a part in words, in any language, and get a 3D model you
can rotate and download as STEP, STL or 3MF. Claude writes the build123d model the
way the [cad skill](../../skills/cad/SKILL.md) teaches, cadgen builds it, Claude
snapshots and checks it, and the page shows it in the CAD Viewer beside the
conversation. Ask for a change and Claude edits the same model.

There is no hosted deployment. The studio runs on your machine and runs the code
Claude writes there, the same way an agent with the cad skill does.

## Run it

You need [uv](https://docs.astral.sh/uv/), Node 20 or newer, and Anthropic API
credentials (`ANTHROPIC_API_KEY`, or a profile from `ant auth login`). From the
repository root:

```bash
npm ci
export ANTHROPIC_API_KEY=...
npm run studio
# open http://127.0.0.1:4317/
```

The first start downloads cadgen and the CAD Viewer, and the first snapshot downloads
its headless browser, so it needs the network once.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4317` | the studio's port, on 127.0.0.1 |
| `STUDIO_DATA_DIR` | `~/.text-to-cad-studio` | where projects live, one folder each |
| `STUDIO_MODEL` | `claude-opus-5-5` | the Claude model |
| `STUDIO_EFFORT` | `high` | `low` to `max`: more is slower and costs more, and models better |
| `STUDIO_CADGEN_FROM` | `cadgen==<VERSION>` | the cadgen requirement uvx installs; `./packages/cadgen` runs this checkout's source |

Each project is an ordinary cadgen project (`src/model.py`, `STEP/`, `STL/`, `3MF/`)
beside `project.json`, which keeps the conversation. You can open it in any agent
with the cad skill and keep going.

## How it works

```text
public/              the page: plain HTML, CSS and modules, no build
  app.js             the conversation, the stage and the downloads
  markdown.js        Claude's replies, parsed to runs the page turns into DOM nodes
  i18n.js            the page's words in English and Vietnamese, by the browser's language
src/server.mjs       HTTP routes, the request guard, startup
src/agent.mjs        one turn of the conversation: Claude's tool calls until it answers
src/tools.mjs        the tools Claude has, and their input checks
src/prompt.mjs       the system prompt: the studio's instructions and the cad skill
src/projects.mjs     projects on disk, and which of their files may be served
src/cadgen.mjs       cadgen's launch command, and running it
src/viewer.mjs       the studio's own CAD Viewer
```

A message starts a turn (`POST /api/projects/:id/messages`). The server calls the
Messages API with the conversation, streams Claude's text and progress notes back to
the page as NDJSON, runs each tool call, and repeats until Claude answers without
one. Claude's tools are `write_file` (Python under `src/` or `checks/`),
`run_python` (cadgen's interpreter: running a model builds it), `snapshot` (renders
a saved file and returns the image), `read_file`, `list_files` and `read_reference`.
The page shows the newest STEP in an iframe of a CAD Viewer the studio starts
(`cadgen viewer --new`), which reloads the file when a build rewrites it.

## The laws

- **The cad skill is the modelling manual.** The system prompt is `skills/cad` as
  this checkout has it, read at startup. Teach the skill and the studio learns it;
  never fork modelling guidance into the studio. Its prompt only maps the skill's
  commands to the studio's tools.
- **One cadgen.** cadgen runs as the repository's one launch command, pinned to
  `VERSION` (`src/cadgen.mjs`), so the studio shares its installation and warm
  daemon with the plugin and the skills. The studio never imports or vendors cadgen.
- **Nothing on the web may drive it.** It listens on 127.0.0.1 only, refuses a
  non-loopback Host (DNS rebinding) and a foreign Origin, and every request that
  changes something needs the `x-studio` header, which a cross-origin page cannot send
  without a preflight the studio never answers (`allowed` in `src/server.mjs`).
- **Every tool input is untrusted.** Tool inputs stream unvalidated (eager input
  streaming), so `src/tools.mjs` checks each one: types, paths kept inside the
  project, writes only to Python under `src/` and `checks/`, snapshot flags from fixed
  lists. Downloads serve only the output folders, by real path.
- **The conversation is append-only.** `project.json` holds the Messages API
  history as sent, thinking blocks included, and is saved after every complete round.
  Tool calls left unanswered by a stop are answered with cancellations, never
  removed, since editing an earlier turn invalidates the thinking after it.
- **The viewer is cadgen's.** The studio embeds the CAD Viewer in an iframe and adds
  nothing to it. A feature the viewer should have belongs in `packages/ui` and
  `apps/web`, where every host gets it.

## Testing

```bash
npm --prefix apps/studio test
```

The tests use a fake Claude client and a fake cadgen: tool input checks, the tool
loop and its stop reasons, the request guard, a whole turn over HTTP down to the
download, and the page's Markdown parsing and step wording. CI runs them in the
`studio` job (`scripts/test/test-studio.sh`). A real build and a real Claude are
checked by hand.
