import { existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

export function codexCliInvocation({ platform = process.platform, env = process.env, fileExists = existsSync } = {}) {
  if (platform !== "win32") return { command: "codex", prefixArgs: [] };
  const pathApi = process.platform === "win32" ? { delimiter, join } : win32;
  const directories = [
    env.APPDATA ? pathApi.join(env.APPDATA, "npm") : null,
    ...(env.PATH ?? "").split(pathApi.delimiter)
  ].filter(Boolean);
  const script = directories.map((directory) => pathApi.join(directory, "codex.ps1")).find(fileExists);
  if (!script) throw new Error("Codex CLI PowerShell shim (codex.ps1) was not found on PATH or under APPDATA\\npm");
  return {
    command: env.SystemRoot ? pathApi.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe",
    prefixArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
  };
}
