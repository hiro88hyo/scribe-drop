import { describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "./service-worker-registration.js";

describe("service worker registration", () => {
  it("registers the same-origin worker without using HTTP cache updates", async () => {
    const register = vi.fn(() => Promise.resolve({}));

    await expect(registerServiceWorker({ register })).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("is a safe no-op when unsupported or registration fails", async () => {
    await expect(registerServiceWorker(undefined)).resolves.toBe(false);
    await expect(
      registerServiceWorker({
        register: () => Promise.reject(new Error("private browser detail")),
      }),
    ).resolves.toBe(false);
  });
});
