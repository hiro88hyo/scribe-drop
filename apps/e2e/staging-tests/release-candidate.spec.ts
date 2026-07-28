import { readFileSync } from "node:fs";

import { expect, test, type Download } from "@playwright/test";

import { readCandidateFixture } from "../candidate-fixture.js";
import {
  openAuthenticatedStagingPage,
  requireStagingEnvironment,
  waitForAuthenticatedStagingDataPlane,
} from "../staging-auth.js";

async function readSuccessfulDownload(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  return readFileSync(await download.path());
}

test("promotes a synthetic Android M4A through the real staging lifecycle", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);

  try {
    await waitForAuthenticatedStagingDataPlane(page, baseURL);

    await page.getByLabel("文字起こしする音声・動画ファイル").setInputFiles({
      buffer: readCandidateFixture(requireStagingEnvironment("RELEASE_CANDIDATE_DIRECTORY")),
      mimeType: "audio/mp4a-latm",
      name: "android-aac.m4a",
    });
    await page
      .getByLabel("タイトル")
      .fill(`Release candidate ${requireStagingEnvironment("GITHUB_SHA").slice(0, 12)}`);
    for (const label of ["Markdown", "JSON", "SRT"]) {
      await page.getByLabel(label, { exact: true }).check();
    }

    const uploadButton = page.getByRole("button", {
      name: "アップロードを開始",
    });
    await expect(uploadButton).toBeEnabled();
    await uploadButton.click();
    await expect(page.getByText("アップロードを受け付けました。")).toBeVisible({
      timeout: 2 * 60 * 1_000,
    });
    await page.getByRole("link", { name: "ジョブ詳細を確認" }).click();

    await expect(page.getByText("完了", { exact: true }).first()).toBeVisible({
      timeout: 20 * 60 * 1_000,
    });

    for (const [label, filename, validate] of [
      [
        "Markdownをダウンロード",
        "transcript.md",
        (content: Buffer) => {
          expect(content.toString("utf8")).toContain("# Transcript");
        },
      ],
      [
        "JSONをダウンロード",
        "transcript.json",
        (content: Buffer) => {
          const transcript = JSON.parse(content.toString("utf8")) as unknown;
          expect(transcript).toEqual(
            expect.objectContaining({
              schemaVersion: 1,
              segments: expect.any(Array),
            }),
          );
        },
      ],
      [
        "SRTをダウンロード",
        "transcript.srt",
        (content: Buffer) => {
          expect(content.toString("utf8")).not.toContain("\u0000");
        },
      ],
    ] as const) {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: label }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(filename);
      validate(await readSuccessfulDownload(download));
    }

    await page.getByRole("button", { name: "ジョブを削除" }).click();
    await page.getByRole("button", { name: "完全削除を受け付ける" }).click();
    await expect(page).toHaveURL(/\/history$/u);
  } finally {
    await context.close();
  }
});
