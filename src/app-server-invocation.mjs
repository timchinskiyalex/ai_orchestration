// Long-running JSON-RPC uses cmd.exe on Windows: the PowerShell npm shim can
// consume stdout instead of forwarding the App Server protocol stream.
export function appServerInvocation({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") return { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "codex app-server"] };
  return { command: "codex", args: ["app-server"] };
}
