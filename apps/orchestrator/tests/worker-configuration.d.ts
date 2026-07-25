import type { UploadQueueEnvironment } from "../src/upload-queue-consumer.js";

declare global {
  namespace Cloudflare {
    interface Env extends UploadQueueEnvironment {
      readonly TEST_MIGRATIONS: {
        name: string;
        queries: string[];
      }[];
    }

    interface GlobalProps {
      mainModule: {
        default: ExportedHandler<UploadQueueEnvironment>;
      };
    }
  }
}

export {};
