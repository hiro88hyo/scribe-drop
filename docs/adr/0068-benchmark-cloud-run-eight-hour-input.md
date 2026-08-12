# ADR 0068: Cloud Run L4で最大8時間入力のfull-scan throughputを一度だけ測る

- Status: Accepted（実施済み。単一task 8時間pathはRejected）
- Date: 2026-08-10
- Target release if accepted: `0.2.0`
- Relates to: ADR 0067
- Does not supersede: 最大録音時間8時間、現行RunPod runtime、staging/production構成

## Context

ADR 0067の隔離probeにより、現行CUDA 12.8.1 image、CTranslate2、固定Whisper modelがCloud Run L4で
起動し、合成1秒入力を処理して終了・削除できることは確認できた。一方、そのprobeはbeam 1、
`condition_on_previous_text=false`、1秒入力であり、本番の最大録音時間8時間がCloud Run GPU taskの
最大1時間以内に収まる根拠にはならない。

利用者の録音やfixture音声をrepositoryまたは外部probeへ持ち込まず、8時間全区間のencoder/decoder
制御経路を実行するbounded benchmarkが必要である。純粋な無音を本番どおりVADへ渡すとほぼ全区間が
除外されるため、capacity判断として意味がない。VADだけを無効化し、本番と同じbeam 5、previous-text
conditioning、language auto detectionで8時間をfull scanする保守的な基礎値を得る。

この合成benchmarkは実会話のtoken生成量を再現しない。結果を実録音の処理時間そのものとは扱わず、
Cloud Run単一GPU taskが最大入力を扱える余裕の有無だけを分類する。

## Decision

- `cloud_run_gpu_benchmark`をADR 0067のcompatibility probeと別entrypointとして実装する。
- 入力はcontainer内で作る8時間、16 kHz、mono、signed 16-bit PCM WAVとする。data sectionはsparse
  fileとして作成し、実data、download、R2 capability、networkを使用しない。
- fixed model、CUDA device 1、task count/index/attempt、Job名、model pathをGPU初期化前にPydanticで
  exact検証する。
- 推論設定はbeam 5、`condition_on_previous_text=true`、language auto detection、
  `word_timestamps=false`とし、全区間走査のため`vad_filter=false`だけを本番から変更する。
- transcript、segment、language、native exception、resource IDを保持・出力せず、allowlist済みterminal
  markerだけをCloud Loggingへ出す。
- Cloud Run JobはL4 x 1、`asia-southeast1`、4 vCPU、16 GiB、task/parallelism 1、retry 0、
  no zonal redundancy、task timeout 55分に固定する。
- executionは一度だけ作成する。失敗、timeout、client timeoutを別executionの作成理由にしない。
- 現行list priceによる55分の単純上限は約`$0.95931`とし、認可上限を200円相当とする。実行前の
  通貨換算と税を含む見積が上限を超える場合は作成しない。
- 成否にかかわらずJob/execution、dedicated repository/image、runtime service accountを削除し、
  対象resource 0をread-backする。APIは課金resourceではないため自動disableしない。

判定はCloud Monitoringのbillable instance timeとterminal markerを用いる。

| Result                                   | Classification                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- |
| successかつbillable time 30分以下        | Throughput candidate。非機密のspeech-like入力検証へ進める余裕がある |
| successかつ30分超45分以下                | Inconclusive。単一Job採用を決めず、上限短縮または入力設計を再review |
| 45分超、55分timeout、OOM、native failure | Reject single-task 8-hour path。分割または別providerを評価          |

いずれの場合も、このbenchmarkだけでproduct adoption、capacity SLO、実録音data planeを承認しない。

## Consequences

- 1 executionで最大入力に対する基礎throughputと最大費用を判定でき、短いprobeの反復を避けられる。
- VADを無効化するため無音除外に依存せず8時間全区間を処理する一方、実会話のdecoder負荷を完全には
  再現しない。成功時も非機密speech-like入力のstaging evidenceが別途必要である。
- sparse WAVは約0.86 GiBの論理sizeを持つがdata pageを全量書き込まない。container memory/diskの
  予期しないallocationが発生した場合は安全に失敗し、resource構成を推測で増量しない。
