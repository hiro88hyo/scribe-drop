import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Download } from "@playwright/test";

import {
  headersForAccessRequest,
  serviceTokenCookieMatchesExpectedIdentity,
} from "../access-service-credentials.js";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireCandidateFixture(): Buffer {
  const candidateDirectory = requireEnvironment("RELEASE_CANDIDATE_DIRECTORY");
  const metadata = JSON.parse(
    readFileSync(path.join(candidateDirectory, "acceptance-fixtures", "metadata.json"), "utf8"),
  ) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("schemaVersion" in metadata) ||
    metadata.schemaVersion !== 1 ||
    !("filename" in metadata) ||
    metadata.filename !== "android-aac.m4a" ||
    !("mediaType" in metadata) ||
    metadata.mediaType !== "audio/mp4a-latm" ||
    !("synthetic" in metadata) ||
    metadata.synthetic !== true
  ) {
    throw new Error("Release candidate acceptance fixture metadata is invalid");
  }
  return readFileSync(path.join(candidateDirectory, "acceptance-fixtures", "android-aac.m4a"));
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
  const credentials = {
    clientId: requireEnvironment("CF_ACCESS_CLIENT_ID"),
    clientSecret: requireEnvironment("CF_ACCESS_CLIENT_SECRET"),
  };
  const expectedCommonName = requireEnvironment(
    "SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  );
  const appOrigin = new URL(baseURL).origin;
  const context = await browser.newContext();

  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const headers = headersForAccessRequest(
        request.url(),
        appOrigin,
        request.headers(),
        credentials,
      );
      if (new URL(request.url()).origin !== appOrigin) {
        await route.continue({ headers });
        return;
      }

      // Keep redirects visible to the browser so every destination is checked
      // before Access credentials are attached.
      const response = await route.fetch({ headers, maxRedirects: 0 });
      await route.fulfill({ response });
    });

    const page = await context.newPage();
    const authenticationResponse = await page.goto(baseURL, {
      waitUntil: "domcontentloaded",
    });
    expect(authenticationResponse?.ok()).toBe(true);
    const accessCookie = (await context.cookies(baseURL)).find(
      (cookie) => cookie.name === "CF_Authorization",
    );
    expect(accessCookie).toBeDefined();
    expect(
      serviceTokenCookieMatchesExpectedIdentity(accessCookie?.value ?? "", expectedCommonName),
    ).toBe(true);

    await page.goto(baseURL, { waitUntil: "networkidle" });
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            try {
              const response = await fetch("/api/me", {
                cache: "no-store",
                credentials: "same-origin",
                headers: { Accept: "application/json" },
              });
              if (!response.ok) {
                return { email: null, ok: false, status: response.status };
              }
              const body = (await response.json()) as unknown;
              const email =
                typeof body === "object" &&
                body !== null &&
                "user" in body &&
                typeof body.user === "object" &&
                body.user !== null &&
                "email" in body.user &&
                typeof body.user.email === "string"
                  ? body.user.email
                  : null;
              return { email, ok: true, status: response.status };
            } catch {
              return { email: null, ok: false, status: 0 };
            }
          }),
        {
          intervals: [1_000, 2_000, 5_000, 10_000],
          message: "Expected the authenticated staging data plane to converge",
          timeout: 2 * 60 * 1_000,
        },
      )
      .toEqual({
        email: "staging-e2e@example.invalid",
        ok: true,
        status: 200,
      });
    await expect(page.getByText("staging-e2e@example.invalid")).toBeVisible();

    await page.getByLabel("文字起こしする音声・動画ファイル").setInputFiles({
      buffer: requireCandidateFixture(),
      mimeType: "audio/mp4a-latm",
      name: "android-aac.m4a",
    });
    await page
      .getByLabel("タイトル")
      .fill(`Release candidate ${requireEnvironment("GITHUB_SHA").slice(0, 12)}`);
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
