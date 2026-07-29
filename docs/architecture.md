# ScribeDrop Architecture

この文書は、実装済みの信頼境界、データフロー、状態遷移、冪等性と障害回復の全体像を
示す。プロダクト要件は[spec.md](./spec.md)、実装順序と未完了項目は
[implementation-plan.md](./implementation-plan.md)、個別判断は[ADR](./adr/)を正とする。

## システム境界

```text
Browser
  ├─ Cloudflare Access ─ Pages / React PWA
  ├─ Access JWT + CSRF ─ Pages Functions /api/*
  └─ exact-object temporary capability ─ R2 incoming object

R2 event ─ Queue ─ Orchestrator Worker ─ typed RunPod HTTP client ─ RunPod Worker
                         │                                      │
                         ├─ D1 state / outbox                    └─ exact attempt R2 capability
                         ├─ R2 verification and cleanup
                         └─ Discord webhook
```

信頼できる入力は存在しない。Pages FunctionsはAccess JWTを再検証し、変更APIではさらに
Origin、JSON Content-Type、CSRF、`owner_sub`を検証する。R2 event、Queue message、
RunPod response、manifest、環境変数もZodまたはPydanticで境界検証する。D1のユーザー向け
queryはアプリケーション側の事後filterではなく、SQL自体に`owner_sub`条件を含める。

Browserには長期R2 credentialを渡さない。upload時は単一source keyとmultipart actionだけ、
RunPodには単一attempt prefixの必要actionだけ、download時は単一artifactのGETだけを許す
短期capabilityを発行する。署名URL、token、録音、文字起こし本文はlog、D1、browser
storageへ保存しない。

## コードの依存方向

- `packages/contracts`: HTTP、Queue、RunPod、manifestのschemaと公開型。
- `packages/domain`: 状態遷移、保持期限、capability失効などの純粋ロジック。
- `packages/observability`: allowlist済みeventとfieldだけを受ける構造化logger。
- `packages/test-support`: fake、fixture、固定clock/ID。production codeから参照しない。
- `apps/web`: React UI、Pages Functions、D1/R2 adapter。
- `apps/orchestrator`: Queue/Cron handler、RunPod/R2/Discord/D1 adapter。
- `apps/runpod-worker`: media再検証、Whisper処理、artifact/manifest生成。

app間を直接importせず、共有するschemaと純粋ロジックだけをpackageへ置く。Cloudflare、
AWS SDK、React、HTTP clientはdomainから外し、時刻、乱数、外部APIはport越しに差し替える。

## ジョブデータフロー

1. Browserが認証済みAPIへjob作成を要求する。D1はowner、期待size、optionsと
   `UPLOADING`状態を保存し、exact source key用の短期upload capabilityを返す。
2. BrowserがR2へmultipart uploadし、APIへ完了を通知する。APIはR2 HEADのsize、
   content type、ETagをD1の期待値と照合してから`UPLOADED`へ遷移する。
3. R2 eventをQueue consumerが再検証し、同じjobを二重投入せず`PENDING` attemptを作る。
4. OrchestratorがRunPodへ投入する。HTTP timeoutは失敗確定にせず`SUBMISSION_UNKNOWN`として
   reconciliationへ渡す。claim時は[ADR 0052](./adr/0052-attest-runpod-placement-before-claim.md)
   に従い、job status由来のworker IDとPod詳細からendpoint、実行状態、immutable image、
   許可GPU、Secure Cloudを照合する。照合済みWorkerだけがwinnerとなり処理を開始する。
5. RunPod workerはsourceを`/tmp`へstreaming downloadし、byte count、ffprobe、durationを
   再検証する。成果物とcomplete manifestをattempt固有prefixへ書き、一時領域を必ず消す。
6. CronがRunPod terminal statusをD1へ保存し、manifest schemaと各artifactのR2 HEADを
   検証する。active attemptとversionのCASを満たす一つだけがjobを`COMPLETED`にし、
   notification outboxを作る。
7. Browserはowner検証済みAPIから操作時だけexact artifact GET capabilityを取得して
   downloadする。API responseやartifact本文をservice workerへ渡さない。

## 状態遷移と競合制御

主要な正常系は次のとおりである。

