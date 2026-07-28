import process from "node:process";

import { verifyPagesUploadPermission } from "./pages-upload-permission.mjs";

try {
  await verifyPagesUploadPermission(fetch, {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_PAGES_API_TOKEN,
    projectName: process.env.SCRIBE_DROP_STAGING_PAGES_PROJECT,
  });
  console.log("Staging Pages upload permission verified");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Staging Pages upload permission verification failed",
  );
  process.exitCode = 1;
}
