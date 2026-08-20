# Cloud Run 8時間full-scan benchmark

## 1. Scope

- Status: Completed。単一task 8時間pathはReject、全benchmark resource削除済み
- Date: 2026-08-10
- Decision: [ADR 0068](./adr/0068-benchmark-cloud-run-eight-hour-input.md)
- Product adoption: 未決定

このbenchmarkは、最大8時間入力がCloud Run L4のGPU task上限1時間へ十分な余裕を持って収まるかを
判定する。実録音、R2、Cloudflare、RunPod、staging/productionは使用・変更しない。

## 2. Fixed manifest

| Boundary         | Fixed value                                                           |
| ---------------- | --------------------------------------------------------------------- |
| Region           | `asia-southeast1`                                                     |
| Runtime          | Cloud Run Job、公開Serviceなし                                        |
| Compute          | L4 x 1、4 vCPU、16 GiB、no zonal redundancy                           |
| Execution        | task 1、parallelism 1、retry 0、timeout 55分、execution 1件           |
| Image            | local全gate済み`linux/amd64` candidateをimmutable digestで固定        |
| Input            | 8時間、16 kHz、mono、signed 16-bit sparse PCM WAV                     |
| Decode           | beam 5、previous-text有効、language auto、VAD無効、word timestamp無効 |
| Identity         | dedicated user-managed service account、project role 0                |
| Network / secret | application outbound 0、inbound 0、secret 0                           |
| Evidence         | terminal marker、billable instance time、sanitized resource parity    |
| Cost ceiling     | 約`$0.95931`、200円相当をhard authorization ceilingとする             |

2026-08-10の実行直前見積では、日本銀行の2026年8月適用基準161円/USDを使用すると55分上限は
約154.45円、消費税10%を仮に加えて約169.90円である。短時間で削除するArtifact Registry storageを
加えても200円上限を超えない。実際のGoogle換算rateまたは税条件により上限を超える見込みになった場合は
executionを作成しない。

## 3. Gates before cloud mutation

1. environment drift、CUDA device 0/複数、sparse media、fixed decode options、iterator consumption、
   failure redaction、temporary cleanupをunit testする。
2. Ruff、Ruff format、mypy strict、pytest、container build/check、CPU安全拒否、root `pnpm check`、
   Gitleaksを通す。
3. billing、API、L4 quota、operator IAM、同名resource 0、runtime SA role 0、remote digest、fixed Job
   manifest、最大費用を一括read-backする。
4. 上記結果を提示し、利用者のexecution承認を得るまでGPUを起動しない。

## 4. Execution and stop policy

- Job作成とexecution作成を分離し、manifest parityが完全一致した場合だけ一度実行する。
- client timeoutをexecution failureとみなさず、同じexecutionをread-backする。
- 45分を超えた時点で採用条件は不成立とし、別executionを作らない。platform task timeoutは55分とする。
- terminal後にCloud Monitoringの`run.googleapis.com/container/billable_instance_time`を集計する。
- raw log、transcript、segment、resource ID、digest、account、emailをevidenceへ保存しない。
- 最後にJob/execution、repository/image、runtime service accountを削除して残存0件を確認する。

## 5. Result

### Local and read-only preflight

- root `pnpm check`、Ruff、mypy strict、pytest 121件、container offline checkが成功した。
- dependency auditはNode High以上0件、Python既知脆弱性0件である。Node Moderate 1件はHigh gateの
  対象外だが、未解決findingとして隠さない。
- checksum固定Trivy 0.72.0でOS/library High/Critical 0件、Gitleaksで履歴とworktree 0件を確認した。
- project、billing、必要API 5/5、operator role gateを匿名化read-backし、同名Job、repository、runtime
  service accountが各0件であることを確認した。
- `asia-southeast1`のL4 non-zonal effective quotaは3であり、task/parallelism 1を満たす。

### Resource preparation

- 最初のprepare attemptではimage upload完了後、Docker 29.6.2の`push --quiet`成功出力をdigestと誤認する
  local wrapper bugにより失敗判定した。GPU executionは0件で、Job、repository、service accountを
  補償削除し、各0件を独立read-backした。
- Docker CLIの固定version sourceを確認し、quiet成功時はdigestではなく入力tagを出す仕様であることを
  根拠に、digestをArtifact Registryの`image_summary.digest`からread-backするよう修正した。
- 修正後の19項目manifest validatorを合成fixtureで成功させ、executionが1件でもあるfixtureを拒否した
  後にresource preparationを一度実行した。
- 未実行Jobのmanifest 19/19、remote digest一致、runtime service accountのproject role 0、execution
  0件を確認した。別read-only処理でもJob config Ready、latest executionなし、digest参照可能、immutable
  repository、runtime identity、project role 0を確認した。

### GPU execution

- 利用者の明示承認後、固定manifestからexecutionを1件だけ作成した。追加executionとplatform retryは
  なく、task 1件が42秒でfailedになった。
- applicationのsuccess markerおよびallowlist済みfailure markerはいずれも0件だった。platform logの
  sanitized分類はmemory limit 1件で、image pull、startup、application内部failureの証拠はなかった。
- Cloud Monitoringの`billable_instance_time`は60秒だった。client wall timeを課金時間へ代用せず、請求額
  そのものとも扱わない。
- 事前判定表の`OOM`に該当するため、結果は`Reject single-task 8-hour path`である。Cloud Run provider全体の
  Rejectではなく、8時間音声を一つの`faster-whisper.transcribe`へ渡す現行経路を採用不可とする。

### Cleanup and next gate

- terminal evidenceとbilling metric取得後、benchmark専用Job/execution、repository/image、runtime service
  accountを削除した。独立した一覧read-backで対象はそれぞれ0件だった。実resource ID、digest、identityは
  文書へ保存していない。
- 現行workerもsource全体を一度の`transcribe`へ渡しており、8時間上限に対する同じmemory amplificationを
  否定できない。Cloud Run L4のmemoryを16 GiBから32 GiBへ増やすにはCPUを4から8へ変える必要があり、
  fixed manifestと費用も変わる。今回のOOMを根拠なく再実行して上限探索はしない。
- 次のcloud mutationより先に、一定長でdecode/transcriptionするbounded-memory分割、segment timestampの
  再基準化、overlap重複除去、language/conditioning、cancel/heartbeat、partial failureをoffline設計・検証
  する。固定方針は[ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)と
  [bounded-memory transcription design](./bounded-memory-transcription-design.md)へ記録した。成立しなければ
  別ADRでproductの最大入力時間を下げる。
- Phase 10Aでは同じproduction定数を使うisolated bounded coreとbuild済みimage用8時間virtual PCM checkを
  実装した。元の一括pathを再実行せず、次のcloud候補は
  [bounded Cloud Run 8-hour re-probe](./cloud-run-bounded-eight-hour-reprobe.md)の別Job、別entrypoint、exact 1
  executionに限定する。
