# Adaptive EOF Cloud Run 8時間revalidation review packet

## 1. Status and authorization boundary

- Status: exact one execution完了、結果`Adopt candidate`、全専用resource 0
- Date: 2026-08-11
- Decision: [ADR 0075](./adr/0075-revalidate-adaptive-eof-worker-before-provider-selection.md)
- Historical evidence only: [Phase 10B bounded re-probe](./cloud-run-bounded-eight-hour-reprobe.md)
- Product provider: production未採用。ADR 0076でsynthetic-only実装を選定し、Phase 12開始条件を完了

このpacketはADR 0073後の新worker imageだけを対象とする。文書作成、local Docker実行、read-only監査はcloud
mutationを許可しない。resource preparationとexact one GPU executionには、それぞれ実行直前の状態・費用を提示した
別の明示承認が必要である。現行RunPod、Cloudflare、R2、D1、CI、staging、production、実録音は変更または使用しない。

## 2. Why a new execution is required

Phase 10Bで実測したimageの後に、EOF final windowのlookbehindとprompt処理を変更した。maximum window、rolling
buffer、model数、FFmpeg process数は増えていないが、最終windowのnative inference量は変化し得る。旧imageの時間、
memory、tmpfs、GPU metricを新digestへ継承しない。local RTX 5070 Tiの成功時間もCloud Run L4の性能値へ換算しない。

## 3. Exact local candidate

| Boundary          | Fixed value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Source state      | Phase 10CとPhase 11 local gateを通過した現在のworktree                                     |
| Worker image      | `scribe-drop-runpod-worker:local`                                                          |
| Local image ID    | `sha256:a7a4c13de2055555945a2823ff5a4494c63e707a61990b75eb1f7e662d080d48`                  |
| Platform          | `linux/amd64`                                                                              |
| Entrypoint        | `python -m scribe_drop_worker.cloud_run_bounded_gpu_benchmark`                             |
| Model             | image内`/opt/models/large-v3-turbo`固定revision/hash、runtime downloadなし                 |
| Algorithm         | 15分core、通常前後30秒context、最大960秒adaptive final lookbehind、single model            |
| Input             | 8時間、16 kHz、mono、signed 16-bit sparse zero PCM WAV。実音声・外部corpusなし             |
| Contract          | v2、auto language、VAD false、Markdown/JSON/SRT exact 3形式                                |
| Artifact path     | local discard port、manifest-last、R2/署名URL/credentialなし                               |
| Local isolation   | GPU 0だけ、network none、read-only root、`/tmp` 3 GiB tmpfs                                |
| Quality companion | quality image ID `sha256:910c88e8677539db49f5d984e9de0d3fe71e11448ffc2e37f4d14ea649f04829` |

remote registry digestはまだ存在しない。preparationを承認された場合もlocal imageを再buildせず、一度だけpushし、
Artifact Registry APIのread-backで得たimmutable manifest digestをJobへ固定する。CLI stdoutのtag表示をdigestとして
扱わない。local image IDとremote manifest digestの種類が異なることを明示し、文字列一致を捏造しない。

## 4. Local gate evidence

2026-08-11に次を完了した。

- DockerからGPU 0（RTX 5070 Ti）を確認した。
- release workerから派生したquality imageをGPU 0、networkなし、read-only、CUDA/float16で実行し、reference
  276文字/18 segment、candidate 279文字/18 segment、global 47,101 ppm、boundary 94,118 ppmで成功した。
- exact worker imageをGPU 0、networkなし、read-only、3 GiB tmpfsで8時間bounded benchmark entrypointへ通した。
  約108秒、exit 0、`cloud-run-bounded-gpu-benchmark:ok` 1件、failure marker 0で完了した。container削除は
  `--rm`で完了し、source、artifact、transcriptをhostへ保存していない。
- `pnpm check`、Python 237件、D1 fresh/idempotent/upgrade、dependency audit、Git履歴126 commitとworktreeの
  secret scan、worker/quality imageのTrivy High/Critical scanが成功した。Node Moderate 1件は既存findingで、
  Node High以上とPython既知脆弱性は0だった。

