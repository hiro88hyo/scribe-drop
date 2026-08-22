import type { Page } from "@playwright/test";

export const STAGING_ARTIFACT_PREVIEW_TIMEOUT_MS = 30_000;
export const STAGING_CLIPBOARD_READ_TIMEOUT_MS = 10_000;

export async function readStagingArtifactPreviewDigest(
  page: Page,
  label: string,
  timeout = STAGING_ARTIFACT_PREVIEW_TIMEOUT_MS,
): Promise<string> {
  const dialog = page.getByRole("dialog", { name: `${label}をブラウザで確認` });
  const content = dialog.locator("pre");
  const error = dialog.getByRole("alert");
  const contentOutcome = content.waitFor({ state: "visible", timeout }).then(
    () => "content" as const,
    () => "timeout" as const,
  );
  const errorOutcome = error.waitFor({ state: "visible", timeout }).then(
    () => "error" as const,
    () => "timeout" as const,
  );
  const outcome = await Promise.race([contentOutcome, errorOutcome]);
  if (outcome === "error") {
    throw new Error(`Staging ${label} artifact preview request failed`);
  }
  if (outcome === "timeout") {
    throw new Error(`Staging ${label} artifact preview did not settle within the bounded wait`);
  }
  return content.evaluate(async (element) => {
    const bytes = new TextEncoder().encode(element.textContent);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
}

export async function readStagingClipboardDigest(
  page: Page,
  timeout = STAGING_CLIPBOARD_READ_TIMEOUT_MS,
): Promise<string> {
  return page.evaluate(async (timeoutMilliseconds) => {
    const text = await Promise.race([
      navigator.clipboard.readText(),
      new Promise<never>((_resolve, reject) => {
        window.setTimeout(() => {
          reject(new Error("Staging clipboard read exceeded its bounded wait"));
        }, timeoutMilliseconds);
      }),
    ]);
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }, timeout);
}
