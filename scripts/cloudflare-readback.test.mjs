import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyCloudflareReadback } from "./cloudflare-readback.mjs";

const expected = {
  bucketName: "recording-transcriber-staging",
  bindings: new Map(),
  cors: {
    rules: [
      {
        allowed: {
          headers: ["authorization", "content-type"],
          methods: ["POST", "PUT", "DELETE"],
          origins: ["https://staging.example.invalid"],
        },
        exposeHeaders: ["ETag"],
        id: "cors",
        maxAgeSeconds: 3600,
      },
    ],
  },
  deadLetterQueueName: "recording-uploaded-dlq-staging",
  lifecycle: {
    rules: [
      {
        abortMultipartUploadsTransition: {
          condition: { maxAge: 86400, type: "Age" },
        },
        conditions: { prefix: "incoming/" },
        deleteObjectsTransition: {
          condition: { maxAge: 604800, type: "Age" },
        },
        enabled: true,
        id: "incoming-retention-staging",
      },
      {
        conditions: { prefix: "results/" },
        deleteObjectsTransition: {
          condition: { maxAge: 7776000, type: "Age" },
        },
        enabled: true,
        id: "results-retention-staging",
      },
    ],
  },
  pagesProjectName: "scribe-drop-web-staging",
  pagesBranch: "develop",
  pagesConfigHash: "b".repeat(64),
  queueName: "recording-uploaded-staging",
  workerName: "scribe-drop-orchestrator-staging",
};

const outputs = {
  consumer: JSON.stringify([
    {
      consumer_id: "opaque",
      dead_letter_queue: expected.deadLetterQueueName,
      script: expected.workerName,
      settings: {
        batch_size: 10,
        max_retries: 5,
        max_wait_time_ms: 5000,
        retry_delay: 60,
      },
      type: "worker",
    },
  ]),
  cors: `allowed_origins:  https://staging.example.invalid
allowed_methods:  POST, PUT, DELETE
allowed_headers:  authorization, content-type
exposed_headers:  ETag
max_age_seconds:  3600
`,
  lifecycle: `name:     incoming-retention-staging
enabled:  Yes
prefix:   incoming/
action:   Expire objects after 7 days, Abort incomplete multipart uploads after 1 days

name:     results-retention-staging
enabled:  Yes
prefix:   results/
action:   Expire objects after 90 days
`,
  migrations: "✅ No migrations to apply!\n",
  notification: `rule_id:     opaque
queue_name:  recording-uploaded-staging
prefix:      incoming/
suffix:      (all suffixes)
event_type:  PutObject,CompleteMultipartUpload,CopyObject
`,
  projects: JSON.stringify([
    {
      "Git Provider": "No",
      "Project Name": "scribe-drop-web-staging",
    },
  ]),
  queue: `Queue Name: recording-uploaded-staging
Number of Producers: 1
Producers: r2_bucket:recording-transcriber-staging
Number of Consumers: 1
Consumers: worker:scribe-drop-orchestrator-staging
`,
};

test("accepts exact Cloudflare resource read-back", () => {
  assert.doesNotThrow(() => verifyCloudflareReadback(outputs, expected));
});

test("rejects duplicate notification rules and consumer drift", () => {
  assert.throws(
    () =>
      verifyCloudflareReadback(
        {
          ...outputs,
          notification: `${outputs.notification}${outputs.notification}`,
        },
        expected,
      ),
    /notification count/u,
  );
  const consumers = JSON.parse(outputs.consumer);
  consumers[0].settings.max_retries = 6;
  assert.throws(
    () => verifyCloudflareReadback({ ...outputs, consumer: JSON.stringify(consumers) }, expected),
    /consumer read-back/u,
  );
});

test("rejects a Pages project with an automatic Git deployment source", () => {
  assert.throws(
    () =>
      verifyCloudflareReadback(
        {
          ...outputs,
          projects: JSON.stringify([
            {
              "Git Provider": "GitHub",
              "Project Name": expected.pagesProjectName,
            },
          ]),
        },
        expected,
      ),
    /disable Git-provider/u,
  );
});

test("requires the exact active Worker and Pages candidate when a commit is expected", () => {
  const commitSha = "a".repeat(40);
  const candidateExpected = {
    ...expected,
    commitSha,
    pagesBranch: "develop",
  };
  const candidateOutputs = {
    ...outputs,
    pagesDeployments: JSON.stringify([
      {
        Branch: "develop",
        Environment: "Production",
        Source: commitSha.slice(0, 7),
      },
    ]),
    pagesProject: JSON.stringify({
      deployment_configs: {
        production: {
          wrangler_config_hash: candidateExpected.pagesConfigHash,
        },
      },
      name: candidateExpected.pagesProjectName,
      production_branch: candidateExpected.pagesBranch,
    }),
    workerDeployment: JSON.stringify({
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: "version_candidate" }],
    }),
    workerVersion: JSON.stringify({
      resources: { bindings: [] },
    }),
    workerVersions: JSON.stringify([
      {
        annotations: {
          "workers/message": `release candidate ${commitSha}`,
          "workers/tag": `candidate-${commitSha}`,
        },
        id: "version_candidate",
      },
    ]),
  };
  assert.doesNotThrow(() => verifyCloudflareReadback(candidateOutputs, candidateExpected));
  assert.throws(
    () =>
      verifyCloudflareReadback(
        {
          ...candidateOutputs,
          workerDeployment: JSON.stringify({
            strategy: "percentage",
            versions: [{ percentage: 50, version_id: "version_candidate" }],
          }),
        },
        candidateExpected,
      ),
    /sole active version/u,
  );
  assert.throws(
    () =>
      verifyCloudflareReadback(
        {
          ...candidateOutputs,
          pagesProject: JSON.stringify({
            deployment_configs: {
              production: {
                wrangler_config_hash: "c".repeat(64),
              },
            },
            name: candidateExpected.pagesProjectName,
            production_branch: candidateExpected.pagesBranch,
          }),
        },
        candidateExpected,
      ),
    /deployed configuration/u,
  );
});
