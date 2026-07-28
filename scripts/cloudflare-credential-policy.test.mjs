import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyCloudflareCredentialPolicy } from "./cloudflare-credential-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const policy = JSON.parse(
  readFileSync(path.join(repositoryRoot, "tools", "cloudflare-credential-policy.json"), "utf8"),
);
const documentation = readFileSync(
  path.join(repositoryRoot, "docs", "cloudflare-permissions.md"),
  "utf8",
);
const workflows =
  "secrets.CLOUDFLARE_API_TOKEN\n" +
  "secrets.CLOUDFLARE_PAGES_API_TOKEN\n" +
  "pnpm exec wrangler d1 migrations apply SCRIBE_DROP_DB \\\n" +
  "pnpm exec wrangler deploy artifact.js \\\n" +
  "pnpm exec wrangler pages deploy dist \\\n" +
  "pnpm exec wrangler pages deployment list \\\n" +
  "pnpm exec wrangler r2 bucket cors set bucket \\\n" +
  "pnpm exec wrangler r2 bucket lifecycle set bucket \\\n";
const cloudflareApiFiles = [
  "scripts/cloudflare-readback.mjs",
  "scripts/pages-promotion.mjs",
  "scripts/pages-upload-permission.mjs",
  "scripts/staging-access-control-plane.mjs",
];
const evidence = { cloudflareApiFiles, documentation, workflows };

function clonePolicy() {
  return structuredClone(policy);
}

test("accepts the reviewed Cloudflare credential policy", () => {
  assert.deepEqual(verifyCloudflareCredentialPolicy(policy, evidence), {
    apiTokenRoles: 2,
    cloudflareApiFiles: 4,
    credentialRoles: 4,
    wranglerCommands: 6,
  });
});

test("rejects an unreviewed API token permission", () => {
  const changed = clonePolicy();
  changed.roles[0].accountPermissions.push("Account Settings Read");

  assert.throws(
    () => verifyCloudflareCredentialPolicy(changed, evidence),
    /least-privilege policy/u,
  );
});

test("rejects an incomplete backend control-plane permission set", () => {
  const changed = clonePolicy();
  changed.roles[0].accountPermissions[0] = "Access: Apps and Policies Read";
  changed.roles[0].accountPermissions[1] = "Access: Service Tokens Read";

  assert.throws(
    () => verifyCloudflareCredentialPolicy(changed, evidence),
    /least-privilege policy/u,
  );
});

test("rejects incomplete human-readable permission documentation", () => {
  assert.throws(
    () =>
      verifyCloudflareCredentialPolicy(policy, {
        cloudflareApiFiles,
        documentation: documentation.replaceAll(
          "Workers Scripts Edit",
          "Workers script permission",
        ),
        workflows,
      }),
    /documentation is missing Workers Scripts Edit/u,
  );
});

test("rejects a new direct Cloudflare API caller before remote use", () => {
  assert.throws(
    () =>
      verifyCloudflareCredentialPolicy(policy, {
        cloudflareApiFiles: [...cloudflareApiFiles, "scripts/unreviewed-cloudflare-api.mjs"],
        documentation,
        workflows,
      }),
    /direct API source files/u,
  );
});

test("rejects a new Wrangler product command before remote use", () => {
  assert.throws(
    () =>
      verifyCloudflareCredentialPolicy(policy, {
        cloudflareApiFiles,
        documentation,
        workflows: `${workflows}\npnpm exec wrangler kv namespace create unreviewed`,
      }),
    /Unreviewed Cloudflare workflow command/u,
  );
});
