import type { CloudRunRuntimeCompositionEnvironment } from "../src/cloud-run-runtime-composition.js";
import type { UploadQueueEnvironment } from "../src/upload-queue-consumer.js";
import type { RunpodHttpEnvironment } from "../src/runpod-http-handler.js";

declare global {
  namespace Cloudflare {
    interface Env
      extends UploadQueueEnvironment, RunpodHttpEnvironment, CloudRunRuntimeCompositionEnvironment {
      readonly TEST_MIGRATIONS: {
        name: string;
        queries: string[];
      }[];
    }

    interface GlobalProps {
      mainModule: {
        default: ExportedHandler<
          UploadQueueEnvironment & RunpodHttpEnvironment & CloudRunRuntimeCompositionEnvironment
        >;
      };
    }
  }
}

export {};