このlocal結果はcloud executionの承認または成功判定ではない。L4上のbillable time、container memory、tmpfs、GPU
memory/utilization、task attempt、cleanupは未測定である。

## 5. Current official constraint review

2026-08-11にGoogle Cloud公式文書を再確認した。mutation前にはAPI read-backを優先し、文書値だけでresourceを作らない。

- L4は`asia-southeast1`で利用でき、1 instanceあたりGPU 1、最低4 vCPU/16 GiB、driver 535系/CUDA 12.2である。
- GPU Jobはno zonal redundancy構成を使い、GPUはinstance lifecycle全体で課金される。on-demand capacityは予約ではない。
- GPU Jobのbest practiceはtask timeoutを1時間以下とする。候補の55分はこの境界内に維持する。
- in-memory volumeはsize limitを指定でき、使用量はcontainer memoryへ算入される。3 GiBは16 GiB未満に固定する。
- runtimeには専用user-managed service accountを割り当て、Google APIを呼ばないためproject roleを付けない。
  `GOOGLE_APPLICATION_CREDENTIALS`、secret、Cloud Storage mountを設定しない。
- pricing pageはJobをinstance lifecycle全体、最低1分で課金するとしている。固定USD表示を承認額へ流用せず、実行直前に
  Billing CatalogのJPY単価、換算、税、repository reserveをread-backする。

## 6. Fixed Cloud Run candidate

| Boundary          | Fixed value                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| Project/region    | 前回承認済みoperator project、`asia-southeast1`。tracked文書へIDを残さない |
| Runtime           | Cloud Run Job。Service、Worker Pool、public endpointなし                   |
| Job name          | `scribe-drop-bounded-gpu-benchmark`                                        |
| Repository name   | `scribe-drop-bounded-gpu-benchmark`                                        |
| Runtime SA ID     | `scribe-drop-gpu-bench`（Job/repository名と分離、6～30文字）               |
| Compute           | NVIDIA L4 x 1、4 vCPU、16 GiB、no zonal redundancy                         |
| Task              | task 1、parallelism 1、retry 0、timeout 55分                               |
| Scratch           | `/tmp`専用in-memory volume、size limit 3 GiB、他のwritable pathなし        |
| Image             | 3項のlocal imageを再buildせずpushし、remote digestで固定                   |
| Network/data      | application network call 0、secret 0、実録音/R2/Cloudflare/RunPod data 0   |
| Execution ceiling | execution 1、task attempt 1、unknown outcomeで再送0                        |

GPU、region、CPU、memory、timeout、scratch、entrypoint、model、contractを変更した場合はこのpacketを無効にし、新しい
local gateとreviewを要求する。

## 7. Preparation gate（完了、execution 0で停止）

resource作成前に一つのread-only preflightで次を確認し、sanitized countと一致/不一致だけを提示する。

1. operator identityと固定projectの一致、billing link有効。
2. Cloud Run、Artifact Registry、IAM、Service Usage、Logging、Monitoringに必要なAPIがすべて有効。
3. operator capabilityが旧packetの完全permission setと一致し、途中でgrantを追加する必要がない。
4. `asia-southeast1`のL4 no-zonal effective quotaが1以上。
5. 同名Job、execution、dedicated repository、runtime service accountがすべて0。
6. 55分compute、24時間repository reserve、換算・税を含むworst-caseが220円相当以下。
7. gcloud、Docker、fixed model、local image IDがreview値と一致。

別の明示承認後だけ、dedicated repositoryと無権限runtime service accountを各1、未実行Jobを1件作成する。imageは一度
だけpushし、remote digest、Job manifest全項目、runtime project role 0、execution 0を作成処理と別read-only処理の
両方で確認する。準備完了時点で停止し、GPU executionの別承認を求める。

### Preparation preflight result (2026-08-11)

