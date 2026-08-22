import { expect, test } from "@playwright/test";

import { JOB_ID, installMockBackend } from "./mock-backend.js";

test("recovers from a network failure and completes the authenticated job lifecycle", async ({
  page,
}) => {
  const backend = await installMockBackend(page, {
    failFirstCreate: true,
    uploadPartDelayMilliseconds: 400,
  });
  await page.clock.install();
  await page.goto("/");

  await expect(page.getByText("e2e-user@example.com")).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from("dummy audio"),
    mimeType: "audio/mpeg",
    name: "meeting.mp3",
  });
  await page.getByRole("button", { name: "アップロードを開始" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "サーバーで問題が発生しました。時間をおいて再試行してください。",
  );
  await page.getByRole("button", { name: "再試行" }).click();

  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByText("アップロードを受け付けました。")).toBeVisible();
  expect(backend.createAttempts).toBe(2);
  expect(backend.uploadPartObserved).toBe(true);
  expect(backend.multipartCompleted).toBe(true);

  await page.getByRole("link", { name: "ジョブ詳細を確認" }).click();
  await expect(page.getByText("処理待ち", { exact: true }).first()).toBeVisible();

  await page.clock.fastForward(5_000);
  await expect(page.getByText("文字起こし中", { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(5_000);
  await expect(page.getByText("完了", { exact: true }).first()).toBeVisible();

  const previewTrigger = page.getByRole("button", { name: "Markdownをブラウザで確認" });
  await previewTrigger.click();
  const previewDialog = page.getByRole("dialog", { name: "Markdownをブラウザで確認" });
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.locator("pre")).toHaveText("# Dummy E2E artifact");
  await page.keyboard.press("Shift+Tab");
  expect(await previewDialog.evaluate((element) => element.contains(document.activeElement))).toBe(
    true,
  );

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value: string) {
          const bytes = new TextEncoder().encode(value);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          Reflect.set(
            window,
            "copiedArtifactDigest",
            Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
              "",
            ),
          );
        },
      },
    });
  });
  await previewDialog.getByRole("button", { name: "クリップボードにコピー" }).click();
  await expect(previewDialog.getByText("コピーしました。")).toBeVisible();
  const previewDigest = await previewDialog.locator("pre").evaluate(async (element) => {
    const bytes = new TextEncoder().encode(element.textContent);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
  await expect
    .poll(() => page.evaluate((): unknown => Reflect.get(window, "copiedArtifactDigest")))
    .toBe(previewDigest);

  await page.keyboard.press("Escape");
  await expect(previewDialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Markdownをダウンロード" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("transcript.md");

  const deleteTrigger = page.getByRole("button", { name: "ジョブを削除" });
  await deleteTrigger.click();
  const deleteConfirmation = page.getByRole("button", {
    name: "完全削除を受け付ける",
  });
  await expect(deleteConfirmation).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(deleteTrigger).toBeFocused();

  await deleteTrigger.click();
  await page.getByRole("button", { name: "完全削除を受け付ける" }).click();
  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText("まだジョブがありません。")).toBeVisible();
  expect(backend.deleted).toBe(true);
  expect(backend.mutationHeadersValid).toBe(true);
});

test("continues after the upload page closes and restores the job from history", async ({
  context,
  page,
}) => {
  const backend = await installMockBackend(context, {
    persistCreatedJobInList: true,
  });
  await page.goto("/");

  await page.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from("dummy audio"),
    mimeType: "audio/mpeg",
    name: "meeting.mp3",
  });
  await page.getByRole("button", { name: "アップロードを開始" }).click();
  await expect(page.getByText("アップロードを受け付けました。")).toBeVisible();
  expect(backend.multipartCompleted).toBe(true);

  await page.close();

  const restoredPage = await context.newPage();
  await restoredPage.goto("/history");
  await expect(restoredPage.getByText("E2E meeting")).toBeVisible();
  await expect(restoredPage.getByText("処理待ち", { exact: true })).toBeVisible();

  await restoredPage.getByRole("link", { name: "E2E meetingの詳細" }).click();
  await expect.poll(() => backend.detailRequests).toBe(1);
  await expect(restoredPage.getByRole("heading", { level: 1, name: "E2E meeting" })).toBeVisible();
  await expect(restoredPage.getByText("処理待ち", { exact: true }).first()).toBeVisible();
  await restoredPage.close();

  const runningPage = await context.newPage();
  await runningPage.goto(`/jobs/${JOB_ID}`);
  await expect.poll(() => backend.detailRequests).toBe(2);
  await expect(runningPage.getByText("文字起こし中", { exact: true }).first()).toBeVisible();
  await runningPage.close();

  const completedPage = await context.newPage();
  await completedPage.goto(`/jobs/${JOB_ID}`);
  await expect.poll(() => backend.detailRequests).toBe(3);
  await expect(completedPage.getByText("完了", { exact: true }).first()).toBeVisible();
});
