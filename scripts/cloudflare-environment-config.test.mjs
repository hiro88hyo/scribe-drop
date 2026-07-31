import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderOrchestratorProductionConfig,
  renderOrchestratorStagingConfig,
  renderR2CorsProductionConfig,
  renderR2CorsStagingConfig,
  renderR2LifecycleProductionConfig,
  renderR2LifecycleStagingConfig,
  renderWebProductionConfig,
  renderWebStagingConfig,
} from "./cloudflare-environment-config.mjs";

const identifiers = {
  accessAudience: "staging-access-audience",
  accessTeamDomain: "https://scribe-drop-staging.cloudflareaccess.com",
  accountId: "a".repeat(32),
  d1DatabaseId: "12345678-1234-4abc-8def-1234567890ab",
  orchestratorOrigin: "https://orchestrator-staging.example.invalid",
  pagesAccessAudience: "staging-pages-access-audience",
  runpodAllowedGpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090",
  runpodWorkerImage: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64),
  stagingE2eServiceTokenCommonName: "staging-e2e-token.access",
  webOrigin: "https://scribe-drop-staging.example.invalid",
};

const productionIdentifiers = {
  accessAudience: "production-access-audience",
  accessTeamDomain: "https://scribe-drop-production.cloudflareaccess.com",
  accountId: "b".repeat(32),
  d1DatabaseId: "abcdef12-1234-4abc-8def-1234567890ab",
  orchestratorOrigin: "https://orchestrator-production.example.invalid",
  runpodAllowedGpuTypeIds: "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090",
  runpodWorkerImage: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "b".repeat(64),
  webOrigin: "https://scribe-drop-production.example.invalid",
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
RUNPOD_ALLOWED_GPU_IDS = "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090"
RUNPOD_INTERNAL_BASE_URL = "https://replace-with-staging-orchestrator.example.invalid"
RUNPOD_WORKER_IMAGE = "ghcr.io/example/scribe-drop-runpod-worker@sha256:${"0".repeat(64)}"
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
  assert.match(
    rendered,
    /RUNPOD_ALLOWED_GPU_IDS = "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090"/u,
  );
  assert.match(rendered, new RegExp(`RUNPOD_WORKER_IMAGE = "${identifiers.runpodWorkerImage}"`));
  assert.match(rendered, /WEB_BASE_URL = "https:\/\/scribe-drop-staging\.example\.invalid"/u);
});

