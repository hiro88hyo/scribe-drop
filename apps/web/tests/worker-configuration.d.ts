import type { WebEnvironment } from "../src/server/web-context.js";

declare global {
  namespace Cloudflare {
    interface Env extends WebEnvironment {
      readonly TEST_MIGRATIONS: {
        name: string;
        queries: string[];
      }[];
    }

    interface GlobalProps {
      mainModule: {
        default: ExportedHandler<WebEnvironment>;
      };
    }
  }
}

export {};
