import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { expect, test, type Download } from "@playwright/test";
import { createJobResponseSchema } from "@scribe-drop/contracts";

import { readCandidateFixture } from "../candidate-fixture.js";
import {
  handOffStagingFailureEvidence,
  requireStagingFailureEvidencePath,
} from "../staging-failure-evidence.js";
import { deleteStagingFixtureJob, waitForStagingJobCompletion } from "../staging-lifecycle.js";
import {
  closeAuthenticatedStagingContext,
  openAuthenticatedStagingPage,
  requireStagingEnvironment,
  waitForAuthenticatedStagingDataPlane,
} from "../staging-auth.js";

function multipartAction(requestUrl: string, method: string): string | undefined {
  const url = new URL(requestUrl);
  if (url.searchParams.has("partNumber") && url.searchParams.has("uploadId")) {
    return "upload-part";
  }
  if (url.searchParams.has("uploads") && method === "POST") {
    return "create-multipart";
  }
  if (url.searchParams.has("uploadId") && method === "POST") {
    return "complete-multipart";
  }
  if (url.searchParams.has("uploadId") && method === "DELETE") {
    return "abort-multipart";
  }
  return undefined;
}

async function readSuccessfulDownload(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  return readFileSync(await download.path());
}

test("promotes a synthetic Android M4A through the real staging lifecycle", async ({
  browser,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Staging base URL is missing");
  }
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);
  let createdJobId: string | undefined;
  let fixtureDeleted = false;
  let fixtureHandedOff = false;
  const cleanupEvidencePath =
    process.env["STAGING_FAILURE_EVIDENCE_PATH"] === undefined
      ? undefined
      : requireStagingFailureEvidencePath(process.env["STAGING_FAILURE_EVIDENCE_PATH"]);

  const removeCleanupEvidence = (): void => {
    if (cleanupEvidencePath !== undefined && existsSync(cleanupEvidencePath)) {
      unlinkSync(cleanupEvidencePath);
    }
  };

  try {
    await waitForAuthenticatedStagingDataPlane(page, baseURL);
    const multipartObservations: string[] = [];
    page.on("response", (response) => {
      const action = multipartAction(response.url(), response.request().method());
      if (action !== undefined && multipartObservations.length < 8) {
        multipartObservations.push(`${action}:status-${String(response.status())}`);
      }
    });
    page.on("requestfailed", (request) => {
      const action = multipartAction(request.url(), request.method());
      if (action !== undefined && multipartObservations.length < 8) {
        multipartObservations.push(`${action}:network-failure`);
      }
    });

    await page.getByLabel("文字起こしする音声・動画ファイル").setInputFiles({
      buffer: readCandidateFixture(requireStagingEnvironment("RELEASE_CANDIDATE_DIRECTORY")),
      mimeType: "audio/mp4a-latm",
      name: "android-aac.m4a",
    });
    const title = `Release candidate ${requireStagingEnvironment("GITHUB_SHA").slice(0, 12)}`;
    await page.getByLabel("タイトル").fill(title);
    for (const label of ["Markdown", "JSON", "SRT"]) {
      await page.getByLabel(label, { exact: true }).check();
    }

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
    const createRequestHeaders = await createResponse.request().allHeaders();
    const fetchSite = createRequestHeaders["sec-fetch-site"];
    const requestSecurityObservation = [
      `origin=${createRequestHeaders["origin"] === baseURL ? "match" : "mismatch"}`,
      `fetch-site=${
        fetchSite === "same-origin" ||
        fetchSite === "same-site" ||
        fetchSite === "cross-site" ||
        fetchSite === "none"
          ? fetchSite
          : "missing-or-invalid"
      }`,
      `csrf=${createRequestHeaders["x-csrf-token"] === undefined ? "missing" : "present"}`,
    ].join(", ");
    let createFailure = "non-json response";
    let createBody: unknown;
    if (
      createResponse.headers()["content-type"]?.toLowerCase().startsWith("application/json") ===
      true
    ) {
      createBody = (await createResponse.json()) as unknown;
      const code =
        typeof createBody === "object" &&
        createBody !== null &&
        "error" in createBody &&
        typeof createBody.error === "object" &&
        createBody.error !== null &&
        "code" in createBody.error &&
        typeof createBody.error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(createBody.error.code)
          ? createBody.error.code
          : "invalid JSON error";
      createFailure = `API error ${code}`;
    }
    expect(
      createResponse.status(),
      `Create job API must accept the synthetic staging job; received ${createFailure}; ${requestSecurityObservation}`,
    ).toBe(201);
    const createdJob = createJobResponseSchema.safeParse(createBody);
    expect(createdJob.success, "Create job API must return the strict upload contract").toBe(true);
    if (!createdJob.success) {
      throw new Error("Create job API returned an invalid success response");
    }
    createdJobId = createdJob.data.jobId;
    if (cleanupEvidencePath !== undefined) {
      fixtureHandedOff = handOffStagingFailureEvidence(cleanupEvidencePath, createdJobId);
    }

    const uploadAccepted = page.getByText("アップロードを受け付けました。");
    const uploadError = page.getByRole("alert");
    await expect(uploadAccepted.or(uploadError)).toBeVisible({
      timeout: 2 * 60 * 1_000,
    });
    expect(
      await uploadError.isVisible(),
      `Upload UI reported an error after job creation; multipart=${multipartObservations.join(",") || "none"}`,
    ).toBe(false);
    await expect(uploadAccepted).toBeVisible();
    await page.getByRole("link", { name: "ジョブ詳細を確認" }).click();

    await waitForStagingJobCompletion(page);

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL).origin,
    });
    const previewTrigger = page.getByRole("button", {
      name: "Markdownをブラウザで確認",
    });
    await previewTrigger.click();
    const previewDialog = page.getByRole("dialog", {
      name: "Markdownをブラウザで確認",
    });
    await expect(previewDialog).toBeVisible();
    const previewDigest = await previewDialog.locator("pre").evaluate(async (element) => {
      const bytes = new TextEncoder().encode(element.textContent);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    });
    expect(previewDigest).toMatch(/^[0-9a-f]{64}$/u);
    await previewDialog.getByRole("button", { name: "クリップボードにコピー" }).click();
    await expect(previewDialog.getByText("コピーしました。")).toBeVisible();
    const clipboardDigest = await page.evaluate(async () => {
      const bytes = new TextEncoder().encode(await navigator.clipboard.readText());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    });
    expect(clipboardDigest).toBe(previewDigest);
    await page.keyboard.press("Escape");
    await expect(previewDialog).toBeHidden();
    await expect(previewTrigger).toBeFocused();

    for (const [label, filename, validate] of [
      [
        "Markdownをダウンロード",
        "transcript.md",
        (content: Buffer) => {
          expect(createHash("sha256").update(content).digest("hex")).toBe(previewDigest);
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

    if (cleanupEvidencePath === undefined) {
      await deleteStagingFixtureJob(page, createdJobId);
      fixtureDeleted = true;
      removeCleanupEvidence();
    } else {
      fixtureHandedOff = true;
    }
  } finally {
    try {
      if (createdJobId !== undefined && !fixtureDeleted && !fixtureHandedOff) {
        await deleteStagingFixtureJob(page, createdJobId);
        fixtureDeleted = true;
        removeCleanupEvidence();
      }
    } finally {
      await closeAuthenticatedStagingContext(context);
    }
  }
});