- resource preparationの明示承認後、mutationより先に固定gcloud 579.0.0で一括read-backした。operator/project一致、
  billing有効、必要API 6/6、必要capability 23/23、`asia-southeast1`のL4 no-zonal effective quota 3、同名Job、
  execution、repository、runtime service account各0、local image IDと`linux/amd64`一致を確認した。
- gcloud archiveの初回downloadはrepo固定SHA-256と一致せず、展開前に停止した。Google公式のrapid endpointとversion
  archive endpointから独立取得したbyte列が同じSHA-256で、archive内VERSIONが579.0.0であることを確認し、誤った
  固定値だけを修正してから導入した。
- Billing Catalogの通常Jobs SKUはGPU `0.036685429 JPY/s`、CPU `0.003536892 JPY/vCPU-s`、memory
  `0.000392988 JPY/GiB-s`だった。4 vCPU、16 GiB、3,300秒のcompute上限は188.499円、従来と同じ10%税条件では
  207.349円となる。24時間repository reserveを加える前に200円authorization ceilingを超える。
- `Delayed Jobs` SKU、free tier、discountはfixed candidateで利用を保証していないため見積へ適用しない。cost gate失敗後は
  repository、service account、image push、Job、executionのmutationを一件も行っていない。全対象は0のままである。

### Cost ceiling revision (2026-08-11)

- 利用者の別の明示承認に基づき、hard authorization ceilingだけを200円から220円へ変更する。GPU、region、CPU、memory、
  timeout、task、retry、scratch、image、pricing modelは変更しない。
- Artifact Registryの有料tier `16.3745 JPY/GiB-month`を使用し、free tierとremote圧縮を考慮せず、local image
  6.659 GiBを保守的な30日月で24時間保持するreserveを3.635円とした。computeとの小計192.133円、10%税後
  211.347円で、220円上限まで8.653円の余裕がある。
- 220円を超える見積、追加execution、24時間を超える意図的なrepository保持は承認しない。executionは依然として別承認を
  必須とする。

### Resource preparation result (2026-08-11)

- 最初のpreparation attemptはrepositoryとruntime service accountを各1件作成し、exact local imageを一度pushした後、
  remote digest validatorがREST `tags[]`を完全registry URLと仮定したため、documented digestを取得できずJob作成前に
  停止した。repository/imageとservice accountを補償削除し、別processでJob、execution、repository、service account
  各0を確認した。
- Artifact Registry RESTは`tags[]`の表現を保証していないため、tagを入力に公式gcloudのArtifact Registry describeを呼び、
  documented `image_summary.digest`と`fully_qualified_digest`を同時照合する方式へ修正した。valid/wrong referenceの
  合成fixtureを通し、resource 0からcorrected preparationを開始した。sandbox内Docker socket拒否によるlocal stopは
  cloud mutation前に発生し、candidateやresourceを変更していない。
- corrected preparationではrepository、exact remote image、無権限runtime service account、未実行Jobを各1件作成した。
  local imageは再buildせず、successful repositoryへ一度だけpushし、tag stdoutではなくArtifact Registry describeから
  immutable manifest digestをread-backしてJobへ固定した。
- 作成処理内でmanifest 27/27、runtime project role 0、execution 0を確認した。別processの独立verifierもrepository、
  image、service account、Job各1、local image対応、manifest 27/27、runtime project role 0、user-managed key 0、
  execution 0を確認した。GPU execution authorizationはfalseである。
- current repositoryの24時間cleanup deadlineは`2026-08-12T04:55:00Z`、55分executionと最大3分metric read-backを
  開始できる保守的なcutoffは`2026-08-12T03:55:00Z`とする。cutoff後はfresh cost read-backと別承認なしに実行せず、
  cleanup deadlineまでにJob、repository/image、runtime service accountを削除する。

## 8. Execution and decision gate（完了、`Adopt candidate`）

execution直前にmanifest、digest、role 0、execution 0、最新費用を再確認する。別の明示承認後、exact one executionを
作成する。response不明時は同じ時間窓をlist/read-backし、execute requestを再送しない。

