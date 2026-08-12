# ADR 0075: adaptive EOF workerをprovider選定前に再実測する

- Status: Accepted（`Adopt candidate`、Implementation selectedではない）
- Date: 2026-08-11
- Relates to: ADR 0069、ADR 0070、ADR 0071、ADR 0073、ADR 0074
- Followed by: ADR 0076（Cloud Run Jobsをsynthetic-only `Implementation selected`）
- Cloud mutation: exact one executionとevidence取得後、全専用resource cleanup済み
- Does not authorize: 追加GPU execution、Implementation selected、provider switch、staging/production変更

## Context

ADR 0070のPhase 10B Cloud Run実測は、bounded-memory 8時間経路がL4、4 vCPU、16 GiBで事前の時間・memory・
cleanup基準を満たすことを示した。その後ADR 0073で、EOF final windowだけをrolling上限内で過去側へ拡張し、
重複promptを抑止する変更を行った。変更後worker imageはPhase 10CのGPU 0 CUDA/float16 quality gateを通過したが、
Phase 10Bで実行したimageとはdigestが異なる。

adaptive EOFは最大960秒という既存window上限を増やさない一方、最終partial coreのinference量を増やし得る。
したがって旧imageの254秒、memory 0.578 GiB、GPU memory 2.363 GiBというCloud Run evidenceを新imageへ継承して
`Technical candidate`または`Implementation selected`の根拠にできない。Phase 11のprovider-neutral migrationは
provider switchを持たないため独立して完了できたが、Phase 12のprovider固有controllerは開始できない。

## Decision

- [adaptive EOF Cloud Run revalidation packet](../cloud-run-adaptive-eof-revalidation.md)を新digest専用のsource of truthとする。
- exact candidateはPhase 10Cでbuild・scan・native quality gateを通過したlocal `linux/amd64` worker image
  `sha256:a7a4c13de2055555945a2823ff5a4494c63e707a61990b75eb1f7e662d080d48`とする。cloud preparationで
  registryへpushする場合は再buildせず、remote manifest digestをread-backして同じlocal imageとの対応を固定する。
- cloud前の追加gateとして、同じimageをGPU 0、networkなし、read-only、3 GiB tmpfsで8時間bounded benchmark
  entrypointへ通す。2026-08-11のrunは約108秒、exit 0、allowlist success marker 1で完了した。
- Cloud Run構成はPhase 10Bと同じL4 1、4 vCPU、16 GiB、task/parallelism 1、retry 0、timeout 55分、
  `asia-southeast1`、3 GiB size-limited in-memory scratchとする。region、GPU、resource、timeoutを成功しやすい値へ
  変更しない。
- resource preparationとexact one executionを別承認にする。本文書、packet、local testはどちらも承認しない。
  preparation前にbilling、API、IAM、quota、同名resource 0、最新単価、220円相当上限を一括read-backする。
- executionは新candidateでexact 1件だけ許可し、response不明、timeout、metric欠測、failureでも再実行しない。
  旧Phase 10Bと同じdecision tableで判定し、全専用resource不存在と課金停止を独立確認する。
- revalidationが`Adopt candidate`を満たした後も自動的にproviderを選定しない。provider API、identity、IAM、network、
  data location、create/reconcile、費用、cleanupを別の`Implementation selected` ADRで固定するまでPhase 12をBlockedにする。
- 2026-08-11のresource preparation承認後preflightではbilling、API 6/6、capability 23/23、L4 no-zonal quota 3、
  同名resource各0、local image一致が成立した。一方、Billing Catalogの通常Jobs JPY単価による55分computeは188.499円、
  10%税を含め207.349円となり、repository reserve前に200円上限を超えた。このためresourceを作成せず停止する。
- 利用者の別の明示承認に基づき、他のmanifestを変えず費用上限だけを220円へ改定する。有料storage tier、free tierなし、
  remote圧縮なしの24時間reserveを含む小計は192.133円、10%税後211.347円であり、新上限以内である。
- 最初のpreparation attemptはremote digest validatorの未保証な`tags[]`表現依存によりJob作成前に停止し、全resourceを
  補償削除して各0を独立確認した。documented digest/fully-qualified digest同時照合へ修正後、resource 0からcorrected
  preparationを行い、repository/image/runtime identity/未実行Job各1、manifest 27/27、runtime role 0、execution 0を
  作成処理と別processの両方で確認した。
- exact one executionの別承認後、execution直前にもmanifest 27/27、digest、role/key 0、execution 0、最新費用
  211.347円以内を確認した。local durable intent後にrequestを一度だけ送り、execution 1件だけを回収した。pending conditionを
  terminalと誤分類した最初のmonitorはexecuteを再送せず、同一executionのcorrected monitorへ回復した。
- executionは271.965秒でsuccess、attempt/marker各1、failure/retry/cancel/platform error各0だった。billable 242.318秒、
  peak container memory 0.818119 GiB、tmpfs 0.007904 GiB、GPU memory 2.363281 GiB、GPU utilization 100%、
  必須metric 7/7で、事前基準をすべて満たすため`Adopt candidate`と判定する。
- evidence後にJob/execution、repository/image、runtime identityを削除し、別processで各0とrunning task 0を確認した。
  application logは合成fixtureのallowlist markerだけで、raw log、本文、resource IDをrepositoryへ保存していない。

## Consequences

- algorithm変更後candidateのperformanceを実測せず、旧evidenceやlocal RTX 5070 Tiの時間からCloud Run L4性能を
  推測することを防げる。
- local 8時間native成功はimage、CUDA、model、bounded core、artifact、cleanupのpreconditionを強めるが、L4 capacity、
  Cloud Run課金時間、platform memory/tmpfs/GPU metricの代替にはならない。
- Phase 11のmigrationとRunPod-only互換動作は維持する。contract v2 routing、Cloud Run credential、resource、CI、
  environment switchは追加しない。
- 本ADR完了時のterminal stateは「Phase 10D `Adopt candidate`、全専用resource 0、Phase 12 Blocked」だった。旧Phase
  10Bからalgorithm変更後candidateへtechnical evidenceを更新できたが、本ADR自体はprovider implementation selectionでは
  ない。後続ADR 0076がsynthetic-only実装を選定した後も、追加execution、cloud resource、credential、CI、environment
  switch、staging/productionは別Phaseのgateと明示承認なしに開始しない。

## References

- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [ADR 0070](./0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0071](./0071-separate-provider-selection-from-production-adoption.md)
- [ADR 0073](./0073-use-adaptive-final-window-lookbehind.md)
- [ADR 0074](./0074-expand-provider-execution-compatibility-without-mixing-contracts.md)
- [ADR 0076](./0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)
- [adaptive EOF Cloud Run revalidation packet](../cloud-run-adaptive-eof-revalidation.md)
