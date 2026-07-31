import { expect, test } from "@playwright/test";
import { createJobResponseSchema } from "@scribe-drop/contracts";

import {
  requireStagingFailureEvidencePath,
  writeStagingFailureEvidence,
} from "../staging-failure-evidence.js";
import {
  closeAuthenticatedStagingContext,
  openAuthenticatedStagingPage,
  requireStagingEnvironment,
  waitForAuthenticatedStagingDataPlane,
} from "../staging-auth.js";
import { waitForStagingJobFailure } from "../staging-lifecycle.js";

const STAGING_FAILURE_TIMEOUT_MS = 7 * 60 * 1_000;

test("delivers a safe notification for a synthetic failed M4A", async ({ browser, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Staging base URL is missing");
  }
  const evidencePath = requireStagingFailureEvidencePath(
    process.env["STAGING_FAILURE_EVIDENCE_PATH"],
  );
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);

  try {
    await waitForAuthenticatedStagingDataPlane(page, baseURL);
    await page.getByLabel("文字起こしする音声・動画ファイル").setInputFiles({
      buffer: Buffer.from("synthetic invalid media for staging failure acceptance\n", "utf8"),
      mimeType: "audio/mp4a-latm",
      name: "synthetic-invalid.m4a",
    });
    await page
      .getByLabel("タイトル")
      .fill(`Synthetic failure ${requireStagingEnvironment("GITHUB_SHA").slice(0, 12)}`);
    await page.getByLabel("Markdown", { exact: true }).check();

    const uploadButton = page.getByRole("button", {
      name: "アップロードを開始",
    });
    await expect(uploadButton).toBeEnabled();
    const createJobResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === baseURL &&
        new URL(response.url()).pathname === "/api/jobs" &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await uploadButton.click();
    const createResponse = await createJobResponse;
    expect(createResponse.status(), "Failure fixture job creation must succeed").toBe(201);
    const createdJob = createJobResponseSchema.safeParse((await createResponse.json()) as unknown);
    expect(createdJob.success, "Failure fixture must return the strict upload contract").toBe(true);
    if (!createdJob.success) {
      throw new Error("Failure fixture returned an invalid create response");
    }
    writeStagingFailureEvidence(evidencePath, createdJob.data.jobId);

    const uploadAccepted = page.getByText("アップロードを受け付けました。");
    const uploadError = page.getByRole("alert");
    await expect(uploadAccepted.or(uploadError)).toBeVisible({
      timeout: 2 * 60 * 1_000,
    });
    expect(await uploadError.isVisible(), "Failure fixture upload must complete").toBe(false);
    await expect(uploadAccepted).toBeVisible();
    await page.getByRole("link", { name: "ジョブ詳細を確認" }).click();

    await waitForStagingJobFailure(page, STAGING_FAILURE_TIMEOUT_MS);
  } finally {
    await closeAuthenticatedStagingContext(context);
  }
});
