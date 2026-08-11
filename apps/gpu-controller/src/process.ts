import type { Server } from "node:http";

import { createGoogleFirestoreControlDatabase } from "./firestore-control-store.js";
import { GoogleAdcAccessTokenProvider } from "./google-runtime-auth.js";
import type { ControllerLogRecord, ControllerLogSink } from "./http-handler.js";
import { createNodeControllerServer } from "./node-http-server.js";
import { parseControllerProcessEnvironment } from "./process-configuration.js";
import { createControllerRuntimeHandler } from "./runtime.js";

export interface ControllerProcess {
  readonly port: number;
  readonly server: Server;
}

export class JsonControllerLogSink implements ControllerLogSink {
  readonly #write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.#write = write;
  }

  emit(record: ControllerLogRecord): void {
    this.#write(`${JSON.stringify(record)}\n`);
  }
}

export function createControllerProcess(
  environment: NodeJS.ProcessEnv,
  writeLog: (line: string) => void,
): ControllerProcess {
  const configuration = parseControllerProcessEnvironment(environment);
  const handler = createControllerRuntimeHandler(configuration.runtime, {
    clock: { now: () => new Date() },
    database: createGoogleFirestoreControlDatabase(configuration.runtime.firestore),
    keys: configuration.keys,
    logger: new JsonControllerLogSink(writeLog),
    tokens: new GoogleAdcAccessTokenProvider(),
  });
  return {
    port: configuration.port,
    server: createNodeControllerServer(handler),
  };
}
