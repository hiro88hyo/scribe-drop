import { expect, type Locator, type Page } from "@playwright/test";

export const STAGING_JOB_COMPLETION_TIMEOUT_MS = 10 * 60 * 1_000;

const terminalFailureLabels = ["キャンセル済み", "期限切れ", "失敗", "元ファイル変更"] as const;

function terminalFailureLocator(page: Page): Locator {
  const [firstLabel, ...remainingLabels] = terminalFailureLabels;
  let locator = page.getByText(firstLabel, { exact: true }).first();
  for (const label of remainingLabels) {
    locator = locator.or(page.getByText(label, { exact: true }).first());
  }
  return locator;
}

export async function waitForStagingJobCompletion(
  page: Page,
  timeout = STAGING_JOB_COMPLETION_TIMEOUT_MS,
): Promise<void> {
  const completed = page.getByText("完了", { exact: true }).first();
  const failed = terminalFailureLocator(page);
  await expect(completed.or(failed)).toBeVisible({ timeout });
  if (await failed.isVisible()) {
    throw new Error("Staging job reached a terminal non-success state");
  }
  await expect(completed).toBeVisible();
}

export async function waitForStagingJobFailure(
  page: Page,
  timeout = STAGING_JOB_COMPLETION_TIMEOUT_MS,
): Promise<void> {
  const failed = page.getByText("失敗", { exact: true }).first();
  const unexpectedTerminal = page
    .getByText("完了", { exact: true })
    .first()
    .or(page.getByText("キャンセル済み", { exact: true }).first())
    .or(page.getByText("期限切れ", { exact: true }).first())
    .or(page.getByText("元ファイル変更", { exact: true }).first());
  await expect(failed.or(unexpectedTerminal)).toBeVisible({ timeout });
  if (!(await failed.isVisible())) {
    throw new Error("Staging failure fixture did not reach FAILED");
  }
  await expect(failed).toBeVisible();
}

export async function deleteStagingFixtureJob(page: Page, jobId: string): Promise<void> {
  await page.goto(`/jobs/${encodeURIComponent(jobId)}`);
  const deleteTrigger = page.getByRole("button", { name: "ジョブを削除" });
  const alreadyDeleted = page.getByText("指定されたジョブは見つかりません。");
  await expect(deleteTrigger.or(alreadyDeleted)).toBeVisible({ timeout: 30_000 });
  if (await alreadyDeleted.isVisible()) return;
  await deleteTrigger.click();
  await page.getByRole("button", { name: "完全削除を受け付ける" }).click();
  await expect(page).toHaveURL(/\/history$/u, { timeout: 30_000 });
}
