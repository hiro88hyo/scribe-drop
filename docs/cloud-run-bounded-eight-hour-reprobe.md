# Bounded Cloud Run 8時間re-probe review packet

## 1. Status and authorization boundary

- Status: Phase 10B exact one execution完了、結果`Adopt candidate`、probe resource 0
- Date: 2026-08-10
- Decision: [ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)
- Previous evidence: [8時間full-scan benchmark](./cloud-run-eight-hour-benchmark.md)
- Product adoption: 未決定。結果の判定は[ADR 0070](./adr/0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)

> 2026-08-11: ADR 0073後のworker imageにはこのpacketとPhase 10B performance evidenceを再利用しない。
> 新digestの再測定は[adaptive EOF revalidation packet](./cloud-run-adaptive-eof-revalidation.md)を正とする。

このpacketはPhase 10Bの候補を一つに固定する。local gateがすべて成功し、その結果を提示した後の別の明示承認
だけがcloud mutationを許可する。この文書の作成、review、local testはexecution承認ではない。現行RunPod、
Cloudflare、R2、D1、staging、production、実録音を変更または使用しない。

## 2. Exact candidate

| Boundary          | Fixed value                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| Region            | `asia-southeast1`                                                             |
| Runtime           | Cloud Run Job。Service、Worker Pool、public endpointなし                      |
| Job name          | `scribe-drop-bounded-gpu-benchmark`                                           |
| Entrypoint        | `python -m scribe_drop_worker.cloud_run_bounded_gpu_benchmark`                |
| Compute           | NVIDIA L4 x 1、4 vCPU、16 GiB、no zonal redundancy                            |
| Task              | task 1、parallelism 1、retry 0、timeout 55分                                  |
| Scratch           | `/tmp`専用in-memory volume、size limit 3 GiB、他のwritable pathなし           |
| Image             | local全gateを通した`linux/amd64`を一度buildし、remote read-back digestへ固定  |
| Model             | image内`large-v3-turbo`固定revision/hash、runtime downloadなし                |
| Input             | 8時間、16 kHz、mono、signed 16-bit sparse zero PCM WAV。実音声なし            |
| Decode            | exact stream、single FFmpeg、16 kHz mono float32、最大32 window               |
| Inference         | core 900秒、前後context 30秒、beam 5、auto language一度固定、VAD false        |
| Artifacts         | dummy exact capability、Markdown/JSON/SRTを逐次生成してdiscard、manifest last |
| Network/secret    | application network call 0、secret 0、R2/Cloudflare/RunPod credential 0       |
| Execution ceiling | execution 1、task attempt 1、unknown response時の再送0                        |

Cloud Runの自動環境変数はjob名、execution名、task count/index/attemptをstrictに検証し、attempt 0以外を拒否する。
source、artifact、manifestのURLは予約済み`.invalid` dummyだけで、HTTP adapterまたは外部networkは使用しない。

## 3. Complete permission set

途中で権限を追加しない。開始前に次を一括read-backし、一つでも不足または過剰なruntime roleがあればresourceを
作らない。

| Principal / scope                  | Required role                          | Purpose                                             |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------- |
| operator / project                 | `roles/serviceusage.serviceUsageAdmin` | 必要APIの有効化                                     |
| operator / project                 | `roles/run.developer`                  | Job/executionの作成、実行、取得、cancel、delete     |
| operator / project                 | `roles/artifactregistry.admin`         | 専用repository/imageの作成、push、read-back、削除   |
| operator / project                 | `roles/iam.serviceAccountAdmin`        | 専用runtime service accountの作成、削除             |
| operator / runtime service account | `roles/iam.serviceAccountUser`         | Jobへのruntime identity割当                         |
| operator / project                 | `roles/servicemanagement.quotaViewer`  | L4 quotaのread-only確認                             |
| operator / project                 | `roles/logging.viewer`                 | allowlist markerとplatform failure分類              |
| operator / project                 | `roles/monitoring.viewer`              | execution、memory、tmpfs、GPU、billable metric取得  |
| runtime service account / project  | roleなし                               | synthetic local inference以外のGoogle API操作を拒否 |

必要API、billing link、region L4 quota、operator role、同名resource 0、runtime project role 0を一つのpreflightで
確認する。quota不足やpermission不足を確認後の逐次grant、region変更、GPU変更で回避しない。

## 4. Local gates before any mutation

次を同一worktreeで成功させる。失敗後にcloudで確認しない。

