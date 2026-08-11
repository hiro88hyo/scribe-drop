# ADR 0070: bounded-memory Cloud Run probeをAdopt candidateとして記録する

- Status: Accepted
- Date: 2026-08-10
- Target release if product adoption is accepted: `0.2.0`
- Relates to: ADR 0067、ADR 0068、ADR 0069
- Does not authorize: product provider採用、実録音、staging/production変更、追加GPU execution

## Context

[ADR 0068](./0068-benchmark-cloud-run-eight-hour-input.md)の8時間一括benchmarkは、L4、4 vCPU、
16 GiBでmemory limitにより失敗した。[ADR 0069](./0069-use-bounded-memory-transcription-windows.md)では
入力全体を一つのarrayへdecodeせず、15分core、前後30秒context、single FFmpeg、bounded spool、逐次artifact、
manifest-lastで処理するprovider非依存coreを提案した。Phase 10Aのlocal gateは、最大8時間を32 windowで処理し、
buffer、spool、artifact、cleanup、contract parityを固定candidate image内で検証した。

Phase 10Bは、同じimageをCloud Run Jobへdigest固定し、L4 1台、4 vCPU、16 GiB、3 GiB size-limited
in-memory scratch、task/parallelism 1、retry 0、timeout 55分でexact one executionだけを許可した。
合成8時間sparse zero PCMを使い、録音、文字起こし本文、R2 capability、Cloudflare/RunPod credential、
staging/production resourceは使用していない。

## Decision

- Phase 10Bの結果を事前decision tableの`Adopt candidate`と判定する。
- executionは1件、task attemptは1件で成功し、retry、failure、cancel、追加executionは0だった。
- application success markerは1件、既知failure markerとplatform failure分類はすべて0だった。
- execution durationは254秒、Cloud Monitoringのbillable instance timeは180.02秒だった。
- peak container memoryは0.578 GiB、peak tmpfsは0.0079 GiB、peak GPU memoryは2.363 GiB、peak GPU
  utilizationは86%だった。memory 12 GiB以下、tmpfs 3 GiB未満、30分以下の事前gateを満たした。
- memory、tmpfs、GPU memory、GPU utilizationはCloud Monitoringのsingle-sample distributionだった。
  各pointの`count=1`を検証した場合だけ`mean`をそのpointの観測値として使った。複数sample distributionや
  series欠測を推測値で補完しない。
- execution直前のGoogle Cloud Billing Catalog JPY read-backでは、55分compute、24時間分の短期registry
  reserve、税を含む保守上限は164円で、承認上限200円以内だった。実請求額はBilling反映後に確認する。
- evidence取得後、専用Job/execution、repository/image、runtime service accountを削除し、別processで各0件、
  running task 0を確認した。成功を理由に追加executionを作らない。
- この判定はbounded-memory方式と固定Cloud Run candidateの技術的feasibilityだけを採用候補とする。
  Cloud Runをproduct providerとして採用せず、ADR 0069はproduct採用判断まで`Proposed`のまま維持する。

## Consequences

- 合成8時間入力について、処理時間とhost/GPU memoryは16 GiB L4の事前上限内に収まった。最大8時間を
  memory理由だけで直ちに拒否する必要はなくなった。
- sparse silence中心の合成入力は、長発話、boundary重複、日本語、auto language、VAD、選択formatの品質を
  証明しない。非機密speech-like fixtureを用いたlocal比較と実service staging acceptanceが必要である。
- product接続にはcontract v2 migration、capability、heartbeat/cancel、partial artifact cleanup、controller、
  CI workload identity、data location、privacy/retention、staging/production parityの別reviewが必要である。
- Cloud Runの単発成功は継続capacityや起動SLOを保証しない。provider採用ADRではcapacity failure、unknown
  outcome、orphan cleanup、rollbackを含む運用設計を固定する。
- 現行RunPod、Cloudflare、R2、D1、staging、productionは変更しない。次のcloud mutationは新しいreview packetと
  明示承認なしに行わない。

## References

- [ADR 0067](./0067-evaluate-cloud-run-gpu-jobs.md)
- [ADR 0068](./0068-benchmark-cloud-run-eight-hour-input.md)
- [ADR 0069](./0069-use-bounded-memory-transcription-windows.md)
- [Bounded Cloud Run re-probe](../cloud-run-bounded-eight-hour-reprobe.md)
- [Cloud Run metrics](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
