import {
  buildPagesASSETSBinding,
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));
const migrationsDirectory = path.resolve(projectDirectory, "../../migrations");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: path.join(projectDirectory, ".wrangler/functions-test/index.js"),
      miniflare: {
        bindings: {
          ACCESS_AUDIENCES: '["test-access-audience"]',
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ALLOWED_ORIGIN: "https://example.test",
          APP_ENV: "local",
          CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          CSRF_HMAC_SECRET: "local-only-test-csrf-secret-at-least-32-bytes",
          OWNER_HASH_HMAC_SECRET: "local-only-test-owner-secret-at-least-32-bytes",
          R2_PARENT_ACCESS_KEY_ID: "local-only-test-r2-access-key",
          R2_PARENT_SECRET_ACCESS_KEY: "local-only-test-r2-secret-at-least-32-bytes",
          R2_BUCKET_NAME: "recording-transcriber-test",
          TEST_MIGRATIONS: await readD1Migrations(migrationsDirectory),
        },
        compatibilityDate: "2026-07-25",
        d1Databases: {
          SCRIBE_DROP_DB: "00000000-0000-0000-0000-000000000301",
        },
        serviceBindings: {
          ASSETS: await buildPagesASSETSBinding(path.join(projectDirectory, "dist")),
        },
      },
    })),
  ],
  root: projectDirectory,
  test: {
    include: ["tests/**/*.worker.spec.ts"],
    reporters: ["default"],
  },
});
