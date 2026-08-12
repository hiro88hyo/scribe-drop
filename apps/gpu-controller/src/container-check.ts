import { existsSync } from "node:fs";
import process from "node:process";

import {
  verifyControllerContainerFilesystem,
  verifyControllerContainerRuntime,
} from "./container-invariants.js";

try {
  verifyControllerContainerRuntime({
    gid: process.getgid?.() ?? -1,
    home: process.env["HOME"],
    nodeEnvironment: process.env["NODE_ENV"],
    nodeVersion: process.version,
    uid: process.getuid?.() ?? -1,
  });
  verifyControllerContainerFilesystem({
    busyboxShell: existsSync("/busybox/sh"),
    controllerEntrypoint: existsSync("/app/dist/entrypoint.js"),
    contractsRuntime: existsSync("/app/node_modules/@scribe-drop/contracts/dist/index.js"),
    controllerSourceTree: existsSync("/app/src"),
    domainRuntime: existsSync("/app/node_modules/@scribe-drop/domain/dist/index.js"),
    entrypointDeclaration: existsSync("/app/dist/entrypoint.d.ts"),
    entrypointSourceMap: existsSync("/app/dist/entrypoint.js.map"),
    firestoreRuntime: existsSync("/app/node_modules/@google-cloud/firestore/package.json"),
    googleAuthRuntime: existsSync("/app/node_modules/google-auth-library/package.json"),
    nodeTypes: existsSync("/app/node_modules/@types/node"),
    npm: existsSync("/usr/bin/npm") || existsSync("/usr/local/bin/npm"),
    pnpm: existsSync("/usr/bin/pnpm") || existsSync("/usr/local/bin/pnpm"),
    shell: existsSync("/bin/sh"),
    typescript: existsSync("/app/node_modules/typescript"),
    zodRuntime: existsSync("/app/node_modules/zod/package.json"),
  });
  process.stdout.write('{"event":"controller_container_check","outcome":"accepted"}\n');
} catch {
  process.stdout.write('{"event":"controller_container_check","outcome":"rejected"}\n');
  process.exitCode = 1;
}
