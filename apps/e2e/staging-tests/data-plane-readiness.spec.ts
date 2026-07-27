import { test } from "@playwright/test";

import {
  openAuthenticatedStagingPage,
  waitForAuthenticatedStagingDataPlane,
} from "../staging-auth.js";

test("verifies the authenticated staging data plane before backend promotion", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedStagingPage(browser, baseURL);
  try {
    await waitForAuthenticatedStagingDataPlane(page);
  } finally {
    await context.close();
  }
});
