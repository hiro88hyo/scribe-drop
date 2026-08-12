# Cloud Run GPU隔離probe

## 1. Status and scope

- Status: Completed。隔離probe成功、resource cleanup完了、product採用は未決定
- Date: 2026-08-10
- Decision: [ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)
- Product adoption: 未決定

目的は、既存の固定Whisper imageがCloud Run L4で起動し、GPUを1台だけ認識して合成音声を一度
推論し、one-shot processと課金instanceが期限内に終了するかを確認することである。ScribeDropの
staging acceptanceではなく、provider compatibilityだけを判定する隔離probeである。

禁止事項:

- 実録音、過去のtest録音、文字起こし本文、利用者情報を使用しない。
- R2、D1、Cloudflare、RunPod、Discord、GitHubのcredentialまたはresourceへ接続しない。
- staging/production resource、secret、workflow、DNS、Access policyを変更しない。
- Cloud Run Service、public endpoint、trigger、scheduler、VPC connector、persistent volumeを作らない。
- 失敗したcandidateを原因確認なしで再実行しない。

## 2. Fixed probe manifest

| Boundary             | Fixed value                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| Google Cloud project | 利用者が明示したbilling有効project。実IDはrepositoryへ記録しない                      |
| Region               | `asia-southeast1`（Singapore）                                                        |
| Runtime              | Cloud Run Job。Service/Worker Poolは作らない                                          |
| GPU                  | `nvidia-l4` x 1                                                                       |
| Compute              | 4 vCPU、16 GiB memory                                                                 |
| Task                 | tasks 1、parallelism 1、max retries 0、task timeout 10分                              |
| Redundancy           | `--no-gpu-zonal-redundancy`                                                           |
| Image                | localで検査した`linux/amd64` imageをdedicated Artifact Registryへpushし、digestで固定 |
| Command              | `python -m scribe_drop_worker.cloud_run_gpu_probe`                                    |
| Input                | container内で生成する1秒、16 kHz、mono、PCM silence WAV                               |
| Network              | inbound listenerなし。applicationからoutbound通信なし                                 |
| Runtime identity     | dedicated user-managed service account、project role 0                                |
| Secret               | 0。environmentにはCloud Run組み込み値と固定`MODEL_PATH`だけ                           |
| Evidence             | allowlist terminal code、Job/Execution状態、時間、billable time、sanitized policy     |
| Resource ceiling     | repository 1、image 1、service account 1、Job 1、execution 1、GPU task 1              |

Cloud RunはJobへ`CLOUD_RUN_JOB`、`CLOUD_RUN_EXECUTION`、`CLOUD_RUN_TASK_INDEX`、
`CLOUD_RUN_TASK_ATTEMPT`、`CLOUD_RUN_TASK_COUNT`を設定する。probe codeはcount `1`、index `0`、
attempt `0`、固定`MODEL_PATH`以外をGPU初期化前に拒否する。Job codeはHTTP portをlistenせず、成功時
exit 0、失敗時exit 1で終了する。

## 3. Complete IAM and API manifest

operatorへ逐次権限追加を依頼しない。既存Ownerを前提にせず、probeの作成、read-back、停止、削除までに
必要なroleを最初に一覧化する。

| Principal / scope                 | Required role                          | Purpose                                            |
| --------------------------------- | -------------------------------------- | -------------------------------------------------- |
| operator / project                | `roles/serviceusage.serviceUsageAdmin` | 必要APIの有効化                                    |
| operator / project                | `roles/run.developer`                  | Jobとexecutionの作成、実行、取得、cancel/delete    |
| operator / project                | `roles/artifactregistry.admin`         | dedicated repositoryの作成、push、digest取得、削除 |
| operator / project                | `roles/iam.serviceAccountAdmin`        | dedicated runtime service accountの作成と削除      |
| operator / probe service account  | `roles/iam.serviceAccountUser`         | Jobへruntime identityを割り当てる                  |
| operator / project                | `roles/servicemanagement.quotaViewer`  | GPU quotaのread-only確認                           |
| operator / project                | `roles/logging.viewer`                 | allowlist application logとplatform logの確認      |
| runtime service account / project | roleなし                               | synthetic local inference以外を許可しない          |

有効化対象APIは`run.googleapis.com`、`artifactregistry.googleapis.com`、`iam.googleapis.com`である。
Cloud Buildは使わず、local Docker build/pushを行う。Cloud Run service agentのGoogle管理roleは
platformが管理するため、人手で拡張しない。quota変更が必要になった場合は本probeを停止し、
`roles/servicemanagement.quotaAdmin`をその場で追加せず、変更量とscopeを再reviewする。

## 4. Cost authorization

2026-08-10の公式list priceでは、JobsのL4 non-zonal redundancyは`$0.0001867/GPU-second`、
CPUは`$0.000018/vCPU-second`、memoryは`$0.000002/GiB-second`である。4 vCPU、16 GiBを
10分間すべて課金した単純上限は約`$0.17442`である。実際の請求通貨、region tier、tax、Artifact
Registry storageは異なり得るため、cloud mutation直前にConsole/Billingの表示を確認する。

- 許可上限: 合計200円相当。見積が超える場合はJobを作成しない。
- Cloud Run Jobsはinstance lifetime全体、最低1分課金される。
- queue/capacity待ちが課金対象かはbillable instance timeで実測する。
- Cloud Billing budgetは通知でありhard stopではない。resource ceilingと10分timeoutを主制御とする。
- timeout後も実行中と表示される、またはbillable timeが増加する場合はexact executionをdeleteし、
  Jobをdeleteしてから調査する。

## 5. Local gates before authentication or mutation

