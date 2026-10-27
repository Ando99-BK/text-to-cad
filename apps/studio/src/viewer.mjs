import { spawn } from "node:child_process";

import { launchCommand } from "./cadgen.mjs";

/** The first line of `stream` that parses as a JSON object. */
export function readFirstJsonLine(stream, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    const onData = (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try { finish(null, JSON.parse(line)); return; } catch { /* not a JSON line */ }
      }
    };
    const onEnd = () => finish(new Error("it exited before announcing its address"));
    function finish(error, value) {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      error ? reject(error) : resolve(value);
    }
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

/**
 * Start a CAD Viewer of the studio's own (`cadgen viewer --new`): a port nothing else reuses, a
 * server that lives as long as the studio. It shows any file by its absolute path, and reloads
 * a file when a build rewrites it. The first start downloads cadgen, so it may take minutes.
 */
export async function startViewer({ cwd, env = process.env, timeoutMs = 300_000 }) {
  const launch = launchCommand("cadgen", { env });
  const child = spawn(launch.command, [...launch.args, "viewer", "--host", "127.0.0.1", "--new", "--json"], {
    cwd, env, stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.once("exit", stop);
  // A signal listener replaces Node's own exit on that signal, so exit after stopping.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); process.exit(130); });
  try {
    const announced = await readFirstJsonLine(child.stdout, { timeoutMs });
    // Keep reading so a chatty server never blocks on a full pipe.
    child.stdout.resume();
    return { url: String(announced.url || "").replace(/\/+$/u, ""), stop };
  } catch (cause) {
    stop();
    throw new Error(`The CAD Viewer did not start: ${cause.message}.`);
  }
}

/** The viewer page for one file. */
export function viewerLink(viewerUrl, absolutePath) {
  return `${viewerUrl}/?file=${encodeURIComponent(absolutePath)}`;
}
