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

image visibility、candidateの共通digest、environment別registry auth ID、GPU、data centerと
同じenvironmentのCloudflare値をcredential storeまたはCI evidenceから読み込み、追跡外planを
生成する。

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
staging promotionではcandidate固有planを再検証する。
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

同versionの`serverless get`はcompute type、GPU、data centerを省略することがある。
scriptはplanから生成する作成引数全体をテストで固定し、取得できるendpoint invariantを
厳格照合する。省略項目は同一pending stateとtemplateがある場合だけ回復を許可し、初回
worker起動後にGPUとSecure Cloudを`runpodctl`で確認するまでproduction-readyとしない。

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
