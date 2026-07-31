import { existsSync } from "node:fs";

import { test } from "@playwright/test";

import {
  readStagingFailureEvidence,
  requireStagingFailureEvidencePath,
} from "../staging-failure-evidence.js";
import { closeAuthenticatedStagingContext, openAuthenticatedStagingPage } from "../staging-auth.js";
import { deleteStagingFixtureJob } from "../staging-lifecycle.js";

test("deletes the synthetic staging failure fixture", async ({ browser, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Staging base URL is missing");
  }
  const evidencePath = requireStagingFailureEvidencePath(
    process.env["STAGING_FAILURE_EVIDENCE_PATH"],
  );
  test.skip(!existsSync(evidencePath), "No synthetic staging failure job was created");
  const evidence = readStagingFailureEvidence(evidencePath);
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);
  try {
    await deleteStagingFixtureJob(page, evidence.jobId);
  } finally {
    await closeAuthenticatedStagingContext(context);
  }
});
