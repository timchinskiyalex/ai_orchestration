import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_BYTES = 16_384;

function boundedAppend(current, chunk, limit) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  return `${current}${text}`.slice(-limit);
}

export class ManagedProcessError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ManagedProcessError";
    Object.assign(this, details);
  }
}

// Windows only guarantees descendant termination through taskkill /T. This
// helper deliberately uses spawn with fixed arguments (never a shell string).
export function terminateProcessTree({ pid, platform = process.platform, spawnProcess = spawn, child = null, graceMs = 1_500 } = {}) {
  if (!Number.isInteger(pid) || pid < 1) return Promise.resolve({ attempted: false, reason: "invalid_pid" });
  if (platform !== "win32") {
    try { child?.kill?.("SIGKILL"); } catch { /* process may have exited */ }
    return Promise.resolve({ attempted: true, command: "SIGKILL" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    let killer;
    try {
      killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
      killer.once("error", (error) => finish({ attempted: true, command: "taskkill", error: String(error.message) }));
      killer.once("close", (code, signal) => finish({ attempted: true, command: "taskkill", code, signal }));
    } catch (error) { finish({ attempted: true, command: "taskkill", error: String(error.message) }); return; }
    setTimeout(() => {
      try { killer.kill("SIGKILL"); } catch { /* bounded best effort */ }
      finish({ attempted: true, command: "taskkill", timedOut: true });
    }, graceMs).unref?.();
  });
}

export function runManagedProcess({ executable, args = [], cwd, timeoutMs = 120_000, windowsHide = true, maxOutputBytes = DEFAULT_OUTPUT_BYTES, spawnProcess = spawn, platform = process.platform, terminate = terminateProcessTree } = {}) {
  if (typeof executable !== "string" || !executable) throw new Error("Managed process requires an executable");
  if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error("Managed process args must be a string array");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Managed process timeoutMs must be a positive integer");
  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    const details = () => ({ executable, args: [...args], cwd: cwd ?? null, pid: child?.pid ?? null, stdout, stderr, timedOut });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    try {
      child = spawnProcess(executable, args, { cwd, windowsHide, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(reject, new ManagedProcessError(`Could not start ${executable}: ${error.message}`, { ...details(), cause: error }));
      return;
    }
    child.stdout?.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk, maxOutputBytes); });
    child.stderr?.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk, maxOutputBytes); });
    child.once("error", (error) => finish(reject, new ManagedProcessError(`Process error: ${executable}: ${error.message}`, { ...details(), cause: error })));
    child.once("close", (code, signal) => {
      if (timedOut) return;
      const result = { ...details(), code, signal };
      if (code === 0) finish(resolve, result);
      else finish(reject, new ManagedProcessError(`Process failed: ${executable} (code ${code ?? "none"}, signal ${signal ?? "none"})`, result));
    });
    timer = setTimeout(() => {
      timedOut = true;
      // Starting taskkill is synchronous from the controller's perspective;
      // never wait for a stubborn descendant to emit close before releasing the
      // scheduler. Its eventual result is retained on the error object.
      const termination = { attempted: true, requested: true, command: platform === "win32" ? "taskkill" : "SIGKILL" };
      Promise.resolve(terminate({ pid: child.pid, platform, spawnProcess, child }))
        .then((result) => { termination.result = result; })
        .catch((error) => { termination.error = String(error.message); });
      // Do not await the original child close event: a process tree can retain
      // inherited handles after timeout. The controller is now free to recover.
      try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); } catch { /* best effort */ }
      finish(reject, new ManagedProcessError(`Process timed out after ${timeoutMs}ms: ${executable}`, { ...details(), timeoutMs, termination }));
    }, timeoutMs);
  });
}
