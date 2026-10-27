import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * cadgen's one launch command (AGENTS.md: `uvx --no-config --managed-python --python 3.13
 * --from cadgen==<VERSION> <tool>`), pinned to this checkout's VERSION so the studio shares
 * one installation, and so one warm build daemon, with the plugin and the skills.
 * `STUDIO_CADGEN_FROM` replaces the requirement (a local wheel, or `./packages/cadgen` to run
 * this checkout's source).
 */
export function launchCommand(tool, { env = process.env, repoRoot = REPO_ROOT } = {}) {
  const from = env.STUDIO_CADGEN_FROM || `cadgen==${fs.readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim()}`;
  return { command: "uvx", args: ["--no-config", "--managed-python", "--python", "3.13", "--from", from, tool] };
}

/** Keep the tail of a long output: the end of a build log is where its error is. */
export function tail(text, limit) {
  return text.length <= limit ? text : `[... ${text.length - limit} earlier characters cut ...]\n${text.slice(-limit)}`;
}

/**
 * Run a command to completion: its exit code and its stdout and stderr interleaved, as a
 * person would read them in a terminal. A timeout or an abort ends the whole process group,
 * since uvx starts the interpreter as a child of its own.
 */
export function runProcess(command, args, { cwd, timeoutMs = 600_000, signal, env = process.env, outputLimit = 400_000 } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const group = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, detached: group, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => { output = tail(output + chunk, outputLimit); };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const stop = () => {
      try { group ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${error.message}\n`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, output, timedOut });
    });
  });
}

/** Run one cadgen tool (`python`, `cadgen`) through the launch command. */
export function createCadgenRunner({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  return (tool, args, options = {}) => {
    const launch = launchCommand(tool, { env, repoRoot });
    return runProcess(launch.command, [...launch.args, ...args], { env, ...options });
  };
}
