import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderOrchestratorStagingConfig,
  renderWebStagingConfig,
} from "./cloudflare-staging-config.mjs";

const identifiers = {
  accountId: "a".repeat(32),
  d1DatabaseId: "12345678-1234-4abc-8def-1234567890ab",
};

test("renders only the orchestrator staging identifiers", () => {
  const template = `name = "local"
main = "src/index.ts"

[vars]
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"

[env.staging]
[env.staging.vars]
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`;

  const rendered = renderOrchestratorStagingConfig(template, identifiers);

  assert.match(rendered, /main = "\.\.\/\.\.\/apps\/orchestrator\/src\/index\.ts"/u);
  assert.match(rendered, new RegExp(`\\[vars\\]\\nCLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"`));
  assert.match(
    rendered,
    new RegExp(`\\[env\\.staging\\.vars\\]\\nCLOUDFLARE_ACCOUNT_ID = "${"a".repeat(32)}"`),
  );
  assert.match(rendered, /database_id = "12345678-1234-4abc-8def-1234567890ab"/u);
});

test("renders the web staging identifiers and ignored-config build path", () => {
  const template = `pages_build_output_dir = "./dist"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`;

  const rendered = renderWebStagingConfig(template, identifiers);

  assert.match(rendered, /pages_build_output_dir = "\.\.\/\.\.\/dist"/u);
  assert.match(rendered, new RegExp(`CLOUDFLARE_ACCOUNT_ID = "${"a".repeat(32)}"`));
  assert.match(rendered, /database_id = "12345678-1234-4abc-8def-1234567890ab"/u);
});

test("rejects missing identifiers and template drift", () => {
  assert.throws(
    () => renderWebStagingConfig("", { accountId: "invalid", d1DatabaseId: "invalid" }),
    /CLOUDFLARE_ACCOUNT_ID/u,
  );
  assert.throws(
    () => renderWebStagingConfig("", identifiers),
    /web staging account ID placeholder was not found/u,
  );
  assert.throws(
    () =>
      renderOrchestratorStagingConfig(
        `[env.staging]\nCLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"\n`,
        identifiers,
      ),
    /orchestrator staging D1 database ID placeholder was not found/u,
  );
});
