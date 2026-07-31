import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseEncryptedPagesSecretNames,
  requirePagesProjectName,
  verifyRequiredPagesSecrets,
} from "./cloudflare-pages-secret-verifier.mjs";

const completeOutput = `
The "production" environment has access to the following secrets:
  - CSRF_HMAC_SECRET: Value Encrypted
  - OWNER_HASH_HMAC_SECRET: Value Encrypted
  - R2_PARENT_ACCESS_KEY_ID: Value Encrypted
  - R2_PARENT_SECRET_ACCESS_KEY: Value Encrypted
`;

test("accepts all required encrypted Pages secrets without reading values", () => {
  const result = verifyRequiredPagesSecrets(completeOutput);

  assert.deepEqual(result, { listedCount: 4, requiredCount: 4 });
});

test("ignores non-secret output and additional encrypted secrets", () => {
  const names = parseEncryptedPagesSecretNames(
    `${completeOutput}  - FUTURE_SECRET: Value Encrypted\nnoise\n`,
  );

  assert.deepEqual(
    [...names].sort(),
    [
      "CSRF_HMAC_SECRET",
      "FUTURE_SECRET",
      "OWNER_HASH_HMAC_SECRET",
      "R2_PARENT_ACCESS_KEY_ID",
      "R2_PARENT_SECRET_ACCESS_KEY",
    ].sort(),
  );
});

test("fails closed when a required Pages secret is missing", () => {
  assert.throws(
    () =>
      verifyRequiredPagesSecrets(
        completeOutput.replace("  - R2_PARENT_SECRET_ACCESS_KEY: Value Encrypted\n", ""),
      ),
    /Missing required Pages secrets: R2_PARENT_SECRET_ACCESS_KEY/u,
  );
});

test("keeps staging and production Pages projects isolated", () => {
  assert.equal(requirePagesProjectName("staging"), "scribe-drop-web-staging");
  assert.equal(requirePagesProjectName("production"), "scribe-drop-web-production");
  assert.throws(
    () => requirePagesProjectName("production", "scribe-drop-web-staging"),
    /must be scribe-drop-web-production/u,
  );
  assert.throws(() => requirePagesProjectName("preview"), /must be staging or production/u);
});