```bash
pnpm check
pnpm run security:audit
pnpm run secrets:check
pnpm run container:build:runpod
pnpm run container:check:runpod
pnpm run container:check:bounded:runpod
pnpm run container:scan:runpod
```

加えて、candidate entrypointのenvironment drift、CUDA 0/複数、FFmpeg/model/artifact failureのredaction、8時間
actual sample count、buffer peak、32 window、spool/artifact cleanup、Python/TypeScript contract parityをunit test
で確認する。local imageを再buildする変更が入った時点で全結果を無効化する。

### Local gate result (2026-08-10)

- `pnpm check`はformat、ESLint/Ruff、TypeScript/Python strict typecheck、unit/integration、build、Pages Functions、
  D1 migration、CI policyをすべて成功した。Pythonは199件、coverage 91.27%である。
- `pnpm run security:audit`はNode High以上0件、Python既知脆弱性0件だった。Node Moderate 1件は既存の
  non-blocking findingとして残し、High gateに隠していない。
- GitleaksはGit履歴123 commitとworktreeを検査し、leak 0件だった。
- 変更後imageを新規buildし、通常offline checkと8時間bounded core checkを同じimage、networkなし、
  read-only root、64 MiB tmpfsで成功した。
- Trivy 0.72.0の最初の起動はroot filesystem満杯でtemporary directoryを作れず、scan未実行として失敗扱いに
  した。1時間より古い再生成可能なDocker build cacheだけを7.112 GB削除し、image/sourceを変更せず
  `TMPDIR=/dev/shm`で再実行してHigh/Critical 0件を確認した。image、container、volumeは削除していない。
- 通常CIとrelease candidate publishの両workflowへ、同じbuild済みimageの8時間bounded core checkを必須step
  として追加した。workflow policy verifierでもこの構成を検証する。

## 5. Resource preparation and parity

1. billing、API、quota、IAM、同名resource 0、予算上限をread-only確認する。
2. dedicated runtime service accountとdedicated Artifact Registry repositoryを各1件だけ作成する。
3. local検査済みimageを一度pushし、CLI stdoutではなくArtifact Registryからimmutable digestをread-backする。
4. 未実行Jobを作成し、region、GPU、CPU、memory、task、parallelism、retry、timeout、tmpfs mount/size、entrypoint、
   env、digest、runtime identityを固定manifestと全項目照合する。
5. runtime service accountのproject role 0、Job execution 0を別read-only処理でも確認する。
6. parityが完全一致した時点で停止し、sanitized結果を提示してexact 1 executionの別承認を求める。

作成responseが不明でも同名resourceをread-backし、同じcreateまたはexecutionを再送しない。

### Resource preparation result (2026-08-10)

- read-only preflightでproject/identity一致、billing有効、必要API 6/6、operator permission、non-zonal L4
  effective quota 3、対象resource各0件を確認した。execution authorizationはfalseのまま開始した。
- 最初のprepare attemptは、Job名をservice account IDにも流用したため、IAMの6～30文字制約により
  service account作成前境界で停止した。image push、Job作成、executionには到達していない。補償処理後の独立
  read-backでJob、repository、service accountが各0件であることを確認した。
- service account IDをJob/repository名から分離し、長さとRFC 1035形式をcloud mutation前に検査するよう
  preparation処理を修正した。service account作成後のeventual consistencyも、createを再送せずbounded readで
  待つ。
- corrected preparationではrepository、runtime service account、immutable image、未実行Jobを各1件だけ作成した。
  remote registryからdigestをread-backし、固定manifest 24/24、runtime project role 0、execution 0、latest
  executionなしを確認した。
- preparation完了後の別read-only processでも、Job、repository、runtime service account各1、digest一致、scratch
  volume/mount各1、runtime project role 0、execution 0を確認した。GPU executionは開始していない。

## 6. Cost ceiling

前回と同じL4、4 vCPU、16 GiB、55分上限を使い、hard authorization ceilingはArtifact Registryの短期保存を
含め200円相当とする。execution直前に公式単価、Googleの換算rate、税条件、最大55分の再見積をread-backし、
200円を超える見込みなら実行しない。成功が30分以内でも、費用判定にはclient wall timeではなく
`run.googleapis.com/container/billable_instance_time`とBilling read-backを使う。最低課金やmetric可視化遅延を
0円と解釈しない。

## 7. Evidence and decision table

本文、segment、raw log、resource ID、digest、project/account、service account emailは保存しない。次の件数、
時間、peak値、safe marker、sanitized platform errorだけを保持する。

