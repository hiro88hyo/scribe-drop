# RunPod

## 現在の checkpoint

Phase 4ではCloudflare側のsubmission、claim、heartbeat、RunPod Workerのlocal runtime、
固定model入りimageを実装した。staging専用endpointとtemplateを固定image digestから
作成し、初回workerがReadyになるまで起動してRTX 4090のGPU配置とSecure Cloudを確認した。
最小jobは期限切れclaimを安全に拒否して終了しており、endpoint invariantのcheckpointは
完了した。Phase 5では修正版の固定digestへ新template revisionで切り替え、実browser
uploadからproduction media probe、GPU推論、manifest-last、Markdown・JSON・SRT、
terminal保存、finalize、Discord通知までstaging smokeを完了した。active workerは0、
max workerは1へ復元した。実ID、image参照、originは追跡対象へ保存しない。

上記のRTX 4090単一構成は過去checkpointである。release acceptanceで同GPUの供給待ちが
再現し、productionでも同じ単一構成だったため、現在のrelease policyは
[ADR 0053](./adr/0053-use-mixed-availability-gpus-with-runtime-attestation.md)に従い、
`NVIDIA GeForce RTX 5090`、`NVIDIA GeForce RTX 4090`、
`NVIDIA RTX PRO 6000 Blackwell Server Edition`の優先順位付きGPU候補へ更新した。
全GPU種別はCommunity Cloudにも提供されるため、個々の実Workerが
`secureCloud=true`であることをclaim前に検証する。stagingの実GPU E2Eとexact endpoint
read-backを通すまではproduction-readyとしない。

2026-07-31に[ADR 0054](./adr/0054-use-explicit-datacenters-for-staging-recovery.md)の
staging限定recovery endpointで、実audio/mp4 upload、claim前配置attestation、GPU推論、
manifest、3形式のartifact、D1 finalize、利用者によるdownloadと文字起こし確認まで
成功した。処理後はactive D1/provider job 0、`workersMin=0`へ収束した。このendpointは
明示した2 data centerをConsoleで手動read-backした暫定例外であり、source of truthと
GitHub staging Environmentが同期するまではproduction promotion evidenceに使用しない。
Consoleの`Security & compliance`はdata centerのcertification filterであり、
Secure Cloud切替ではない。現行要件に特定certificationはないため`Any`を維持し、
実Workerの`secureCloud=true` attestationを省略しない。

2026-08-01のADR 0065 staging prewarmでは、表示上の在庫と3つの実Serverless GPU poolが
存在してもWorkerが作成されなかった。2026-08-06のbounded probeでも、`workersMin=1`または
固定dummy requestの投入後10分以内にWorkerは作成されなかった。RunPod supportは2026-08-10までに、
Schedulerが全compatible GPU、全available region、全fallbackを評価したがcapacityがなく、
公開APIにはGPU capacity待ちとその他の`IN_QUEUE`を区別するstatusがないと確認した。
inventoryとpool membershipを配置保証として同じworkflowを再実行しない。現行runtimeを変更しないProposedな
[一時GPU Pod実行設計](./ephemeral-gpu-vm-design.md)を[ADR 0066](./adr/0066-design-ephemeral-gpu-vm-execution.md)
で定義した。providerの採用、cloud resource作成、production変更はまだ承認していない。
採用する場合は`0.2.0`として実装する。[Phase 8 provider decision packet](./ephemeral-gpu-vm-provider-decision.md)
では、`0.1.1`のstaging acceptanceとproduction promotionをBlockedのまま未releaseで閉じ、
RunPod固有のfail-closed検証だけを別PRで`develop`へ戻す。現candidate artifactは再利用しない。
RunPod Podsはpublic IP、create冪等性、署名付きidentity、provider側hard lifetimeのmandatory gapを
解消できず、[ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)でactive probeを停止した。Cloud Run GPU
Jobの隔離probeはL4で固定model推論まで成功したが、[ADR 0068](./adr/0068-benchmark-cloud-run-eight-hour-input.md)
の8時間一括処理は16 GiBのmemory limitで失敗した。現在は
[ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)のbounded-memory offline検証が次の境界で
あり、exact 1 re-probeとprovider採用ADRが完了するまでRunPod Pods、Cloud Runともproductへ採用せず、
実録音を新providerへ送らない。

## Image supply chain

