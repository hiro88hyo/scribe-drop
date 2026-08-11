import { describe, expect, it } from "vitest";

import {
  verifyControllerContainerFilesystem,
  verifyControllerContainerRuntime,
} from "./container-invariants.js";

const expected = {
  gid: 10_001,
  home: "/nonexistent",
  nodeEnvironment: "production",
  nodeVersion: "v24.18.0",
  uid: 10_001,
} as const;

describe("GPU controller container invariants", () => {
  it("accepts only the fixed non-root Node runtime", () => {
    expect(() => {
      verifyControllerContainerRuntime(expected);
    }).not.toThrow();
    expect(() => {
      verifyControllerContainerRuntime({ ...expected, uid: 0 });
    }).toThrow();
    expect(() => {
      verifyControllerContainerRuntime({ ...expected, nodeVersion: "v24.19.0" });
    }).toThrow();
    expect(() => {
      verifyControllerContainerRuntime({ ...expected, home: "/root" });
    }).toThrow();
  });

  it("accepts only the production runtime filesystem", () => {
    const filesystem = {
      busyboxShell: false,
      controllerEntrypoint: true,
      contractsRuntime: true,
      controllerSourceTree: false,
      domainRuntime: true,
      entrypointDeclaration: false,
      entrypointSourceMap: false,
      firestoreRuntime: true,
      googleAuthRuntime: true,
      nodeTypes: false,
      npm: false,
      pnpm: false,
      shell: false,
      typescript: false,
      zodRuntime: true,
    } as const;
    expect(() => {
      verifyControllerContainerFilesystem(filesystem);
    }).not.toThrow();
    expect(() => {
      verifyControllerContainerFilesystem({ ...filesystem, shell: true });
    }).toThrow();
    expect(() => {
      verifyControllerContainerFilesystem({ ...filesystem, firestoreRuntime: false });
    }).toThrow();
    expect(() => {
      verifyControllerContainerFilesystem({ ...filesystem, entrypointSourceMap: true });
    }).toThrow();
  });
});
