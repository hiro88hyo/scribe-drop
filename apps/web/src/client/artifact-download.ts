import type { OutputFormat } from "@scribe-drop/contracts";

import { apiClient, type ScribeDropApiClient } from "./api-client.js";

export interface ArtifactDownloadDependencies {
  readonly getArtifact: ScribeDropApiClient["getArtifact"];
  readonly startDownload: (url: string) => void;
}

function startBrowserDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.download = "";
  anchor.hidden = true;
  anchor.href = url;
  anchor.referrerPolicy = "no-referrer";
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

const defaultDependencies: ArtifactDownloadDependencies = {
  getArtifact: apiClient.getArtifact.bind(apiClient),
  startDownload: startBrowserDownload,
};

export async function requestArtifactDownload(
  jobId: string,
  format: OutputFormat,
  signal?: AbortSignal,
  dependencies: ArtifactDownloadDependencies = defaultDependencies,
): Promise<boolean> {
  const response = await dependencies.getArtifact(jobId, format, signal);
  if (signal?.aborted === true) {
    return false;
  }
  dependencies.startDownload(response.url);
  return true;
}
