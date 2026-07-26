import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";
import { describe, expect, it, vi } from "vitest";

import type { DiscordClient } from "./discord-client.js";
import type {
  NotificationDelivery,
  NotificationOutboxRepository,
} from "./notification-outbox-repository.js";
import { dispatchNextNotification, type NotificationEnvironment } from "./notification-service.js";

const NOW = new Date("2026-07-25T01:00:00.000Z");
const DELIVERY: NotificationDelivery = {
  attemptCount: 1,
  durationSeconds: 3723,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  runpodExecutionMs: 258_000,
  title: "Weekly\nmeeting @everyone",
};

function environment(overrides: Partial<NotificationEnvironment> = {}): NotificationEnvironment {
  return {
    APP_ENV: "local",
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test-token",
    SCRIBE_DROP_DB: {} as D1Database,
    WEB_BASE_URL: "http://localhost:5173",
    ...overrides,
  };
}

function logger(records: string[]): StructuredLogger {
  return createStructuredLogger({
    environment: "local",
    now: () => NOW,
    service: "orchestrator",
    sink: (record) => {
      records.push(record);
    },
  });
}

function repository(
  overrides: Partial<NotificationOutboxRepository> = {},
): NotificationOutboxRepository {
  return {
    claimNext: () => Promise.resolve(DELIVERY),
    markSent: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("notification service", () => {
  it("sends an allowlisted message and acknowledges the lease", async () => {
    let content = "";
    const send = vi.fn<DiscordClient["send"]>((value) => {
      content = value;
      return Promise.resolve({ outcome: "sent" });
    });
    const markSent = vi.fn<NotificationOutboxRepository["markSent"]>(() => Promise.resolve(true));
    const records: string[] = [];

    await expect(
      dispatchNextNotification(environment(), logger(records), {
        createClient: () => ({ send }),
        createRepository: () => repository({ markSent }),
        now: () => NOW,
      }),
    ).resolves.toBe("sent");

    expect(content).toContain("Weekly meeting @everyone");
    expect(content).toContain("音声時間: 1時間2分3秒");
    expect(content).toContain("処理時間: 4分18秒");
    expect(content).toContain(`http://localhost:5173/jobs/${DELIVERY.jobId}`);
    expect(markSent).toHaveBeenCalledWith(DELIVERY, NOW.toISOString());
    expect(records.join("\n")).not.toContain(content);
    expect(records.join("\n")).toContain('"event":"notification.sent"');
  });

  it("releases retryable failures with bounded backoff and rejects permanent failures", async () => {
    const release = vi.fn<NotificationOutboxRepository["release"]>(() => Promise.resolve(true));
    await expect(
      dispatchNextNotification(environment(), logger([]), {
        createClient: () => ({
          send: () => Promise.resolve({ outcome: "unavailable" }),
        }),
        createRepository: () => repository({ release }),
        now: () => NOW,
        random: () => 0,
      }),
    ).resolves.toBe("deferred");
    expect(release).toHaveBeenCalledWith({
      delivery: DELIVERY,
      errorCode: "DISCORD_UNAVAILABLE",
      nextAttemptAt: "2026-07-25T01:00:01.000Z",
      status: "PENDING",
    });

    release.mockClear();
    await expect(
      dispatchNextNotification(environment(), logger([]), {
        createClient: () => ({
          send: () => Promise.resolve({ outcome: "rate_limited" }),
        }),
        createRepository: () => repository({ release }),
        now: () => NOW,
        random: () => 0,
      }),
    ).resolves.toBe("deferred");
    expect(release).toHaveBeenCalledWith({
      delivery: DELIVERY,
      errorCode: "DISCORD_RATE_LIMITED",
      nextAttemptAt: "2026-07-25T01:00:01.000Z",
      status: "PENDING",
    });

    release.mockClear();
    await expect(
      dispatchNextNotification(environment(), logger([]), {
        createClient: () => ({
          send: () => Promise.resolve({ outcome: "permanent_failure" }),
        }),
        createRepository: () => repository({ release }),
        now: () => NOW,
      }),
    ).resolves.toBe("dead");
    expect(release).toHaveBeenCalledWith({
      delivery: DELIVERY,
      errorCode: "DISCORD_REJECTED",
      nextAttemptAt: null,
      status: "DEAD",
    });

    release.mockClear();
    const exhaustedDelivery = {
      ...DELIVERY,
      attemptCount: 8,
    };
    await expect(
      dispatchNextNotification(environment(), logger([]), {
        createClient: () => ({
          send: () => Promise.resolve({ outcome: "unavailable" }),
        }),
        createRepository: () =>
          repository({
            claimNext: () => Promise.resolve(exhaustedDelivery),
            release,
          }),
        now: () => NOW,
      }),
    ).resolves.toBe("dead");
    expect(release).toHaveBeenCalledWith({
      delivery: exhaustedDelivery,
      errorCode: "DISCORD_UNAVAILABLE",
      nextAttemptAt: null,
      status: "DEAD",
    });
  });

  it("does not claim an outbox row when notification configuration is missing", async () => {
    const createRepository = vi.fn();
    await expect(
      dispatchNextNotification(
        {
          APP_ENV: "local",
          SCRIBE_DROP_DB: {} as D1Database,
          WEB_BASE_URL: "http://localhost:5173",
        },
        logger([]),
        { createRepository, now: () => NOW },
      ),
    ).resolves.toBe("configuration_missing");
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("rejects a localhost Web URL outside the local environment", async () => {
    const createRepository = vi.fn();
    await expect(
      dispatchNextNotification(
        environment({
          APP_ENV: "staging",
        }),
        logger([]),
        { createRepository, now: () => NOW },
      ),
    ).resolves.toBe("configuration_missing");
    expect(createRepository).not.toHaveBeenCalled();
  });
});
