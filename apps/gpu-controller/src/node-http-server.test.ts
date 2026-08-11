import { describe, expect, it } from "vitest";

import { createControllerFetchRequest } from "./node-http-server.js";

describe("Node controller HTTP transport", () => {
  it("uses a fixed authority while preserving the exact origin-form target and duplicate headers", async () => {
    const request = createControllerFetchRequest({
      body: new TextEncoder().encode('{"test":true}'),
      headers: [
        ["content-type", "application/json"],
        ["x-test", "first"],
        ["x-test", "second"],
      ],
      method: "post",
      target: "/v1/executions?invalid=query",
    });

    expect(request.url).toBe("https://controller.invalid/v1/executions?invalid=query");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-test")).toBe("first, second");
    await expect(request.text()).resolves.toBe('{"test":true}');
  });

  it("replaces absolute-form, authority-form, and oversized targets before dispatch", () => {
    for (const target of [
      "https://attacker.example/v1/executions",
      "//attacker.example/v1/executions",
      `/${"x".repeat(2_048)}`,
      `/${"あ".repeat(700)}`,
    ]) {
      expect(
        createControllerFetchRequest({ body: new Uint8Array(), headers: [], method: "GET", target })
          .url,
      ).toBe("https://controller.invalid/__invalid_controller_target__");
    }
  });
});