| Evidence                        | Metric / source                                          |
| ------------------------------- | -------------------------------------------------------- |
| execution success/failure count | `run.googleapis.com/job/completed_execution_count`       |
| task attempt count/result       | `run.googleapis.com/job/completed_task_attempt_count`    |
| billable seconds                | `run.googleapis.com/container/billable_instance_time`    |
| peak container memory           | `run.googleapis.com/container/memory/usage`              |
| peak tmpfs                      | `run.googleapis.com/container/memory/tmpfs_usage`        |
| peak GPU memory                 | `run.googleapis.com/container/gpu/memory_usages`         |
| GPU utilization                 | `run.googleapis.com/container/gpu/utilizations`          |
| application terminal            | allowlist `cloud-run-bounded-gpu-benchmark:ok` exactly 1 |

公式Cloud Run metricsは60秒sampling後に最大120秒見えない場合があるため、terminal直後の0件を欠測なしと
扱わず、最大3分のbounded read-backを行う。metric descriptorまたは対象seriesが得られない場合は成功へ補完せず
`Inconclusive`とする。

| Result          | Conditions                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Adopt candidate | success 1、attempt 1、marker 1、30分以下、memory 12 GiB以下、tmpfs 3 GiB未満、OOM/native failure 0 |
| Inconclusive    | 30～45分、memory 12 GiB超、必要metric欠測、cleanup evidence不完全                                  |
| Reject          | 45分超、timeout、OOM、native/contract/artifact failure、execution/attempt複数                      |

成功してもCloud Runをproductへ自動採用しない。非機密speech-like fixtureのboundary品質、日本語、auto language、
VAD、選択formatをstaging acceptanceへ追加し、provider採用ADRを別にAcceptedにする必要がある。

### Phase 10B result (2026-08-10)

- execution直前にもmanifest 24/24、remote digest、runtime project role 0、execution 0を再確認した。
- Google Cloud Billing CatalogのJPY単価と月次換算rateをread-backし、55分compute最大142円、24時間分の
  repository reserve 7円、税を含む保守上限164円が200円authorization ceiling以内であることを確認した。
- exact-once launcherは実行意図をlocal stateへ先に固定し、正常応答、response不明からのlist回収、二重起動拒否を
  fake CLIで検証した。cloudではexecute response成功、execution 1、task attempt 1、retry 0だった。
- executionは254秒で成功した。application success marker 1、failure marker 0、container exit、image pull、OOM、
  startup、task failure分類はすべて0だった。
- Cloud Monitoringはcompleted execution 1、completed task attempt 1、billable instance 180.02秒、peak container
  memory 0.578 GiB、peak tmpfs 0.0079 GiB、peak GPU memory 2.363 GiB、peak GPU utilization 86%だった。
- 4つのusage metricは各pointが`count=1`のdistributionだった。単一sampleを確認してからmeanをpoint値として
  解析し、複数sampleまたは欠測なら成功へ補完しない条件を維持した。
- 事前decision tableのsuccess 1、attempt 1、marker 1、30分以下、memory 12 GiB以下、tmpfs 3 GiB未満、
  OOM/native failure 0を満たすため、結果を`Adopt candidate`とする。
- evidence取得後、Job/execution、repository/image、runtime service accountを削除した。別read-only processで
  各対象0件、running task 0を確認し、local execution identityも削除した。
- 実請求額はBilling反映後に確認する。この結果だけでproduct採用、実録音、staging/production変更、追加executionを
  許可しない。

## 8. Stop and cleanup

- executionは一度だけ作成する。failure、timeout、client disconnect、metric欠測で追加executionを作らない。
- 45分で採用条件不成立としてcancelし、55分のplatform timeoutを最終hard stopとする。
- terminalまたはstop後、Job/execution、repository/image、runtime service accountを削除する。
- 同名Job 0、execution 0、repository 0、image 0、runtime service account 0、running execution/task 0を独立
  read-backする。
- cleanup response不明時は同じ対象のread-backと冪等deleteだけを行い、別resourceを作らない。
- resource残存または課金継続が疑われる場合はPhase 10Bを完了せず、削除とbilling確認を最優先する。

## 9. References

- [Bounded-memory transcription design](./bounded-memory-transcription-design.md)
- [Cloud Run GPU probe](./cloud-run-gpu-probe.md)
- [Cloud Run metrics](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Cloud Run Jobs GPU configuration](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu)
- [Cloud Run Jobs in-memory volume](https://docs.cloud.google.com/run/docs/configuring/jobs/in-memory-volume-mounts)
- [Create service accounts](https://docs.cloud.google.com/iam/docs/service-accounts-create)
- [ADR 0070](./adr/0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