imageは`linux/amd64`専用のmulti-stage buildとする。選択値は
`tools/versions.json`と`apps/runpod-worker/Dockerfile`を同期させる。

| Component         | Fixed value                                                        |
| ----------------- | ------------------------------------------------------------------ |
| Dockerfile syntax | `docker/dockerfile:1.7`のamd64 digest                              |
| build uv image    | `ghcr.io/astral-sh/uv:0.11.32`のamd64 digest                       |
| runtime base      | `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04`のamd64 digest       |
| Ubuntu snapshot   | `20260725T000000Z`                                                 |
| CA certificates   | `20260601~24.04.1`                                                 |
| GnuPG packages    | `2.4.4-2ubuntu17.4`                                                |
| OpenSSL packages  | `3.0.13-0ubuntu3.11`                                               |
| Python package    | `3.12.3-1ubuntu0.15`                                               |
| FFmpeg package    | `7:6.1.1-3ubuntu5`                                                 |
| model repository  | `dropbox-dash/faster-whisper-large-v3-turbo`                       |
| model revision    | `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`                         |
| model.bin SHA-256 | `e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da` |

NVIDIAのapt sourceはbuild前に削除し、Ubuntuのarchiveとsecurity sourceは固定snapshotの
同一originへ置換する。modelはbuild時だけ公開repositoryからexact revisionと5 fileだけを
取得し、全fileのbyte sizeとSHA-256を検証する。Hugging Faceのcache metadataはimageへ
残さず、検証済みprovenanceを`model-metadata.json`へ保存する。

runtime imageにuvは含めず、UID/GID 10001、固定`MODEL_PATH`、Hugging Face関連のoffline
flagで実行する。model directoryはroot所有かつwrite不可とする。runtimeのtranscriberも
`local_files_only=True`を指定する。

## Local verification

root build contextから実行する。

```bash
pnpm container:build:runpod
pnpm container:check:runpod
```

offline checkは`--network none`、read-only root filesystem、一時`/tmp`だけwrite可能な
条件で起動する。次を検証し、RunPodのjob loopやGPU推論は開始しない。

- effective UIDがrootではない
- offline flagとmodel pathが固定値である
- model全fileとprovenanceのsize/hashが一致する
- RunPod SDK、faster-whisper、CTranslate2、Pydantic、httpx、Hugging Face Hubが固定versionである
- native moduleをimportできる
- ffprobe 6.1.1を起動できる

Phase 6ではR2 GET/PUT timeoutを固定httpx transportで注入し、URL queryを露出せず
`SOURCE_DOWNLOAD_FAILED`または`ARTIFACT_UPLOAD_FAILED`へ正規化する。artifact PUTの効果後に
responseを失った場合もmanifestを作らず、partial artifactだけで完了しないことを検証する。
Orchestrator側はmanifest欠落を保持grace中deferし、期限後にfail closedとする。

CIでは最終imageにSyftのSPDX JSON SBOMとTrivyのOS/library scanを実行する。専用の
一時runnerは不要なpreinstalled toolchainを削除し、25 GiB以上の空きを確認してから
buildとscanを開始する。High/Critical findingはfixed/unfixedを問わずjobを失敗させる。
例外は暗黙にignoreせず、脅威、補償制御、期限、除去条件をADRへ記録する。

## Endpoint invariant

stagingとproductionは別endpoint、別template、別credentialを使用する。release candidateを
昇格する場合、両templateは[ADR 0023](./adr/0023-promote-only-staging-verified-artifacts.md)
に従って同じ検証済みimage digestを参照する。設定は次から緩めず、満たせない場合はdeployを
停止する。

- Secure Cloud
- Flex
- active workers 0
- max workers 1
- GPU 1
- 優先順位付きGPU候補は`NVIDIA GeForce RTX 5090`、`NVIDIA GeForce RTX 4090`、
  `NVIDIA RTX PRO 6000 Blackwell Server Edition`の順で固定する
- 全候補がinventoryでSecure Cloud提供され、2候補以上がavailable。Community Cloudでの
  提供とstock tierはrelease invariantにしない
- 全候補が認証済みGraphQLの`serverlessGpuPools`へ一意に存在し、候補間でpool IDが重複しない
- 各claimで実Workerの`secureCloud=true`をR2 capability発行前に検証する
- data centerは`Any Region`とし、GraphQLの`locations: null`または空文字を明示的な
  空配列へ正規化してexact read-backする。field欠落は一致とみなさない
