import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";

// Existing transport fixtures remain deterministic transports.  Controller
// flow tests cross the same public provider envelope boundary as production.
export const provider = (client) => new AppServerExecutionProvider({ client });