```text
UPLOADING → UPLOADED → PENDING → SUBMITTING → RUNNING → COMPLETED
     │          │          │           │          ├────→ FAILED
     └→ EXPIRED └──────────┴───────────┴──────────┴────→ CANCELLED
                                     timeout → SUBMISSION_UNKNOWN → reconcile
```

retryはFAILED jobを上書きせず、新しいgeneration、attempt、token、result prefixを作る。
loser、stale generation、古いattemptはcurrent jobを更新できない。状態更新は期待status、
version、active attemptをWHERE条件に含むcompare-and-setであり、event、artifact、outboxは
一意制約を併用する。duplicate/out-of-order messageは成功済み状態を再利用するか安全な
conflictとして終了する。

RunPodがsubmissionを受理しても10分以内にwinner claimへ進まない場合は、
[ADR 0043](./adr/0043-bound-runpod-start-slo-and-staging-wait.md)に従ってactive attemptを
FAILEDへCAS遷移し、記録済みのexact provider jobだけをcancelする。cancel不確定時も
FAILEDをSUBMITTINGへ戻さず、Cronがcancelを再試行する。

単一GPUの供給不足をCIだけの問題として扱わない。
[ADR 0049](./adr/0049-pin-observed-runpod-capacity.md)に従い、stagingとproductionは
実APIで保持を確認した同じSecure-only GPU候補を使用し、promotion時に公式REST APIで
GPU順序の完全一致をread-backする。検証不能なdata center固定は行わない。全候補が
不足した場合も開始SLO、FAILEDへのCAS、exact cancelを維持し、無期限待機や同じattemptの
自動再投入は行わない。

staging release gateでは[ADR 0051](./adr/0051-prewarm-staging-before-job-creation.md)に従い、
一時的に`workersMin=1`としてcandidate Workerの実割り当てとreadinessを確認してから
synthetic jobを作る。全結果で`workersMin=0`へ戻し、productionのFlex構成を常時Activeへ
暗黙に変更しない。inventoryの`available`はpromotion前提であり、ready evidenceではない。

## 削除と保持期限

ユーザー削除はowner/CSRF検証後に`deleted_at`をCAS更新し、通常APIから直ちに隠す。
heartbeatを失効させ、`deletion_not_before`の前後にかかわらず既知RunPod jobのcancelを
確認する。最後のR2 capabilityの最大寿命とgraceが過ぎてからD1由来のexact source keyと
全attempt prefixだけを削除する。R2不存在は成功扱い、
失敗は上限付きbackoffで再試行し、すべてのobject不存在を確認してからD1親rowをcascade
物理削除する。長期tombstoneは残さない。詳細は
[ADR 0018](./adr/0018-asynchronous-user-deletion.md)を参照する。

通常保持期限はsource、attempt results、job auditを独立して回収する。source削除後は
同じ録音を使うretryを拒否するが、resultsはその期限までdownloadできる。R2 lifecycleは
application cleanup停止時の最終防衛であり、D1 cleanup完了の根拠にはしない。監査期限は
ユーザー削除と同じ物理削除pipelineへ収束する。詳細は
[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)を参照する。

## PWAと端末上のデータ

service workerがinterceptできるのはsame-originのGETかつ、build済み`/assets/`または
review済みpublic static pathだけである。`/api/*`、artifact path、cross-origin、
non-GETはinterceptしない。navigationはnetwork-onlyで、失敗時だけ本文を持たない固定
offline pageを返す。cache前にresponseがsame-origin、非redirect、`basic`、成功応答で
あることを再検証し、Access login responseを保存しない。

IndexedDBは中断uploadを利用者に案内する最小metadataだけを保持し、CSRF、credential、
署名URL、音声、文字起こし本文を保存しない。job削除時は対応するcheckpointも削除する。

## 障害回復と観測

- Queue、upload-complete、claim、finalize、notification、cancel、delete、retentionは
  複数回実行されても安全にする。
- 外部APIはtimeout、応答schema、retryable/permanent/conflict/cancelledを分類する。
- Cronは期限切れupload、結果不明submission、terminal result、outbox、削除、retentionを
  収束させる。RunPod result保持期限内にterminal状態を観測できない場合はfail closedにする。
- logはallowlist event/fieldだけをJSON出力し、raw exception、URL query、本文、メール、
  object key/prefixを含めない。
- DLQ、replay、alert、手動回復は[operations.md](./operations.md)、secretとdeploy順序は
  [deployment.md](./deployment.md)を参照する。
