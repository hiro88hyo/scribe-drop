import type { CloudRunRuntimeShadowEnvironment } from "../src/cloud-run-runtime-shadow.js";
import type { UploadQueueEnvironment } from "../src/upload-queue-consumer.js";
import type { RunpodHttpEnvironment } from "../src/runpod-http-handler.js";

declare global {
  namespace Cloudflare {
    interface Env
      extends UploadQueueEnvironment, RunpodHttpEnvironment, CloudRunRuntimeShadowEnvironment {
      readonly TEST_MIGRATIONS: {
        name: string;
        queries: string[];
      }[];
    }

    interface GlobalProps {
      mainModule: {
        default: ExportedHandler<
          UploadQueueEnvironment & RunpodHttpEnvironment & CloudRunRuntimeShadowEnvironment
        >;
      };
    }
  }
}

export {};