- compliance filterは`Any`とする。特定certification要件は別ADRなしに追加せず、
  Secure Cloudの代替条件として扱わない
- Network Volumeなし
- 永続diskなし
- FlashBoot無効

templateへRunPod API key、R2長期credential、Discord webhookを渡さない。Workerの
環境変数は`docs/environment-variables.md`の非secret設定だけとし、per-job capabilityは
一回限りclaimの成功responseから取得する。

## Deployment and rollback

RunPod imageは`release/<version>`の単一commitから一度だけbuildする。offline check、
SBOM、scanを通したimageをGHCRへpushし、candidate manifestへdigest付き参照を保存する。
staging acceptanceはこのdigestを使用し、productionは成功したevidenceが参照する同じ
digestだけを昇格する。production用の再buildと任意image入力を禁止する。

`Publish RunPod release candidate` workflowはenvironment選択を持たず、
`release/<version>`からcandidate imageを一度だけ発行する。このworkflowはproduction
credentialとdeploy jobを持たない。[ADR 0034](./adr/0034-fail-before-release-candidate-cost.md)
に従い、最初のjobだけはstaging EnvironmentのRunPod API keyとendpoint IDを使って
read-only readinessを行う。build、test、publish jobにはstaging credentialを渡さない。
staging/production promotion workflowはcandidateと短期staging evidenceを照合し、
production用にimageを再buildしない。package visibilityは暗黙に変更しない。

private imageを使う場合、RunPodにはread-only registry credentialが必要になる。
`runpodctl registry create`はpasswordをcommand line argumentとして受け取るため使用せず、
RunPod consoleのsecret入力で登録してから`runpodctl registry list`で非secret IDと名前
だけを確認する。publicへ変更する場合はregistry credentialが不要になるが、GitHub上で
privateへ戻せない操作なので明示的に選択する。

image visibility、candidateの共通digest、environment別registry auth ID、固定GPU候補と
同じenvironmentのCloudflare値をcredential storeまたはCI evidenceから読み込み、
追跡外planを生成する。

```bash
pnpm run runpod:config:staging
```

productionではstaging evidenceが参照する同じimage digestと、production専用のほかの項目を
読み込み、次を使用する。

```bash
pnpm run runpod:config:production
```

`.runpod/deploy/<environment>-plan.json`はdirectoryを0700、fileを0600で生成する。
実account ID、実origin、registry image、resource IDを含むため、リポジトリへ追加しない。
production planはstaging markerを持つoriginとregistry auth IDを拒否する。
promotion workflowでは、さらにstaging evidenceのcandidate digestと一致しないimageを
拒否する。production promotion script自身もcandidateとevidenceを再検証してから
`runpodctl`を呼ぶ。

promotion中のRunPod API一時障害は
[ADR 0031](./adr/0031-retry-only-runpod-read-commands.md)と
[ADR 0034](./adr/0034-fail-before-release-candidate-cost.md)に従って扱う。template listは
公式REST API、`template get`と`serverless get`は固定CLIで最大3回、指数backoff付きで
再試行する。template作成とendpoint更新は結果不明時に再送せず、厳格なread-backと
rollbackを維持する。retry logへAPI応答と実IDを出さない。
candidate workflowではRESTのtemplate listとendpoint getを高コスト処理前に並列実行し、
その前に固定`runpodctl`のGPU inventoryでADR 0053のSecure Cloud提供属性を検証する。
candidate publicationは瞬間的な在庫を合否にせず、staging/production promotionでは
全候補のSecure Cloud提供と2候補以上のavailableを必須とする。OpenAPI enumに加え、
[ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)の認証済み
`serverlessGpuPools`で全候補の一意かつ相異なるpool対応を確認する。staging promotionでは
candidate固有planを再検証する。
最初のremote mutationより前に`runpod:preflight:<environment>`を実行し、認証、templateの
一意性、endpoint invariant、workerがidleであることをread-onlyで検証する。

planを確認した後、API keyをcredential storeまたは一時環境変数から供給してdeployする。

```bash
pnpm run runpod:deploy:staging
```

productionのlegacy commandはfail-closedで終了する。localから直接実行せず、
candidate照合済みのproduction workflowだけが`runpod:promote:production`を使用する。

```bash
pnpm run runpod:deploy:production
```

