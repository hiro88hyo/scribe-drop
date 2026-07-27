import { expect, test } from "@playwright/test";

import { installMockBackend } from "./mock-backend.js";

test("supports keyboard navigation and desktop drag-and-drop", async ({ page }) => {
  await installMockBackend(page);
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "メインコンテンツへ移動" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["dummy audio"], "desktop-drop.mp3", {
        type: "audio/mpeg",
      }),
    );
    return transfer;
  });
  await page.locator(".upload-card").dispatchEvent("drop", { dataTransfer });
  await expect(page.getByText(/desktop-drop\.mp3/u)).toBeVisible();
});

test.describe("Android-equivalent viewport", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 915, width: 412 },
  });

  test("opens the file chooser without horizontal overflow", async ({ page }) => {
    await installMockBackend(page);
    await page.goto("/");

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "ファイルを選択" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      buffer: Buffer.from("dummy mobile audio"),
      mimeType: "audio/mp4a-latm",
      name: "android-choice.m4a",
    });

    await expect(page.getByText(/android-choice\.m4a/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "アップロードを開始" })).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});
