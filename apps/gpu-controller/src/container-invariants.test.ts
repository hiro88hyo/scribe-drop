import { describe, expect, it } from "vitest";

import {
  inspectControllerSharedObjects,
  verifyControllerContainerFilesystem,
  verifyControllerContainerRuntime,
} from "./container-invariants.js";

const expected = {
  gid: 10_001,
  home: "/nonexistent",
  nodeEnvironment: "production",
  nodeVersion: "v24.18.0",
  operatingSystemLibsslLoaded: false,
  sharedObjectReportAvailable: true,
  uid: 10_001,
} as const;

describe("GPU controller container invariants", () => {
  it("fails closed unless the process report proves OS libssl is not loaded", () => {
    expect(
      inspectControllerSharedObjects({ sharedObjects: ["/lib/x86_64-linux-gnu/libc.so.6"] }),
    ).toEqual({
      operatingSystemLibsslLoaded: false,
      sharedObjectReportAvailable: true,
    });
    expect(
      inspectControllerSharedObjects({
        sharedObjects: ["/lib/x86_64-linux-gnu/libssl.so.3"],
      }),
    ).toEqual({
      operatingSystemLibsslLoaded: true,
      sharedObjectReportAvailable: true,
    });
    expect(inspectControllerSharedObjects({ sharedObjects: "unavailable" })).toEqual({
      operatingSystemLibsslLoaded: true,
      sharedObjectReportAvailable: false,
    });
  });

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
    expect(() => {
      verifyControllerContainerRuntime({ ...expected, operatingSystemLibsslLoaded: true });
    }).toThrow();
    expect(() => {
      verifyControllerContainerRuntime({ ...expected, sharedObjectReportAvailable: false });
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