scriptは既存の同名resourceを先に検査し、固定planと一致する場合だけ再利用する。template
確定後かつendpoint作成前に、plan digest、template ID、未確定endpointを
`.runpod/deploy/<environment>-state.json`へ0600で保存する。作成応答を失っても、同じpending
state、名前、templateが一意に一致する場合だけ再利用する。stateのない既存endpointは
自動採用しない。API応答、実ID、実originは標準出力へ出さない。削除や既存templateの
更新は行わない。

固定`runpodctl`の既知の取得境界と補償制御は
[ADR 0012](./adr/0012-runpodctl-staging-verification-boundary.md)を正とする。2.7.2では
providerがServerless templateへ既定の`8888/http`と`22/tcp`を追加し、CLIから空へ更新
できない。発生時は[ADR 0032](./adr/0032-automate-runpod-default-port-normalization.md)に
従い、promotionが未接続かつidleを確認し、公式template update APIで既知の二つだけを
自動除去する。mutationは再試行せず、直後の`template get`が固定planへ完全一致した場合
だけendpointの切替へ進む。Consoleでのcandidateごとのport削除は通常手順に含めない。

同versionは`serverless update --workers-min 0`も成功終了するが、実際の値を0へ変更しない。
smokeで一時的にactive workerを1へ上げた場合は、全jobのterminalを確認してからConsoleで
0へ戻す。Console保存後はtemplateのregistry credentialが追跡外planと一致するか再取得し、
戻っていた場合はcredential IDだけをCLIで再適用する。最後にtemplateとendpointの標準
deploy verifierを通す。

同versionの`serverless get`はcompute typeとGPUを省略することがある。その省略を一致とは
みなさない。作成時は第1GPU候補でendpointをbootstrapした後、workerが0件であることを
確認して公式REST APIへ固定GPU候補を一度だけ適用し、直後のREST read-backが順序を含めて
完全一致した場合だけstateを確定する。`dataCenterIds`はPATCH応答とREST GETから
省略されるため、Consoleと同じGraphQL queryで`locations`と`compliance`をread-backする。
公式RESTのGPU情報と結合し、固定planへ完全一致した場合だけ続行する。promotion時は
更新前のdata center、GPU、complianceを取得し、data centerを取得できない場合や自動変更
できないcomplianceが不一致の場合はmutation前に停止する。`workersMax=0`でdrainしてから
[ADR 0057](./adr/0057-split-runpod-capacity-mutations.md)に従い、GraphQL
`saveEndpoint`へ現設定をround-tripして`locations`だけを1回変更する。旧GPU保持を中間
read-backしてからREST PATCHへ`gpuTypeIds`だけを1回送り、失敗時は旧data center、旧GPU、
旧template、旧worker上限へ戻す。REST bodyへ`dataCenterIds`を含めない。さらに実job前後の
workerがcandidate template/imageと一致し、Secure Cloud提供・promotion availability・
実Worker配置attestationを満たすまでproduction-readyとしない。

productionでは
[ADR 0056](./adr/0056-require-production-capacity-before-promotion.md)により、上記capacity
更新をcandidate promotion内で行わない。事前の明示承認付きcapacity移行で固定planへの
完全一致を独立read-backし、通常preflightは不一致をremote mutation前に拒否する。
GraphQL data center mutationとREST GPU mutationはそれぞれ再送せず、各段階の反映待ちは
読み取りだけを最大6回、合計30秒に限定する。
事前移行ではjobとrunning/initializing Workerが0であることを確認してworker上限を0へ
drainする。endpoint APIに残るterminal Worker履歴は許容するが、healthの
idle/initializing/ready/runningがすべて0へ収束する前にcapacityを変更しない。

ADR 0054のstaging recoveryでは、固定CLIの作成引数へ2 data centerを明示し、Consoleで
exact selectionを手動確認した。作成応答とGETはfieldを省略したため、これは通常promotion
手順ではなく期限付きの運用例外である。`Security & compliance`は`Any`であり、
data center metadata上は両方がGDPRとHIPAA、片方がISO/IEC 27001とISO 14001にも対応する。
これらはSecure Cloudの代替証跡にしない。data centerと空のcompliance filterはplan
schema、renderer、create/update/rollback、drift testへ追加し、RESTと
Console-equivalent GraphQLを結合する自動read-back境界を確立した。次にstaging endpoint
設定を同期し、formal acceptanceを完了する。read-backが成立しない場合はproductionを
Blockedのままにする。この復旧時の固定配置は
[ADR 0064](./adr/0064-expand-runpod-placement-capacity.md)が恒久方針として置き換えた。
新planは`dataCenterIds=[]`を`Any Region`の明示値とし、既存remote endpointは
staging-firstのcapacity移行とacceptanceが完了するまで変更しない。

