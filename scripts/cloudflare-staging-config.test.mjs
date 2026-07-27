import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderOrchestratorStagingConfig,
  renderR2CorsStagingConfig,
  renderR2LifecycleStagingConfig,
  renderWebStagingConfig,
} from "./cloudflare-staging-config.mjs";

const identifiers = {
  accessAudience: "staging-access-audience",
  accessTeamDomain: "https://scribe-drop-staging.cloudflareaccess.com",
  accountId: "a".repeat(32),
  d1DatabaseId: "12345678-1234-4abc-8def-1234567890ab",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  webOrigin: "https://scribe-drop-staging.example.invalid",
};

test("renders only the orchestrator staging identifiers", () => {
  const template = `name = "local"
main = "src/index.ts"

[vars]
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"

[env.staging]
routes = [
  { pattern = "replace-with-staging-orchestrator.example.invalid", custom_domain = true },
]
[env.staging.vars]
AUDIT_RETENTION_DAYS = "180"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
MULTIPART_RETENTION_HOURS = "24"
RESULT_RETENTION_DAYS = "90"
RUNPOD_INTERNAL_BASE_URL = "https://replace-with-staging-orchestrator.example.invalid"
SOURCE_RETENTION_DAYS = "7"
WEB_BASE_URL = "https://replace-with-staging-web.example.invalid"
database_id = "00000000-0000-0000-0000-000000000101"
`;

  const rendered = renderOrchestratorStagingConfig(template, identifiers);

  assert.match(rendered, /main = "\.\.\/\.\.\/apps\/orchestrator\/src\/index\.ts"/u);
  assert.match(rendered, new RegExp(`\\[vars\\]\\nCLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"`));
  assert.match(
    rendered,
    new RegExp(`\\[env\\.staging\\.vars\\][\\s\\S]*CLOUDFLARE_ACCOUNT_ID = "${"a".repeat(32)}"`),
  );
  assert.match(rendered, /database_id = "12345678-1234-4abc-8def-1234567890ab"/u);
  assert.match(
    rendered,
    /pattern = "orchestrator-staging\.example\.invalid", custom_domain = true/u,
  );
  assert.match(
    rendered,
    /RUNPOD_INTERNAL_BASE_URL = "https:\/\/orchestrator-staging\.example\.invalid"/u,
  );
  assert.match(rendered, /WEB_BASE_URL = "https:\/\/scribe-drop-staging\.example\.invalid"/u);
});

test("renders the web staging identifiers and ignored-config build path", () => {
  const template = `pages_build_output_dir = "./dist"
ACCESS_AUDIENCES = "[\\"replace-with-access-audience\\"]"
ACCESS_TEAM_DOMAIN = "https://replace-with-team.cloudflareaccess.com"
ALLOWED_ORIGIN = "https://replace-with-staging-web.example.invalid"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`;

  const rendered = renderWebStagingConfig(template, identifiers);

  assert.match(rendered, /pages_build_output_dir = "\.\.\/\.\.\/dist"/u);
  assert.match(rendered, /ACCESS_AUDIENCES = "\[\\"staging-access-audience\\"\]"/u);
  assert.match(
    rendered,
    /ACCESS_TEAM_DOMAIN = "https:\/\/scribe-drop-staging\.cloudflareaccess\.com"/u,
  );
  assert.match(rendered, /ALLOWED_ORIGIN = "https:\/\/scribe-drop-staging\.example\.invalid"/u);
  assert.match(rendered, new RegExp(`CLOUDFLARE_ACCOUNT_ID = "${"a".repeat(32)}"`));
  assert.match(rendered, /database_id = "12345678-1234-4abc-8def-1234567890ab"/u);
});

test("renders the R2 CORS staging origin", () => {
  const template = `{
  "rules": [
    {
      "allowed": {
        "origins": ["https://replace-with-staging-web.example.invalid"]
      }
    }
  ]
}
`;

  const rendered = renderR2CorsStagingConfig(template, identifiers);

  assert.match(rendered, /"origins": \["https:\/\/scribe-drop-staging\.example\.invalid"\]/u);
});

test("renders matching R2 lifecycle ages from reviewed retention values", () => {
  const template = `{
  "rules": [
    {
      "id": "scribe-drop-incoming-retention-staging",
      "enabled": true,
      "conditions": { "prefix": "incoming/" },
      "deleteObjectsTransition": {
        "condition": { "type": "Age", "maxAge": 604800 }
      },
      "abortMultipartUploadsTransition": {
        "condition": { "type": "Age", "maxAge": 86400 }
      }
    },
    {
      "id": "scribe-drop-results-retention-staging",
      "enabled": true,
      "conditions": { "prefix": "results/" },
      "deleteObjectsTransition": {
        "condition": { "type": "Age", "maxAge": 7776000 }
      }
    }
  ]
}
`;

  const rendered = JSON.parse(
    renderR2LifecycleStagingConfig(template, {
      ...identifiers,
      auditRetentionDays: "365",
      multipartRetentionHours: "48",
      resultRetentionDays: "120",
      sourceRetentionDays: "14",
    }),
  );

  assert.equal(rendered.rules[0].abortMultipartUploadsTransition.condition.maxAge, 48 * 3600);
  assert.equal(rendered.rules[0].deleteObjectsTransition.condition.maxAge, 14 * 86400);
  assert.equal(rendered.rules[1].deleteObjectsTransition.condition.maxAge, 120 * 86400);
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
      renderWebStagingConfig(
        `CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`,
        { ...identifiers, accessTeamDomain: "https://example.com" },
      ),
    /SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN/u,
  );
  assert.throws(
    () =>
      renderR2CorsStagingConfig(`"origins": ["https://replace-with-staging-web.example.invalid"]`, {
        ...identifiers,
        webOrigin: "https://example.invalid/path",
      }),
    /SCRIBE_DROP_STAGING_WEB_ORIGIN/u,
  );
  assert.throws(
    () =>
      renderOrchestratorStagingConfig(
        `[env.staging]\nCLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"\n`,
        identifiers,
      ),
    /orchestrator staging D1 database ID placeholder was not found/u,
  );
  assert.throws(
    () =>
      renderOrchestratorStagingConfig(
        `[env.staging]\nCLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"\n`,
        { ...identifiers, orchestratorOrigin: "http://localhost:8787" },
      ),
    /SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN/u,
  );
  assert.throws(
    () =>
      renderR2LifecycleStagingConfig('{"rules":[]}', {
        ...identifiers,
        resultRetentionDays: "6",
        sourceRetentionDays: "7",
      }),
    /source <= result <= audit/u,
  );
});
