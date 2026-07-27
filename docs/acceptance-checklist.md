# ScribeDrop acceptance checklist

## 状態と範囲

- 評価日: 2026-07-27 UTC
- 対象: Phase 1からPhase 7のlocal、CI、staging checkpoint
- 結果: Phase 7までのbaselineは確認済み。現在のrelease candidateはstaging再検証待ち
- 対象外: production deploymentとAndroid Share Target。Share Targetは仕様どおり別PRとする

実account、domain、resource/deployment ID、credential、利用者dataはこのchecklistへ
保存しない。手動確認の詳細はenvironment別deployment recordを参照する。

Pixelの`.m4a` file picker対応はmock browser E2Eだけを通し、実R2、Queue、RunPodを使う
staging acceptance前にproductionへdeployされた。従来のPassはこの変更のpromotion
evidenceとして使用しない。[ADR 0023](./adr/0023-promote-only-staging-verified-artifacts.md)
に従い、同じrelease candidateで実service E2Eと対象実機smokeを完了するまでrelease判断を
Blockedとする。

## UX

| 受け入れ条件                              | 状態    | 主な証跡                                                                                                                                                                                  |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCでdrag-and-dropできる                   | Pass    | `apps/e2e/tests/input-accessibility.spec.ts`                                                                                                                                              |
| Android相当環境でfile chooserを使用できる | Pending | Playwrightの`.m4a` media type検証は成功。Pixel実機のstaging smokeと実service E2Eをやり直す                                                                                                |
| upload進捗を表示する                      | Pass    | `apps/e2e/tests/job-lifecycle.spec.ts`、`apps/web/src/client/multipart-uploader.test.ts`                                                                                                  |
| 通信失敗から再試行できる                  | Pass    | `apps/e2e/tests/job-lifecycle.spec.ts`                                                                                                                                                    |
| upload後に画面を閉じても処理が継続する    | Pass    | page close後に新pageの履歴・詳細から待機、実行、完了を復元する`apps/e2e/tests/job-lifecycle.spec.ts`、Queue/RunPodの[Phase 5 staging record](./deployments/2026-07-26-phase-5-staging.md) |
| 後から履歴を確認できる                    | Pass    | `apps/e2e/tests/job-lifecycle.spec.ts`、`apps/web/tests/jobs.worker.spec.ts`                                                                                                              |
| 完了時にDiscord通知が届く                 | Pass    | `apps/orchestrator/tests/notification-outbox.worker.spec.ts`、[Phase 5 staging record](./deployments/2026-07-26-phase-5-staging.md)                                                       |

## Security

| 受け入れ条件                              | 状態 | 主な証跡                                                                                                                                                      |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google loginを必須にする                  | Pass | [Cloudflare Access runbook](./cloudflare-access.md)、[Phase 3 staging record](./deployments/2026-07-25-phase-3-staging.md)                                    |
| allowlist外の利用者を拒否する             | Pass | Accessのexact email allowlistとIdP requirementを確認した[Phase 3 staging record](./deployments/2026-07-25-phase-3-staging.md)                                 |
| すべてのAPIでAccess JWTを再検証する       | Pass | `apps/web/tests/authentication.worker.spec.ts`、`apps/web/tests/security.worker.spec.ts`                                                                      |
| 別利用者のjobとartifactへアクセスできない | Pass | `apps/web/tests/jobs.worker.spec.ts`                                                                                                                          |
| R2 bucketを非公開にする                   | Pass | [Cloudflare Access runbook](./cloudflare-access.md)、object単位capabilityを確認した[Phase 3 staging record](./deployments/2026-07-25-phase-3-staging.md)      |
| browserへ長期R2 credentialを渡さない      | Pass | `apps/web/tests/r2-temporary-credentials.test.ts`、[ADR 0008](./adr/0008-r2-browser-upload-capability.md)                                                     |
| RunPodへR2 credentialを渡さない           | Pass | `apps/orchestrator/src/runpod-submission-service.test.ts`、`apps/orchestrator/src/runpod-client.test.ts`                                                      |
| Discordへ文字起こし本文を送らない         | Pass | `apps/orchestrator/src/notification-service.test.ts`                                                                                                          |
| logへ音声、本文、token、署名URLを出さない | Pass | `packages/observability/src/logger.test.ts`、`apps/runpod-worker/tests/test_logger.py`、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md) |

## Reliability