| Result          | Conditions                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Adopt candidate | success 1、attempt 1、marker 1、30分以下、memory 12 GiB以下、tmpfs 3 GiB未満、OOM/native failure 0 |
| Inconclusive    | 30～45分、memory 12 GiB超、必要metric欠測、cleanup evidence不完全                                  |
| Reject          | 45分超、timeout、OOM、native/contract/artifact failure、execution/attempt複数                      |

terminal後は最大3分のbounded metric read-backでbillable time、container memory、tmpfs、GPU memory/utilizationを取得する。
欠測を0へ補完しない。結果にかかわらず追加executionを作らない。

### Execution result (2026-08-11)

- 利用者の別の明示承認後、execution直前にmanifest 27/27、immutable digest、runtime role 0、user-managed key 0、
  execution 0、billing、API 6/6、capability 23/23、L4 no-zonal quota 3、最新Catalogの税・24時間reserve込み
  211.347円が220円上限内であることを再確認した。
- local intentをexclusive作成してからexecute requestを一度だけ送信し、同じ時間窓のlistでexecution 1件を回収した。
  最初のmonitorはCloud Runの`Completed=CONDITION_PENDING`をterminal failureと誤分類して終了したが、execute requestを
  再送せず、durable intentに記録した同一executionだけをcorrected condition classifierで監視再開した。
- executionは271.965秒でsuccess、succeeded 1、failed 0、cancelled 0、retried 0だった。application logはsuccess marker
  1、failure marker 0、unexpected application line 0、platform error 0である。
- 最初のexact-label log pollは3分境界でmarker 0、必須metric 7/7だった。直後のtime-bounded diagnosticでは全log 3件が
  同一execution labelへ一致し、stdout marker 1を確認した。必要metricの欠測はなく、raw logまたは本文を取得・保存して
  いない。
- Cloud Monitoringはbillable instance time 242.318秒、peak container memory 0.818119 GiB、peak tmpfs
  0.007904 GiB、peak GPU memory 2.363281 GiB、peak GPU utilization 100%、completed execution 1、completed task
  attempt 1だった。GPU utilizationのprovider値`1`は公式unit `10^2.%`に従い100%として表示する。
- success/attempt/marker各1、30分以下、container memory 12 GiB以下、tmpfs 3 GiB未満、OOM/native failure 0、
  必須metric欠測0を満たすため、事前decision tableどおり`Adopt candidate`とする。追加executionは作成していない。

## 9. Cleanup and terminal conditions

- 新規execution停止、必要ならexact execution cancel、Job delete、repository/image delete、runtime service account deleteの
  順でcleanupする。
- 同名Job/execution/repository/image/service account 0、running task 0を別read-only processで確認する。
- delete response不明時は同じ対象だけをread/reconcileし、別resourceを作成しない。
- resource残存、課金継続、候補不一致、metric欠測ではPhase 10Dを完了しない。
- resource 0と課金停止の確認後も、このpacket単独ではPhase 12を開始しない。2026-08-11に別の
  [ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)がAcceptedとなり、
  synthetic-only local実装の開始条件だけを満たした。

### Cleanup result (2026-08-11)

- terminal successとrunning task 0をread-back後、Job/execution、repository/image、runtime service accountの順に削除した。
- 別processで同名Job/execution/repository/runtime service account各0を確認した。継続課金対象GPU resourceは0である。
- local Dockerのremote tag、execution IDを含む`/tmp` intent、temporary evidenceを削除し、元のlocal worker image IDは
  保持した。actual請求額はBilling反映後に確認する。

## 10. References

- [Cloud Run Jobs GPU configuration](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu)
- [Cloud Run GPU Job best practices](https://docs.cloud.google.com/run/docs/configuring/jobs/gpu-best-practices)
- [Cloud Run Jobs in-memory volume](https://docs.cloud.google.com/run/docs/configuring/jobs/in-memory-volume-mounts)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [ADR 0070](./adr/0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)
- [ADR 0073](./adr/0073-use-adaptive-final-window-lookbehind.md)
- [ADR 0075](./adr/0075-revalidate-adaptive-eof-worker-before-provider-selection.md)
