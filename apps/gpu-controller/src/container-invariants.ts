import { z } from "zod";

const controllerContainerRuntimeSchema = z
  .object({
    gid: z.literal(10_001),
    home: z.literal("/nonexistent"),
    nodeEnvironment: z.literal("production"),
    nodeVersion: z.literal("v24.18.0"),
    operatingSystemLibsslLoaded: z.literal(false),
    sharedObjectReportAvailable: z.literal(true),
    uid: z.literal(10_001),
  })
  .strict();

export interface ControllerContainerRuntime {
  readonly gid: number;
  readonly home: string | undefined;
  readonly nodeEnvironment: string | undefined;
  readonly nodeVersion: string;
  readonly operatingSystemLibsslLoaded: boolean;
  readonly sharedObjectReportAvailable: boolean;
  readonly uid: number;
}

export interface ControllerSharedObjectState {
  readonly operatingSystemLibsslLoaded: boolean;
  readonly sharedObjectReportAvailable: boolean;
}

const processReportSchema = z.object({
  sharedObjects: z.array(z.string()),
});

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

export function inspectControllerSharedObjects(input: unknown): ControllerSharedObjectState {
  const result = processReportSchema.safeParse(input);
  if (!result.success) {
    return {
      operatingSystemLibsslLoaded: true,
      sharedObjectReportAvailable: false,
    };
  }
  return {
    operatingSystemLibsslLoaded: result.data.sharedObjects.some((sharedObject) =>
      /(?:^|\/)libssl\.so(?:\.|$)/u.test(sharedObject),
    ),
    sharedObjectReportAvailable: true,
  };
}

export function verifyControllerContainerFilesystem(input: ControllerContainerFilesystem): void {
  controllerContainerFilesystemSchema.parse(input);
}