| 受け入れ条件                                                        | 状態 | 主な証跡                                                                                                          |
| ------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| R2 event重複でattemptを増やさない                                   | Pass | `apps/orchestrator/tests/upload-queue.worker.spec.ts`                                                             |
| Queue再送でRunPod結果を二重反映しない                               | Pass | `apps/orchestrator/tests/upload-queue.worker.spec.ts`、`apps/orchestrator/tests/completion.worker.spec.ts`        |
| 重複`/run`でもwinnerは1つ                                           | Pass | `apps/orchestrator/tests/runpod-control.worker.spec.ts`                                                           |
| loserはWhisperを開始しない                                          | Pass | `apps/orchestrator/tests/runpod-control.worker.spec.ts`、`apps/runpod-worker/tests/test_service.py`               |
| 重複status poll/Cronでもnotification outboxは1件                    | Pass | `apps/orchestrator/tests/completion.worker.spec.ts`、`apps/orchestrator/tests/notification-outbox.worker.spec.ts` |
| provider保持期間内にterminal statusを保存し、未観測を誤完了にしない | Pass | `apps/orchestrator/tests/completion.worker.spec.ts`                                                               |
| 古いattemptの完了で現在attemptを上書きしない                        | Pass | `apps/orchestrator/tests/completion.worker.spec.ts`                                                               |
| manifestなしを`COMPLETED`にしない                                   | Pass | `apps/orchestrator/tests/completion.worker.spec.ts`                                                               |

## Additional RunPod security

| 追加受け入れ条件                                       | 状態 | 主な証跡                                                                                                                            |
| ------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/run` payloadにpresigned URLを含めない                | Pass | `apps/orchestrator/src/runpod-client.test.ts`、`apps/runpod-worker/tests/test_contracts.py`                                         |
| `/run` payloadに個人情報を含めない                     | Pass | `apps/orchestrator/src/runpod-submission-service.test.ts`                                                                           |
| claim成功前に音声を取得しない                          | Pass | `apps/runpod-worker/tests/test_service.py`                                                                                          |
| claim成功前にWhisper modelをloadしない                 | Pass | `apps/runpod-worker/tests/test_service.py`、`apps/runpod-worker/tests/test_transcription.py`                                        |
| RunPodへR2 Access Keyを渡さない                        | Pass | `/run` minimal contractとclaim時URL発行を検証する`apps/orchestrator/src/runpod-claim-service.test.ts`                               |
| RunPod resultへ文字起こし本文を含めない                | Pass | `apps/runpod-worker/tests/test_contracts.py`、`apps/runpod-worker/tests/test_service.py`                                            |
| RunPod logへ本文、URL、tokenを含めない                 | Pass | `apps/runpod-worker/tests/test_logger.py`、`apps/runpod-worker/tests/test_service.py`                                               |
| workerが永続storageを使用しない                        | Pass | read-only/networkなしcontainer checkと[RunPod runbook](./runpod.md)                                                                 |
| modelをimageへ内包し、runtime取得しない                | Pass | `apps/runpod-worker/tests/test_model_bundle.py`、`apps/runpod-worker/tests/test_config.py`                                          |
| container imageとmodel revisionを固定する              | Pass | digest/revision照合を記録した[Phase 5 staging record](./deployments/2026-07-26-phase-5-staging.md)、`tools/versions.json`           |
| manifestなしを完了扱いにしない                         | Pass | `apps/orchestrator/tests/completion.worker.spec.ts`                                                                                 |
| 利用者削除後に全関連R2 dataを削除する                  | Pass | `apps/orchestrator/tests/deletion.worker.spec.ts`、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md)            |
| 主要SSRF patternを拒否する                             | Pass | `apps/runpod-worker/tests/test_url_policy.py`、`apps/runpod-worker/tests/test_http_client.py`                                       |
| RunPod/Cloudflare障害時も機密情報をerror logへ出さない | Pass | `packages/observability/src/logger.test.ts`、`apps/runpod-worker/tests/test_errors.py`、[failure injection](./failure-injection.md) |

## Phase 7 operational criteria

| 条件                                                             | 状態 | 主な証跡                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| installable manifest、service worker、offline案内がある          | Pass | `scripts/web-document-security.test.mjs`、`scripts/service-worker-security.test.mjs`、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md)                             |
| API、artifact、認証済みresponse、本文をCache Storageへ保存しない | Pass | `apps/e2e/tests/pwa-cache.spec.ts`、[ADR 0020](./adr/0020-cache-only-public-pwa-shell-assets.md)                                                                                        |
| source、result、監査情報を独立期限で回収する                     | Pass | `apps/orchestrator/tests/retention.worker.spec.ts`、[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md) |
| 利用者deleteを優先し、capability安全期限後に物理削除する         | Pass | `apps/orchestrator/tests/deletion.worker.spec.ts`、[ADR 0018](./adr/0018-asynchronous-user-deletion.md)、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md)          |
| R2 lifecycleをapplication cleanupの最終防衛にする                | Pass | `scripts/cloudflare-environment-config.test.mjs`、[Phase 7 staging record](./deployments/2026-07-26-phase-7-staging.md)                                                                 |
| keyboard、focus、screen reader、mobile幅を確認する               | Pass | `apps/e2e/tests/input-accessibility.spec.ts`、`apps/e2e/tests/job-lifecycle.spec.ts`                                                                                                    |

## Verification

localの標準suiteは次で再現する。

```text
pnpm check
pnpm test:e2e
pnpm secrets:check
pnpm security:audit
```

Phase 7までのCIとstaging手動確認はPhase別deployment recordを正とする。現在のrelease
candidateは変更後のrequired CI、container supply-chain、実service staging acceptanceを
すべてやり直し、candidate manifestへ結び付けるまでproduction promotion evidenceとしない。
