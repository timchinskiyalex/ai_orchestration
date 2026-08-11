import { isAbsolute, resolve } from "node:path";
import { cleanupDisposableRoot, isDisposableE2eRoot } from "../src/e2e-smoke.mjs";

const args = process.argv.slice(2);
const index = args.indexOf("--recovery-root");
const target = index === -1 ? null : args[index + 1];
if (!target || !isAbsolute(target)) {
  console.error("Provide an explicit absolute --recovery-root path.");
  process.exitCode = 1;
} else if (!isDisposableE2eRoot(resolve(target))) {
  console.error("Refusing cleanup: path is not a direct orchestration-real-e2e-* directory under the system temporary directory.");
  process.exitCode = 1;
} else {
  cleanupDisposableRoot(resolve(target));
  console.log(`Removed disposable E2E recovery root: ${resolve(target)}`);
}
