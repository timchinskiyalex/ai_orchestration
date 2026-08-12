export const RUNTIME_GIT_IDENTITY = Object.freeze({
  name: "Codex Swarm Runtime",
  email: "codex-swarm-runtime@localhost"
});

export function runtimeGitIdentityArgs(identity = RUNTIME_GIT_IDENTITY) {
  if (!identity || typeof identity.name !== "string" || !identity.name.trim() || typeof identity.email !== "string" || !identity.email.trim()) throw new Error("Runtime Git identity requires non-empty name and email");
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
