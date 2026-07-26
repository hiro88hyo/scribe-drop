import { expect, test } from "@playwright/test";

import { installMockBackend } from "./mock-backend.js";

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