test("renders the web staging identifiers and ignored-config build path", () => {
  const template = `pages_build_output_dir = "./dist"
ACCESS_AUDIENCES = "[\\"replace-with-access-audience\\"]"
ACCESS_TEAM_DOMAIN = "https://replace-with-team.cloudflareaccess.com"
ALLOWED_ORIGIN = "https://replace-with-staging-web.example.invalid"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
STAGING_E2E_SERVICE_TOKEN_COMMON_NAME = "replace-with-staging-e2e-service-token"
database_id = "00000000-0000-0000-0000-000000000101"
`;

  const rendered = renderWebStagingConfig(template, identifiers);

  assert.match(rendered, /pages_build_output_dir = "\.\.\/\.\.\/dist"/u);
  assert.match(
    rendered,
    /ACCESS_AUDIENCES = "\[\\"staging-access-audience\\",\\"staging-pages-access-audience\\"\]"/u,
  );
  assert.match(
    rendered,
    /ACCESS_TEAM_DOMAIN = "https:\/\/scribe-drop-staging\.cloudflareaccess\.com"/u,
  );
  assert.match(rendered, /ALLOWED_ORIGIN = "https:\/\/scribe-drop-staging\.example\.invalid"/u);
  assert.match(rendered, new RegExp(`CLOUDFLARE_ACCOUNT_ID = "${"a".repeat(32)}"`));
  assert.match(rendered, /database_id = "12345678-1234-4abc-8def-1234567890ab"/u);
  assert.match(rendered, /STAGING_E2E_SERVICE_TOKEN_COMMON_NAME = "staging-e2e-token\.access"/u);
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
      renderWebStagingConfig(
        `CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`,
        { ...identifiers, pagesAccessAudience: undefined },
      ),
    /SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE/u,
  );
  assert.throws(
    () =>
      renderWebStagingConfig(
        `CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`,
        { ...identifiers, pagesAccessAudience: identifiers.accessAudience },
      ),
    /must be distinct/u,
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

test("renders only the orchestrator production identifiers", () => {
  const template = `name = "local"
main = "src/index.ts"

[env.staging.vars]
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"

[env.production]
routes = [
  { pattern = "replace-with-production-orchestrator.example.invalid", custom_domain = true },
]
[env.production.vars]
AUDIT_RETENTION_DAYS = "180"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
MULTIPART_RETENTION_HOURS = "24"
RESULT_RETENTION_DAYS = "90"
RUNPOD_ALLOWED_GPU_IDS = "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090"
RUNPOD_INTERNAL_BASE_URL = "https://replace-with-production-orchestrator.example.invalid"
RUNPOD_WORKER_IMAGE = "ghcr.io/example/scribe-drop-runpod-worker@sha256:${"0".repeat(64)}"
SOURCE_RETENTION_DAYS = "7"
WEB_BASE_URL = "https://replace-with-production-web.example.invalid"
database_id = "00000000-0000-0000-0000-000000000201"
`;

  const rendered = renderOrchestratorProductionConfig(template, productionIdentifiers);

  assert.match(rendered, /main = "\.\.\/\.\.\/apps\/orchestrator\/src\/index\.ts"/u);
  assert.doesNotMatch(rendered, /\[env\.staging/u);
  assert.match(
    rendered,
    new RegExp(`\\[env\\.production\\.vars\\][\\s\\S]*CLOUDFLARE_ACCOUNT_ID = "${"b".repeat(32)}"`),
  );
  assert.match(rendered, /database_id = "abcdef12-1234-4abc-8def-1234567890ab"/u);
  assert.match(
    rendered,
    /pattern = "orchestrator-production\.example\.invalid", custom_domain = true/u,
  );
  assert.match(
    rendered,
    /RUNPOD_INTERNAL_BASE_URL = "https:\/\/orchestrator-production\.example\.invalid"/u,
  );
  assert.match(
    rendered,
    /RUNPOD_ALLOWED_GPU_IDS = "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090"/u,
  );
  assert.match(
    rendered,
    new RegExp(`RUNPOD_WORKER_IMAGE = "${productionIdentifiers.runpodWorkerImage}"`),
  );
  assert.match(rendered, /WEB_BASE_URL = "https:\/\/scribe-drop-production\.example\.invalid"/u);
});

test("renders production Web, CORS, and lifecycle without staging values", () => {
  const webTemplate = `pages_build_output_dir = "./dist"
ACCESS_AUDIENCES = "[\\"replace-with-access-audience\\"]"
ACCESS_TEAM_DOMAIN = "https://replace-with-team.cloudflareaccess.com"
ALLOWED_ORIGIN = "https://replace-with-production-web.example.invalid"
CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000201"
`;
  const corsTemplate =
    '{"rules":[{"allowed":{"origins": ["https://replace-with-production-web.example.invalid"]}}]}';
  const lifecycleTemplate = `{
  "rules": [
    {
      "id": "scribe-drop-incoming-retention-production",
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
      "id": "scribe-drop-results-retention-production",
      "enabled": true,
      "conditions": { "prefix": "results/" },
      "deleteObjectsTransition": {
        "condition": { "type": "Age", "maxAge": 7776000 }
      }
    }
  ]
}`;

  const web = renderWebProductionConfig(webTemplate, productionIdentifiers);
  const cors = renderR2CorsProductionConfig(corsTemplate, productionIdentifiers);
  const lifecycle = renderR2LifecycleProductionConfig(lifecycleTemplate, {
    ...productionIdentifiers,
    auditRetentionDays: "365",
    multipartRetentionHours: "48",
    resultRetentionDays: "120",
    sourceRetentionDays: "14",
  });

  assert.match(web, /ACCESS_AUDIENCES = "\[\\"production-access-audience\\"\]"/u);
  assert.match(web, /ALLOWED_ORIGIN = "https:\/\/scribe-drop-production\.example\.invalid"/u);
  assert.doesNotMatch(web, /staging/u);
  assert.match(cors, /https:\/\/scribe-drop-production\.example\.invalid/u);
  assert.doesNotMatch(cors, /staging/u);
  const parsedLifecycle = JSON.parse(lifecycle);
  assert.equal(parsedLifecycle.rules[0].deleteObjectsTransition.condition.maxAge, 14 * 86400);
  assert.equal(
    parsedLifecycle.rules[0].abortMultipartUploadsTransition.condition.maxAge,
    48 * 3600,
  );
  assert.equal(parsedLifecycle.rules[1].deleteObjectsTransition.condition.maxAge, 120 * 86400);
});

test("rejects staging placeholders and identifiers in production rendering", () => {
  assert.throws(
    () =>
      renderWebProductionConfig(
        `CLOUDFLARE_ACCOUNT_ID = "${"0".repeat(32)}"
database_id = "00000000-0000-0000-0000-000000000101"
`,
        productionIdentifiers,
      ),
    /web production D1 database ID placeholder was not found/u,
  );
  assert.throws(
    () =>
      renderR2CorsProductionConfig(
        '"origins": ["https://replace-with-production-web.example.invalid"]',
        {
          ...productionIdentifiers,
          webOrigin: identifiers.webOrigin,
        },
      ),
    /staging environment marker/u,
  );
});
