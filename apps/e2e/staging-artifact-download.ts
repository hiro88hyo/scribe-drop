import { readFileSync } from "node:fs";

import type { Download, Page } from "@playwright/test";

export const STAGING_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30_000;

type DownloadOutcome =
  | { readonly download: Download; readonly kind: "download" }
  | { readonly kind: "request-error" }
  | { readonly kind: "timeout" };

async function withinDownloadTimeout<Value>(
  operation: Promise<Value>,
  label: string,
  timeout: number,
): Promise<Value> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Staging ${label} download did not complete within the bounded wait`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function waitForStagingArtifactDownload(
  page: Page,
  label: string,
  timeout = STAGING_ARTIFACT_DOWNLOAD_TIMEOUT_MS,
): Promise<Download> {
  const button = page.getByRole("button", { name: `${label}をダウンロード` });
  const downloadError = button.locator("..").getByRole("alert");
  const downloadOutcome = page
    .waitForEvent("download", { timeout })
    .then<DownloadOutcome, DownloadOutcome>(
      (download) => ({ download, kind: "download" }),
      () => ({ kind: "timeout" }),
    );
  const errorOutcome = downloadError
    .waitFor({ state: "visible", timeout })
    .then<DownloadOutcome, DownloadOutcome>(
      () => ({ kind: "request-error" }),
      () => ({ kind: "timeout" }),
    );

  await button.click();
  const outcome = await Promise.race([downloadOutcome, errorOutcome]);
  if (outcome.kind === "download") {
    return outcome.download;
  }
  if (outcome.kind === "request-error") {
    throw new Error(`Staging ${label} artifact request failed before download`);
  }
  throw new Error(`Staging ${label} artifact did not start downloading within the bounded wait`);
}

export async function readSuccessfulStagingDownload(
  download: Download,
  label: string,
  timeout = STAGING_ARTIFACT_DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  const failure = await withinDownloadTimeout(download.failure(), label, timeout);
  if (failure !== null) {
    throw new Error(`Staging ${label} artifact download failed`);
  }
  const downloadPath = await withinDownloadTimeout(download.path(), label, timeout);
  return readFileSync(downloadPath);
}