このschema変更より前に生成したgit-ignoredのstaging/production planは再利用しない。
remote preflightやmutationより前に固定rendererで再生成し、旧planが新しいvalidatorに
拒否された場合は手でfieldを追記しない。再生成したplan、Cloudflare runtime、GitHub
Environmentが同じendpointを参照することをread-backしてからworkflowへ進む。

2026-07-31のstaging同期では固定rendererによるplan再生成後、recovery endpointの
capacity、template、scale-to-zeroをexact read-backした。旧canonical endpointは削除せず
support証跡名へrenameし、recovery endpointをcanonical名へrenameした。rename前後で両方の
scale-to-zeroとrecovery capacityを再確認し、GitHub staging Environmentのendpoint secretを
Cloudflare runtimeと同じIDへ同期した。値やresource IDは記録せず、workflowと同じread-only
readinessとpromotion preflightの成功だけを記録する。

promotion前のpreflightと、実lifecycle後のWorker証跡は目的が異なる。
[ADR 0055](./adr/0055-separate-worker-evidence-from-idle-promotion-preflight.md)に従い、
前者はactiveまたは未知statusのWorkerを拒否するidle-only検査とする。後者はmutationを
行わない専用verifierとし、candidateと一致するWorker recordが1件以上、`RUNNING`は最大
1件、全recordが`RUNNING`・`EXITED`・`TERMINATED`のいずれかであることを要求する。
template/imageだけでなく、endpoint invariantとREST、Console-equivalent GraphQLを結合した
GPU/data center/complianceも再検証する。専用verifierはscale-to-zero cleanupの代替ではなく、
成否にかかわらず最後に`workersMin=0`をexact read-backする。

初回を含むprewarmは[ADR 0062](./adr/0062-require-stable-candidate-evidence-for-stale-running.md)
に従う。通常のidle/readyに加え、candidate完全一致、job 0、異常state 0、同じWorker IDと
`lastStartedAt`を3回連続確認したstale `running=1`だけを受理できる。初回の次に投入できるのは
合成release fixtureだけであり、利用者dataのadmissionへ流用しない。

正常job後の二回目prewarmは[ADR 0061](./adr/0061-bind-post-refresh-prewarm-to-worker-restart-evidence.md)
に従う。最初のready WorkerのIDと`lastStartedAt`をmode `0600`のrunner一時fileへ保存し、
次job前に同じWorker IDと起動時刻の前進を確認する。job 0、candidate完全一致、単一active Worker、
initializing/throttled/unhealthy 0に加え、stale healthではADR 0062の3回連続確認を要求する。
evidenceはcooldownで削除する。

digest付きimageから`--serverless` templateを新規作成する。Serverless templateは1 endpoint
にだけ関連付けられ、persistent volumeをサポートしない。初期container diskは30 GiB、
port公開なし、secretなしとし、次の非secret環境変数だけを渡す。

- `APP_ENV`
- `ORCHESTRATOR_ORIGIN`
- `ALLOWED_SOURCE_HOSTS`
- `ALLOWED_RESULT_HOSTS`
- `MAX_SOURCE_BYTES`
- `MAX_DURATION_SECONDS`
- `HEARTBEAT_INTERVAL_SECONDS`
- `MODEL_PATH`

templateは上書きせず新revisionとして作成する。stagingのGPU benchmark、claim競合、
artifact/manifest、cleanupを確認してからendpointを切り替える。rollbackは直前に検証済みの
image digestとtemplate revisionへ戻し、volumeやFlashBootを有効化しない。

revision切替後も既存workerは直ちに置換されず、旧imageのOutdated workerが次のrequestを
処理する場合がある。private registry credentialをrotationした場合、失敗済みUnhealthy
workerは新credentialを読み直さない。実jobの前にworkerのtemplate、image、registry
credentialを追跡外plan/stateと照合し、全jobがterminalのときだけ旧workerをConsoleで
terminateする。新workerの3項目一致と起動を確認してからsmokeを再開する。
