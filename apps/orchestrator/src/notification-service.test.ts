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
  jobVersion: 1,
  runpodExecutionMs: 258_000,
  terminalStatus: "COMPLETED",
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
    enqueueNextTerminal: () => Promise.resolve(false),
    markSent: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("notification service", () => {
  it("sends an allowlisted message and acknowledges the lease", async () => {
    let content = "";
    const order: string[] = [];
    const send = vi.fn<DiscordClient["send"]>((value) => {
      order.push("send");
      content = value;
      return Promise.resolve({ outcome: "sent" });
    });
    const enqueueNextTerminal = vi.fn<NotificationOutboxRepository["enqueueNextTerminal"]>(() => {
      order.push("enqueue");
      return Promise.resolve(false);
    });
    const claimNext = vi.fn<NotificationOutboxRepository["claimNext"]>(() => {
      order.push("claim");
      return Promise.resolve(DELIVERY);
    });
    const markSent = vi.fn<NotificationOutboxRepository["markSent"]>(() => Promise.resolve(true));
    const records: string[] = [];

    await expect(
      dispatchNextNotification(environment(), logger(records), {
        createClient: () => ({ send }),
        createNotificationId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        createRepository: () =>
          repository({
            claimNext,
            enqueueNextTerminal,
            markSent,
          }),
        now: () => NOW,
      }),
    ).resolves.toBe("sent");

    expect(order).toEqual(["enqueue", "claim", "send"]);
    expect(content).toContain("Weekly meeting @everyone");
    expect(content).toContain("音声時間: 1時間2分3秒");
    expect(content).toContain("処理時間: 4分18秒");
    expect(content).toContain(`http://localhost:5173/jobs/${DELIVERY.jobId}`);
    expect(markSent).toHaveBeenCalledWith(DELIVERY, NOW.toISOString());
    expect(records.join("\n")).not.toContain(content);
    expect(records.join("\n")).toContain('"event":"notification.sent"');
  });

  it("sends a failure notification without completion-only metadata", async () => {
    let content = "";
    const send = vi.fn<DiscordClient["send"]>((value) => {
      content = value;
      return Promise.resolve({ outcome: "sent" });
    });
    const delivery: NotificationDelivery = {
      attemptCount: 1,
      durationSeconds: null,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      jobVersion: 1,
      runpodExecutionMs: null,
      terminalStatus: "FAILED",
      title: "Capacity test",
    };

    await expect(
      dispatchNextNotification(environment(), logger([]), {
        createClient: () => ({ send }),
        createNotificationId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        createRepository: () =>
          repository({
            claimNext: () => Promise.resolve(delivery),
          }),
        now: () => NOW,
      }),
    ).resolves.toBe("sent");

    expect(content).toContain("文字起こしに失敗しました");
    expect(content).toContain("新しい試行で再実行してください");
    expect(content).toContain(`http://localhost:5173/jobs/${delivery.jobId}`);
    expect(content).not.toContain("音声時間");
    expect(content).not.toContain("処理時間");
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

  it("injects a retryable notification outage only for the leased staging job", async () => {
    const release = vi.fn<NotificationOutboxRepository["release"]>(() => Promise.resolve(true));
    const createClient = vi.fn(() => ({
      send: vi.fn<DiscordClient["send"]>(() => Promise.resolve({ outcome: "sent" })),
    }));
    await expect(
      dispatchNextNotification(
        environment({
          APP_ENV: "staging",
          STAGING_ACCEPTANCE_FAULT: "notification_unavailable",
          STAGING_ACCEPTANCE_FAULT_EXPIRES_AT: "2026-07-25T01:30:00.000Z",
          STAGING_ACCEPTANCE_FAULT_ISSUED_AT: "2026-07-25T01:00:00.000Z",
          STAGING_ACCEPTANCE_FAULT_JOB_ID: DELIVERY.jobId,
          WEB_BASE_URL: "https://staging.example.invalid",
        }),
        logger([]),
        {
          createClient,
          createRepository: () => repository({ release }),
          now: () => NOW,
          random: () => 0,
        },
      ),
    ).resolves.toBe("deferred");

    expect(createClient).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({
      delivery: DELIVERY,
      errorCode: "DISCORD_UNAVAILABLE",
      nextAttemptAt: "2026-07-25T01:00:01.000Z",
      status: "PENDING",
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
