import { expect, test } from "@playwright/test";

import { JOB_ID, PRIVATE_MARKER, installMockBackend } from "./mock-backend.js";

test.use({ serviceWorkers: "allow" });

test("caches only reviewed public shell assets", async ({ page }) => {
  await installMockBackend(page, {
    detailStatuses: ["COMPLETED"],
    listPrivateMarker: true,
  });
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

  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole("button", { name: "Markdownをブラウザで確認" }).click();
  const previewDialog = page.getByRole("dialog", { name: "Markdownをブラウザで確認" });
  await expect(previewDialog.locator("pre")).toBeVisible();
  expect(
    await page.evaluate(
      () => !document.documentElement.outerHTML.includes(".r2.cloudflarestorage.com"),
    ),
  ).toBe(true);
  const previewPersistenceAbsent = await page.evaluate(async () => {
    const marker = "Dummy E2E artifact";
    const webStorageValues = [localStorage, sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) =>
        storage.getItem(storage.key(index) ?? ""),
      ),
    );
    const databases = await indexedDB.databases();
    const indexedDbValues: unknown[] = [];
    for (const databaseInfo of databases) {
      const databaseName = databaseInfo.name;
      if (databaseName !== "scribe-drop") {
        continue;
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.addEventListener(
          "success",
          () => {
            resolve(request.result);
          },
          { once: true },
        );
        request.addEventListener(
          "error",
          () => {
            reject(new Error("IndexedDB read failed"));
          },
          { once: true },
        );
      });
      try {
        if (database.objectStoreNames.contains("upload-checkpoints")) {
          const transaction = database.transaction("upload-checkpoints", "readonly");
          indexedDbValues.push(
            ...(await new Promise<unknown[]>((resolve, reject) => {
              const request = transaction.objectStore("upload-checkpoints").getAll();
              request.addEventListener(
                "success",
                () => {
                  resolve(request.result);
                },
                { once: true },
              );
              request.addEventListener(
                "error",
                () => {
                  reject(new Error("IndexedDB read failed"));
                },
                { once: true },
              );
            })),
          );
        }
      } finally {
        database.close();
      }
    }
    return ![...webStorageValues, ...indexedDbValues].some((value) =>
      JSON.stringify(value).includes(marker),
    );
  });
  expect(previewPersistenceAbsent).toBe(true);
  await page.keyboard.press("Escape");

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
    expect(cached.body).not.toContain("Dummy E2E artifact");
  }
});
