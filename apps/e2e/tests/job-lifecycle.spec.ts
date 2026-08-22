import { expect, test } from "@playwright/test";

import {
  readSuccessfulStagingDownload,
  waitForStagingArtifactDownload,
} from "../staging-artifact-download.js";
import {
  readStagingArtifactPreviewDigest,
  readStagingClipboardDigest,
} from "../staging-artifact-preview.js";
import { JOB_ID, installMockBackend } from "./mock-backend.js";

test("recovers from a network failure and completes the authenticated job lifecycle", async ({
  page,
}) => {
  const backend = await installMockBackend(page, {
    failDetailRequestAt: 2,
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
  await expect.poll(() => backend.detailRequests).toBe(2);
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
  const previewDigest = await readStagingArtifactPreviewDigest(page, "Markdown", 5_000);
  await page.keyboard.press("Shift+Tab");
  expect(await previewDialog.evaluate((element) => element.contains(document.activeElement))).toBe(
    true,
  );

  await page.evaluate(() => {
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText() {
          return Promise.resolve(copiedText);
        },
        writeText(value: string) {
          copiedText = value;
          return Promise.resolve();
        },
      },
    });
  });
  await previewDialog.getByRole("button", { name: "クリップボードにコピー" }).click();
  await expect(previewDialog.getByText("コピーしました。")).toBeVisible();
  await expect(readStagingClipboardDigest(page, 5_000)).resolves.toBe(previewDigest);

  await page.keyboard.press("Escape");
  await expect(previewDialog).toBeHidden();
  await expect(previewTrigger).toBeFocused();

  const download = await waitForStagingArtifactDownload(page, "Markdown", 5_000);
  expect(download.suggestedFilename()).toBe("transcript.md");
  expect((await readSuccessfulStagingDownload(download, "Markdown", 5_000)).toString("utf8")).toBe(
    "# Dummy E2E artifact\n",
  );

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

test("bounds persistent job-detail polling failures and exposes a retry", async ({ page }) => {
  const backend = await installMockBackend(page, {
    detailStatuses: ["SUBMISSION_PENDING"],
    failDetailRequestsAt: [2, 3, 4],
  });
  await page.clock.install();
  await page.goto(`/jobs/${JOB_ID}`);

  await expect(page.getByText("処理待ち", { exact: true }).first()).toBeVisible();
  for (const expectedRequests of [2, 3, 4]) {
    await page.clock.fastForward(5_000);
    await expect.poll(() => backend.detailRequests).toBe(expectedRequests);
  }

  await expect(page.locator(".detail-card > [role=alert]")).toBeVisible();
  await expect(page.getByRole("button", { name: "再試行" })).toBeVisible();
});

test("reports an artifact API failure instead of waiting for the suite timeout", async ({
  page,
}) => {
  const backend = await installMockBackend(page, {
    detailStatuses: ["COMPLETED"],
    failArtifactRequestAt: 1,
  });
  await page.goto(`/jobs/${JOB_ID}`);
  await expect(page.getByText("完了", { exact: true }).first()).toBeVisible();

  await expect(waitForStagingArtifactDownload(page, "Markdown", 1_000)).rejects.toThrow(
    "Staging Markdown artifact request failed before download",
  );
  expect(backend.artifactRequests).toBe(1);
});

test("reports a preview API failure instead of waiting for missing content", async ({ page }) => {
  const backend = await installMockBackend(page, {
    detailStatuses: ["COMPLETED"],
    failArtifactRequestAt: 1,
  });
  await page.goto(`/jobs/${JOB_ID}`);
  await expect(page.getByText("完了", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Markdownをブラウザで確認" }).click();
  await expect(readStagingArtifactPreviewDigest(page, "Markdown", 1_000)).rejects.toThrow(
    "Staging Markdown artifact preview request failed",
  );
  expect(backend.artifactRequests).toBe(1);
});

test("bounds a clipboard API that never settles", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: () => new Promise<string>(() => undefined),
      },
    });
  });

  await expect(readStagingClipboardDigest(page, 100)).rejects.toThrow(
    "Staging clipboard read exceeded its bounded wait",
  );
});