1. gcloud CLIのversionと配布archive checksumを固定する。
2. probe environment、CUDA device count、native failure redaction、temporary file cleanupのunit testを通す。
3. Python Ruff、mypy strict、pytestを通す。
4. worker imageをlocal buildし、non-root、offline flags、固定model hash、dependency、ffprobeを検査する。
5. imageにprobe moduleが含まれ、CPU環境では`CUDA_DEVICE_INVALID`で安全に終了することを確認する。
6. image layer sizeとArtifact Registry制約を確認し、`linux/amd64`の単一candidate digestを得る。
7. secret scanとworktree reviewを行う。

Cloud Run L4はdriver 535.x（CUDA 12.2）を提供する。現行imageのCUDA 12.8.1はCUDA 12系minor
compatibilityの範囲だが、CTranslate2が利用する機能までローカルCPU環境では証明できない。
forward compatibility packageを推測で追加せず、最初の一回をcompatibility probeとして扱う。

## 6. Cloud sequence

以下はreview用のsequenceであり、project選択、IAM、費用のread-backが完了するまで実行しない。
実行時はすべての変数をshell historyへsecretを含めず設定し、各mutation直後にdescribe/listでexact
read-backする。

1. SSH環境向け`gcloud auth login --no-launch-browser`でoperatorを認証する。
2. project ID、active account、billing enabled、既存同名resource 0、quotaをread-only確認する。
3. 必要APIだけを有効化する。
4. dedicated runtime service accountとArtifact Registry Docker repositoryを作成する。
5. local検査済みimageをpushし、remote digestとlocal candidateを照合する。
6. fixed manifestどおりJobを作成し、YAML/describeからGPU、CPU、memory、task、retry、timeout、
   identity、command、image digest、volume/network/secret不在をread-backする。
7. driftが0の場合だけexecutionを一度作成する。非同期で開始し、statusをpollして10分を超えて待たない。
8. 成否、起動時間、実行時間、terminal marker、platform状態、billable instance timeをsanitized記録する。
9. execution、Job、repository、runtime service accountを削除し、同名resource 0、実行中instance 0を
   read-backする。

Job作成とexecution作成を分ける。Job config validationまたはquota grantが失敗した場合はexecutionを
作らない。execution開始後のclient timeoutは失敗確定とみなさず、同じexecutionをdescribeして別の
executionを作らない。

## 7. Stop, cleanup, and evidence

次のいずれかで新しいmutationを停止し、exact cleanupだけを行う。

- project、account、region、GPU、image digest、runtime identity、resource countがmanifestと違う。
- secret、volume、VPC、listener、複数task、retry、10分超timeoutが設定されている。
- quotaが付与されない、capacity待ちのままdeadlineを超える、未知の課金resourceが作られる。
- CUDA device countが1ではない、model bundle検証または推論が失敗する。
- terminal後も実行中instanceまたはbillable timeが増え続ける。
- cleanup後にJob、execution、repository、image、service accountのいずれかが残る。

repositoryへ残すevidenceは、実施日、sanitized fixed policy、成功/allowlist error code、所要時間、概算費用、
cleanup結果だけとする。project ID、project number、account、service account email、Job/Execution ID、
image repository URL、raw log、access tokenは残さない。Cloud LoggingとMonitoringはprovider retentionに
従って残り得るため、合成データとallowlist marker以外をapplication logへ出さない。

## 8. Adoption gate

probe後は結果を別ADRで次のいずれかに分類する。

- Adopt candidate: GPU compatibility、起動SLO、capacity、lifecycle、費用、cleanupが成立した。
- Revise and re-probe: 原因が一意に特定されたimage compatibilityだけを修正し、別candidateを一度試す。
- Reject: quota/capacity/lifecycle/費用/securityがproduct要件を満たさない。

Adopt candidateでも実録音をすぐ送らない。provider-neutral execution aggregate、Cloud Run identityと
controller、R2 capability交換、data location、最大入力時間、staging promotion、rollbackを別ADRと
Phase計画でreviewしてから実装する。

## 9. Probe result

2026-08-10にfixed manifestを変更せず一度だけ実行した。実ID、account、resource名のprovider生成部分、
image digest、raw logはrepositoryへ保存しない。

| Evidence                         | Sanitized result                                               |
| -------------------------------- | -------------------------------------------------------------- |
| Preflight                        | billing有効、必要API有効、operator capability 19/19、衝突0件   |
| L4 quota                         | `asia-southeast1`、non-zonal redundancy、effective limit 3     |
| Job read-back                    | fixed manifest 14/14一致、execution作成前の実行履歴0件         |
| Execution                        | 1件だけ作成、client開始から90秒以内にterminal success          |
| Application evidence             | success marker 1件、failure marker 0件                         |
| Compatibility                    | CUDA 12.8.1、CTranslate2、固定model、L4で合成推論成功          |
| Cleanup                          | Job/execution、repository/image、runtime service accountを削除 |
| Independent absence read-back    | Job 0、repository 0、runtime service account 0                 |
| Continuing billable GPU resource | 0。実請求額はBilling反映後に確認                               |

分類は技術的Adopt candidateである。これはprovider compatibilityとbounded lifecycleの成立だけを示し、
capacity SLO、最大入力、実録音のsecurity/data location、production adoptionを承認しない。次は実請求の
反映確認と、Phase 11以降へ進むかを決めるproduct adoption ADRのreviewを行う。

## 10. References

- [Configure GPUs for Cloud Run jobs](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu)
- [Container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Set task timeout for jobs](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Manage job executions](https://docs.cloud.google.com/run/docs/managing/job-executions)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [View and manage quotas](https://docs.cloud.google.com/docs/quotas/view-manage)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
