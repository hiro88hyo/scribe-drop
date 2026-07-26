import { expect, test } from "@playwright/test";

import { PRIVATE_MARKER, installMockBackend } from "./mock-backend.js";

test.use({ serviceWorkers: "allow" });

test("caches only reviewed public shell assets", async ({ page }) => {
  await installMockBackend(page, { listPrivateMarker: true });
  await page.goto("/");

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === null) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            resolve();
          },
          {
            once: true,
          },
        );
      });
    }
  });
  await page.reload();
  await expect(page.getByText(PRIVATE_MARKER)).toBeVisible();

  const cachedResponses = await page.evaluate(async () => {
    const entries: { body: string; pathname: string }[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({
          body: response === undefined ? "" : await response.clone().text(),
          pathname: new URL(request.url).pathname,
        });
      }
    }
    return entries;
  });

  expect(cachedResponses.length).toBeGreaterThan(0);
  for (const cached of cachedResponses) {
    expect(cached.pathname).toMatch(
      /^\/(?:assets\/|manifest\.webmanifest$|offline\.(?:css|html)$|pwa-(?:192|512)\.png$|scribe-drop\.svg$)/u,
    );
    expect(cached.pathname).not.toMatch(/^\/api(?:\/|$)/u);
    expect(cached.pathname).not.toContain("/artifacts/");
    expect(cached.body).not.toContain(PRIVATE_MARKER);
  }
});
