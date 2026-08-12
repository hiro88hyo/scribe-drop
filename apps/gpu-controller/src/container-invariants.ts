import { z } from "zod";

const controllerContainerRuntimeSchema = z
  .object({
    gid: z.literal(10_001),
    home: z.literal("/nonexistent"),
    nodeEnvironment: z.literal("production"),
    nodeVersion: z.literal("v24.18.0"),
    uid: z.literal(10_001),
  })
  .strict();

export interface ControllerContainerRuntime {
  readonly gid: number;
  readonly home: string | undefined;
  readonly nodeEnvironment: string | undefined;
  readonly nodeVersion: string;
  readonly uid: number;
}

const controllerContainerFilesystemSchema = z
  .object({
    busyboxShell: z.literal(false),
    controllerEntrypoint: z.literal(true),
    contractsRuntime: z.literal(true),
    controllerSourceTree: z.literal(false),
    domainRuntime: z.literal(true),
    entrypointDeclaration: z.literal(false),
    entrypointSourceMap: z.literal(false),
    firestoreRuntime: z.literal(true),
    googleAuthRuntime: z.literal(true),
    nodeTypes: z.literal(false),
    npm: z.literal(false),
    pnpm: z.literal(false),
    shell: z.literal(false),
    typescript: z.literal(false),
    zodRuntime: z.literal(true),
  })
  .strict();

export interface ControllerContainerFilesystem {
  readonly busyboxShell: boolean;
  readonly controllerEntrypoint: boolean;
  readonly contractsRuntime: boolean;
  readonly controllerSourceTree: boolean;
  readonly domainRuntime: boolean;
  readonly entrypointDeclaration: boolean;
  readonly entrypointSourceMap: boolean;
  readonly firestoreRuntime: boolean;
  readonly googleAuthRuntime: boolean;
  readonly nodeTypes: boolean;
  readonly npm: boolean;
  readonly pnpm: boolean;
  readonly shell: boolean;
  readonly typescript: boolean;
  readonly zodRuntime: boolean;
}

export function verifyControllerContainerRuntime(input: ControllerContainerRuntime): void {
  controllerContainerRuntimeSchema.parse(input);
}

export function verifyControllerContainerFilesystem(input: ControllerContainerFilesystem): void {
  controllerContainerFilesystemSchema.parse(input);
}
