import { createControllerProcess } from "./process.js";

const writeLog = (line: string): void => {
  process.stdout.write(line);
};

try {
  const processRuntime = createControllerProcess(process.env, writeLog);
  processRuntime.server.on("error", () => {
    writeLog('{"event":"controller_process_failed","level":"error"}\n');
    processRuntime.server.closeAllConnections();
    process.exitCode = 1;
  });
  processRuntime.server.listen(processRuntime.port, "0.0.0.0", () => {
    writeLog('{"event":"controller_process_ready","level":"info"}\n');
  });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    processRuntime.server.close(() => {
      process.exitCode = 0;
    });
    processRuntime.server.closeIdleConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  writeLog('{"event":"controller_process_failed","level":"error"}\n');
  process.exitCode = 1;
}
