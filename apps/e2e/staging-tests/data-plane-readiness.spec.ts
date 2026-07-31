import { test } from "@playwright/test";

import {
  closeAuthenticatedStagingContext,
  openAuthenticatedStagingPage,
  waitForAuthenticatedStagingDataPlane,
} from "../staging-auth.js";

test("verifies the authenticated staging data plane before backend promotion", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);
  try {
    await waitForAuthenticatedStagingDataPlane(page, baseURL);
  } finally {
    await closeAuthenticatedStagingContext(context);
  }
});
