# ADR 0074: contractを混在させずprovider execution互換schemaをexpandする

- Status: Accepted（Phase 11 local compatibility layer）
- Date: 2026-08-11
- Relates to: ADR 0066、ADR 0069、ADR 0071、ADR 0073
- Cloud mutation: なし
- Does not authorize: provider implementation selection、contract v2 product routing、staging/production変更

## Context

Phase 11はprovider-neutralなexecution aggregateとimmutable options snapshotを追加しつつ、migration後も
現行RunPod Serverless経路と旧codeを維持する必要がある。現行RunPod claim、worker、manifest、completionは
contract v1で接続されている。一方、bounded-memory contract v2はPhase 10Aでoffline検証しただけで、product
bootstrap、artifact capability、manifest v2、completionにはまだ接続していない。

この状態で既存または新規RunPod attemptをv2と記録すると、D1 snapshotだけがv2で実workerとcompletionはv1に
なり、同一attempt内のversion推測になる。逆に旧列をrenameまたは削除すると、rollbackした旧codeがactive attemptを
読めず、RunPod jobの観測、cancel、cleanupを失う。Phase 10C後のworker imageはPhase 10Bで測定したdigestとも異なり、
provider固有runtimeを先取りできない。

## Decision

- forward-only migration `0010_provider_execution_compatibility.sql`で、`job_attempts`へnullableな
  `provider_kind`、`provider_policy`、`execution_contract_version`、`execution_options_json`を追加する。4列は
  全NULLまたは全非NULLだけを許し、非NULLになったexecution identityとsnapshotはtriggerでimmutableにする。
- `provider_executions`をattemptと1対1のprovider-neutral aggregateとして追加し、provider kind/policy、create outcome、
  opaque handle、terminal observation、execution status、独立したcleanup status、versionを保持する。provider名とpolicyは
  bounded identifierだけをDBで許し、対応providerのallowlistはadapter境界で検証する。
- 適用時に全既存attemptを`runpod_serverless` / `runpod_serverless_v1` / contract v1としてbackfillする。新しい
  RunPod attemptも同じidentityと、jobのlanguage、VAD、model、selected output formatsを含むimmutable v1 snapshotを
  insert時に固定する。
- 現行RunPod列と`runpod_submissions`はrename、deleteしない。RunPod adapterの旧列更新をtriggerで
  `provider_executions`へdual-writeし、submission、claim、completion、cancel、retention、user deletion、notificationは
  旧列とaggregateのexact mirrorだけを処理する。不一致、欠落、terminal conflict、stale versionは外部providerやR2へ
  副作用を出さずfail closedする。
- migration前の旧codeとのexpand/rollback互換性のため、新列が全NULLでaggregateがないrowはlegacy rowとして読む。
  新codeが作るrowは必ず4列とaggregateを同時に持つ。部分bindingは拒否する。
- executionとcleanupの状態機械をdomainで分離する。cleanupのrequest、claim、finishはaggregate versionのCASを使い、
  duplicate、out-of-order、concurrent、stale transitionでは状態を進めない。
- migration schemaはcontract version 2を格納でき、readerはversionごとのexact schemaでparseするが、このPhaseではv2
  attemptを発行しない。v2はprovider固有bootstrap、capability、manifest、completionを同じreleaseで接続するPhase 13
  以降の新しいattemptだけで有効化し、v1 attemptを途中で昇格しない。

## Consequences

- migration後も旧codeは既存RunPod列を読み書きでき、新codeはRunPod-only動作を維持しながらdriftを検出できる。
- Phase 11計画の「attempt作成時にcontract v2へ固定」は、同一attemptのv1/v2混在禁止を優先してproduct接続Phaseまで
  延期する。これは機能の暗黙な省略ではなく、v2を安全に開始するための明示的なPhase境界である。
- provider aggregateは将来のprovider identifierをadditiveに保存できるが、Cloud Runその他のprovider adapter、resource、
  credential、environment switchは追加しない。provider implementation selectionは引き続き別ADRと明示承認が必要である。
- trigger dual-writeは移行期間のcompatibility mechanismであり、新provider実装のsource of truthにはしない。contract v2
  routing後の旧列縮退・削除は、rollback windowとactive v1 attemptが0になった後の別contract migrationで判断する。

## References

- [ADR 0066](./0066-design-ephemeral-gpu-vm-execution.md)
- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [ADR 0071](./0071-separate-provider-selection-from-production-adoption.md)
- [ADR 0073](./0073-use-adaptive-final-window-lookbehind.md)
- [implementation plan](../implementation-plan.md#phase-11-provider-neutral-compatibility-layer)
