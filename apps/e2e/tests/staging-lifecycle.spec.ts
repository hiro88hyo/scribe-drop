import { expect, test } from "@playwright/test";

import {
  deleteStagingFixtureJob,
  waitForStagingJobCompletion,
  waitForStagingJobFailure,
} from "../staging-lifecycle.js";
import { JOB_ID, installMockBackend } from "./mock-backend.js";

test("stops immediately on a terminal staging failure and deletes the fixture job", async ({
  page,
}) => {
  const backend = await installMockBackend(page, {
    detailStatuses: ["FAILED"],
  });
  await page.goto(`/jobs/${JOB_ID}`);

  await expect(waitForStagingJobCompletion(page, 5_000)).rejects.toThrow(
    "terminal non-success state",
  );
  await deleteStagingFixtureJob(page, JOB_ID);

  expect(backend.detailRequests).toBe(2);
  expect(backend.deleted).toBe(true);
  expect(backend.mutationHeadersValid).toBe(true);
});

test("accepts only the completed staging state", async ({ page }) => {
  await installMockBackend(page, {
    detailStatuses: ["COMPLETED"],
  });
  await page.goto(`/jobs/${JOB_ID}`);

  await expect(waitForStagingJobCompletion(page, 5_000)).resolves.toBeUndefined();
});

test("accepts only FAILED for a staging failure fixture", async ({ page }) => {
  await installMockBackend(page, {
    detailStatuses: ["FAILED"],
  });
  await page.goto(`/jobs/${JOB_ID}`);

  await expect(waitForStagingJobFailure(page, 5_000)).resolves.toBeUndefined();
});

test("rejects COMPLETED for a staging failure fixture", async ({ page }) => {
  await installMockBackend(page, {
    detailStatuses: ["COMPLETED"],
  });
  await page.goto(`/jobs/${JOB_ID}`);

  await expect(waitForStagingJobFailure(page, 5_000)).rejects.toThrow("did not reach FAILED");
});
