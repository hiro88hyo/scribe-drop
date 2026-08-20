import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(projectDirectory, "../../migrations");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: path.join(projectDirectory, "src/index.ts"),
      miniflare: {
        bindings: {
          APP_ENV: "local",
          AUDIT_RETENTION_DAYS: "180",
          CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          GPU_EXECUTION_POLICY: "runpod_serverless_v1",
          MULTIPART_RETENTION_HOURS: "24",
          R2_ACCESS_KEY_ID: "r2-access-key-placeholder",
          R2_BUCKET_NAME: "recording-transcriber-test",
          R2_SECRET_ACCESS_KEY: "0000000000000000",
          RESULT_RETENTION_DAYS: "90",
          RUNPOD_ALLOWED_GPU_IDS:
            "NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition",
          RUNPOD_API_KEY: "runpod-api-key-placeholder",
          RUNPOD_ENDPOINT_ID: "endpoint-placeholder",
          RUNPOD_INTERNAL_BASE_URL: "https://orchestrator.example.invalid",
          RUNPOD_WORKER_IMAGE: "ghcr.io/example/scribe-drop-runpod-worker@sha256:" + "a".repeat(64),
          SOURCE_RETENTION_DAYS: "7",
          TEST_MIGRATIONS: await readD1Migrations(migrationsDirectory),
        },
        compatibilityDate: "2026-07-25",
        d1Databases: {
          SCRIBE_DROP_DB: "00000000-0000-0000-0000-000000000401",
        },
        r2Buckets: ["RECORDINGS"],
      },
    })),
  ],
  resolve: {
    alias: {
      "@scribe-drop/contracts": path.resolve(
        projectDirectory,
        "../../packages/contracts/src/index.ts",
      ),
      "@scribe-drop/domain": path.resolve(projectDirectory, "../../packages/domain/src/index.ts"),
      "@scribe-drop/observability": path.resolve(
        projectDirectory,
        "../../packages/observability/src/index.ts",
      ),
      "@scribe-drop/test-support": path.resolve(
        projectDirectory,
        "../../packages/test-support/src/index.ts",
      ),
    },
  },
  root: projectDirectory,
  test: {
    include: ["tests/**/*.worker.spec.ts"],
    reporters: ["default"],
  },
});