- benchmark entrypointとtestsはproduct handlerから分離する。Cloud Runを採用しない場合はrelease
  runtimeから除去するか、operator-only image targetへ分離する判断を行う。

## Outcome

2026-08-10、固定manifestからexecutionを正確に1件作成した。taskはretryなしで42秒後にfailedとなり、
applicationのsuccess/failure terminal markerはどちらも出なかった。Cloud Loggingの本文を保存せずに行った
分類ではmemory limitが1件、image pullとstartup failureは0件だった。Cloud Monitoringの
`billable_instance_time`は60秒である。

これはDecisionの判定表にあるOOMへ該当するため、`Reject single-task 8-hour path`とする。Cloud Run GPU
Job自体は短いcompatibility probeに成功済みなのでprovider全体をRejectしない。ただし、現行workerと同じく
最大8時間sourceを一度の`faster-whisper.transcribe`へ渡す実装は、RunPodを含む別providerへ移すだけでは
解決しないmemory safety問題として扱う。

Cloud Run Jobの一般上限は32 GiBで、L4の固定構成を32 GiBにするには8 vCPUが必要になる。16 GiBのOOM後に
32 GiBを推測で試すことは、このADRの一回限りのexecutionとOOM時Reject規則に反するため行わない。次の
mutationは、bounded-memory分割方式をofflineで設計し、timestamp、overlap、conditioning、cancel、partial
failure、artifact一貫性のtestと新しいreview packetを完成させた後だけ許可する。分割方式を採らない場合は、
最大入力時間を実測可能な値へ下げるspec変更を別ADRで行う。

後続方針は[ADR 0069](./0069-use-bounded-memory-transcription-windows.md)でProposedとした。ADR 0069の
offline gateとreviewが完了するまで別のGPU executionを作成しない。

terminal evidence取得後にJob/execution、repository/image、runtime service accountを削除し、独立read-backで
各対象0件を確認した。実resource ID、digest、project/operator identityは保存していない。

## Pre-execution evidence

2026-08-10にlocal gateを完了した。root check、Python 121 test、container offline check、CPU上の
CUDA安全拒否、dependency audit、secret scanが成功し、固定Trivy 0.72.0のOS/library
High/Critical findingは0件であった。Node dependency auditにはModerate 1件が残るがHigh gateは0件、
Pythonは既知脆弱性0件である。

resource作成前の匿名化cloud read-backではproject、billing、必要API 5/5、operator role gateが一致し、
benchmark用の同名Job、repository、runtime service accountは各0件であった。`asia-southeast1`のL4
non-zonal effective quotaは3である。利用者がresource preparationを承認した後、remote image digestと
Job manifest parityをGPU executionから分離して確認した。

2026年8月適用の日本銀行基準161円/USDでは55分上限`$0.95931`は約154.45円、消費税10%を仮に
加えて約169.90円となる。短時間のrepository storageを含めて認可上限200円以内であることをexecution
直前にも再確認する。

resource preparationの最初のattemptでは、Docker 29.6.2の`push --quiet`が成功時に入力tagを返すにも
かかわらずdigestとしてparseし、upload後にlocal failureと誤判定した。GPU executionは作成しておらず、
専用resourceを補償削除して残存0を確認した。digestはCLI stdoutから取得せず、Artifact Registryの
`image_summary.digest`をread-backして正規化する規則へ修正した。

修正後は合成fixtureでmanifest 19/19とexecution混入拒否を検証してからresourceを準備した。未実行Job、
immutable repository、digest pin、runtime service accountのproject role 0、execution 0を同一validatorと
別read-only処理の両方で確認した。実digest、project ID、operator identityは文書へ保存しない。

## References

- [Cloud Run Jobs GPU configuration](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu)
- [Create Cloud Run jobs](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloud Run metrics](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Cloud Run Jobs memory limits](https://docs.cloud.google.com/run/docs/configuring/jobs/memory-limits)
- [日本銀行 基準外国為替相場（2026年8月分）](https://www.boj.or.jp/about/services/tame/tame_rate/kijun/kiju2608.htm)
- [Docker image push](https://docs.docker.com/reference/cli/docker/image/push/)
- [Docker CLI 29.6.2 push implementation](https://github.com/docker/cli/blob/v29.6.2/cli/command/image/push.go)
