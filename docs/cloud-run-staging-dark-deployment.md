# Cloud Run staging dark deployment

## Status and scope

- Status: Phase 14 local preparation in progress
- Date: 2026-08-11
- Product routing: RunPod Serverless
- Cloud/CI mutation: none

Phase 14の実staging gateに先立ち、Orchestratorのdurable runtime protocolとshadow namespaceをlocalで固定した。
この文書はdeploy手順またはcloud resource作成承認ではない。`CLOUD_RUN_RUNTIME_MODE`はWrangler設定へ追加せず、
default Worker wiringへruntime serviceを注入していない。

## Local persistence boundary

`0011_cloud_run_runtime_protocol.sql`は`provider_executions`に従属するbootstrapとsession eventだけを保存する。
identity token、raw session token、challenge、signature、presigned URL、object本文、provider resource URLは保存しない。

- bootstrap request IDとexecutionは1対1で、request digestを変更した再利用を拒否する。
- challenge消費は未消費かつ未期限切れのrowだけをCAS更新し、exact claim digest retryには保存済みsessionを返す。
- eventはsessionとsequenceを主キーにし、DB triggerがsequence更新とterminal revokeを同じstatementで実行する。
- terminal payloadはstatus、allowlist error code、artifact/segment count、duration、manifest flagだけを列として保存する。
- attempt readはactive attempt、Cloud Run provider/policy、contract v2、source ETag/size、owner hash、result prefixを完全照合する。

## Shadow route boundary

`/internal/cloud-run/*`は次の全条件が成立した場合だけruntime HTTP handlerへ渡す。

1. `APP_ENV=staging`
2. `CLOUD_RUN_RUNTIME_MODE=synthetic-shadow`
3. reviewed runtime service portsがprocess内で明示注入済み

mode未設定、local、production、不明値は404である。modeだけを設定してserviceを接続していない状態は503となる。
UI、通常Queue、RunPod internal routeからこのnamespaceへ分岐しない。

## Local controller boundary

mutationとlive attestationは`@scribe-drop/contracts`のstrict schemaと同じHMAC framingを共有する。controllerの
`/v1/executions/attest`は署名済みopaque handleを受け、control store record、Cloud Run Job、Execution listを毎回
照合する。exact 1 execution、fixed manifest、record/live UID、runtime service account、task 1、retry上限のいずれかが
一致しなければ`found`を返さない。attestationはread-onlyで、provider mutationを発生させない。

Orchestrator clientはHTTPS origin、最大60秒の署名lifetime、256 bit以上のsecret、10秒timeout、redirect拒否、
16 KiBのJSON response上限、request/handle identity一致を強制する。cleanupはlive attestationで得たcontroller versionを
条件にexact 1回だけ送る。timeoutまたはresponse loss後は結果不明として閉じ、自動再送しない。

これらはlocal port実装であり、environment variable、secret、default runtime service wiring、controller Serviceには
接続していない。

## Local Firestore controller store

official `@google-cloud/firestore` clientを使うadapterは専用named database IDとproject IDだけを受け、credential fileや
keyを構成に持たずADCへ委ねる。environment singleton、global request ID、opaque execution handleの3 collectionを使い、
create admissionでは全3 documentを一つのtransactionで読み、execution/request createとenvironment updateを同じcommitへ
閉じる。transaction callbackはFirestore SDKに再実行され得るため、callback内ではdocument writeのstage以外の外部副作用を
行わない。Cloud Run APIはtransaction成功後にcontroller serviceが呼ぶ。

- environment singletonはexact authorization epoch/policy、active handle/count、lifetime execution count、worst-case JPY
  reservation、直近60秒のaccepted requestだけを保持する。
- active executionはenvironmentごとに1件、count/JPYは有限authorization内で全額をcreate前にreserveする。cleanupで解放する
  のはactive slotだけであり、同じauthorization epochのlifetime reservationは戻さない。
- request IDはenvironmentをまたいでglobal uniqueとし、action、digest、environment、handleが完全一致するretryだけを
  duplicate responseへ収束する。変更再利用はconflictとする。
- execution updateはversion CASとimmutable environment/bootstrap request/job ID/created time/expiry/reservationを照合する。
  cleanup commitだけがexecution更新とactive slot解放を同じtransactionで行う。
- read時にもstrict schema、path/body handle、bootstrap request、TTL、active singleton、reservation accountingを検証する。
  drift、missing singleton、transaction failureではprovider mutationへ進まない。
- request/execution documentは31日expiryに対応する`ttlExpiresAt`を持つ。実databaseのTTL policyはまだ作成しておらず、
  即時削除をreplay/cleanupの前提にしない。

adapter restart、Firestore transaction callback retry、並行create/CAS、exact replay、stale version、rate/budget、cleanup release、
authorization/path/TTL/singleton driftをlocal serialized fakeで検証した。named Firestore database、TTL policy、IAM、ADCを持つ
controller Serviceへの注入は未実施である。

[ADR 0079](./adr/0079-fix-controller-firestore-database-and-ttl-policy.md)のpure resource planはstaging databaseをSingapore、Native/
Standard、pessimistic transaction、delete protection有効、App Engine/MongoDB/Realtime無効、Firestore API有効、PITR無効へ固定する。
request/execution collection groupの`ttlExpiresAt`だけをoffset 0で設定し、raw field read-backが`ACTIVE`かつancestor index継承の場合だけ
受ける。Firestore Admin APIのdatabase/field exact GETとdatabase-wide `ttlConfig:*` list clientは同じtoken/quota projectで2回readし、
期待2件以外、重複、paginationを拒否する。list順序だけを正規化し、継続変化するoutput-only `earliestVersionTime`だけを安定性比較から
除外する。database/TTL作成、delete protection変更、実credential read-backは行っていない。
Service/security、IAM、Firestoreのraw observationは同じdeployment configから各planを導出するatomic verifierでも束ね、別project/databaseの
観測や未知sectionを混在させたevidenceを拒否する。deployment-level read-only clientは個別clientと固定endpoint builderを共有し、全endpointを
一つのaccess token/quota projectで並列取得する2 snapshotへまとめる。個別resource間でtokenや観測窓が分かれた結果をatomic evidenceとして
扱わない。

## Local controller composition

strict composition rootはmanifest、synthetic authorization、Firestoreを一度に検証し、environmentとprojectを一致させる。
immutable imageは同projectのSingapore Artifact Registry digest、runtime identityは同projectのuser-managed service account
だけを許可する。構成が成立した後にFirestore store、Cloud Run Admin client、controller service、HMAC HTTP handlerを結ぶ。
default disabled authorizationをseedしたlocal testでは、正しい署名のcreateも`BUDGET_EXHAUSTED`となり、Google ADC token取得と
provider HTTPは0回である。

Google Admin API token adapterはofficial Google Auth LibraryのADC/cloud-platform scopeを使い、null、control/whitespace、
8 KiB超過tokenを拒否する。HMAC key adapterはSecret Managerから将来注入する値をcanonical base64urlとしてdecodeし、32〜64
byte、primary/secondary非同一、defensive copyを強制する。token、secret、signatureはlog recordへ入れない。

Node process entrypointは次の値だけを参照する。platformが追加する他のenvironment variableはauthorizationやpolicyへ混ぜない。

| Setting                                               | Rule                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `APP_ENV`                                             | `staging`または`production`                                   |
| `PORT`                                                | canonical decimal、1〜65,535                                  |
| `SCRIBE_DROP_GCP_PROJECT_ID`                          | manifest、Firestore、image、service accountと完全一致         |
| `SCRIBE_DROP_FIRESTORE_DATABASE_ID`                   | dedicated named database ID                                   |
| `SCRIBE_DROP_CLOUD_RUN_IMAGE_DIGEST`                  | Singapore Artifact Registryのimmutable digest                 |
| `SCRIBE_DROP_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`       | 同projectのdedicated runtime account                          |
| `SCRIBE_DROP_ORCHESTRATOR_ORIGIN`                     | credentialなしHTTPS origin                                    |
| `SCRIBE_DROP_SOURCE_HOST` / `SCRIBE_DROP_RESULT_HOST` | exact capability host                                         |
| `SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY`                 | Secret Managerから注入するcanonical base64url 32〜64 byte     |
| `SCRIBE_DROP_CONTROLLER_HMAC_SECONDARY`               | optional、primaryと異なるrotation key                         |
| `SCRIBE_DROP_AUTHORIZATION_*`                         | 全6値欠落ならdisabled、全値揃ったfinite authorizationだけ許可 |

HTTP transportはclientのHostをresource scopeに使わず固定internal authorityでFetch handlerへ渡す。absolute/authority-form targetを
invalid routeへ置換し、bodyは4,097 byteだけ保持、headerは8 KiB/32件、receive timeoutは15秒、socketあたりrequestは100件に制限する。
process logは固定controller recordとready/failure markerだけで、起動例外を文字列化しない。SIGINT/SIGTERMでは新規受付を閉じる。
実testではsocketをlistenせずpure transport/configを検証する。Secret Manager version binding、Cloud Run Service、registry
publish、実credentialによるdeployed service read-backは未実施である。

## Local controller image boundary

controller buildはworkspace build後にpnpmのproduction deploy bundleをtask固有temporary directoryへ作り、そのdirectoryだけを
Docker contextにする。deploy用workspaceもtemporary directoryへ必要なpackage manifest、lockfile、build outputだけを複製し、
root `node_modules`のinstall stateがbuild前後で変化した場合は失敗する。runtime baseはNode `24.18.0`を実際に起動して確認したdistroless Debian 13のimmutable
`linux/amd64` manifest `sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514`へ固定する。
build outputはsymlinkや非regular fileを拒否して`.js`だけをbundleへ写し、package manager、shell、build tool、devDependency、
source tree、declaration、source mapをruntimeへ持ち込まない。

image verifierはplatform、300 MB上限、UID/GID `10001:10001`、`/app`、exact entrypoint、空のinherited command、8080だけの
exposed port、volume不在、base digest/name/version/policy labelをinspectする。HMAC secretまたはcredential file environmentを
imageへ焼き込んだ場合も拒否する。offline container checkはnetwork none、read-only root filesystem、全capability drop、
`no-new-privileges`、PID 64、256 MiB、1 CPU、16 MiB noexec/nosuid tmpfsで実行する。container内でもcontroller entrypointと
contracts/domain/Firestore/Google Auth/Zod runtimeの存在、shell/BusyBox/npm/pnpm/TypeScript/`@types/node`/source/declaration/
source mapの不在を検証する。

local imageはCycloneDX SBOMを`/tmp/scribe-drop-gpu-controller.cdx.json`だけへ生成し、Trivyのunfixedを含む
HIGH/CRITICAL fail-close scanを通過した。local image IDとSBOMはrelease artifactでもstaging evidenceでもなく、commitしない。
image publish、signature/provenance、registry read-back、Cloud Run Serviceへのdigest bindingは実staging gateに残す。

## Local controller Service deployment plan

pure deployment planはCloud Run v2 Serviceのsecurity/runtime上意味を持つfieldを次へ固定する。これはAPI request送信、YAML適用、
Terraform apply、`gcloud run deploy`を行わない。

| Boundary            | Fixed local plan                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ |
| location/runtime    | `asia-southeast1`、`EXECUTION_ENVIRONMENT_GEN2`                                      |
| image/identity      | 同project Artifact Registryのimmutable digest、専用user-managed controller account   |
| compute             | 1 vCPU、512 MiB、request-based CPU、startup boostなし                                |
| scaling/concurrency | service/revision min 0、max 1、instance concurrency 8                                |
| request/traffic     | 60秒timeout、latest revision 100%、session affinityなし                              |
| ingress/auth        | public ingress、default URI有効、IAM invoker check無効、IAPなし、application HMAC    |
| supply chain        | controller Serviceと各GPU JobにBinary Authorization default policy必須               |
| storage/network     | volumeなし、VPC accessなし                                                           |
| secret/config       | HMACはenvironment別distinct secretの数値version、その他はexact environment allowlist |
| authorization       | 初期値は明示的なexecution 0、request 0、budget 0                                     |

containerは既に`0.0.0.0`のCloud Run注入`PORT`でlistenする。planは8080/http1を固定し、`PORT`自体をuser environmentへ
重複設定しない。environment read-backは順序だけを正規化し、名前の重複、不足、未知値、secret/value表現の変更を拒否する。
service/secret名にはstagingまたはproductionのdelimiter付きmarkerを要求し、controller/worker imageとcontroller/runtime identityは
同じprojectへ限定する。

normalized read-back verifierはcontroller Serviceのimage、identity、secret version、ingress、Binary Authorization、scaling、traffic、resource、
environmentの完全一致だけを受ける。Cloud Run v2 raw adapterはstrict response schema、generation収束、ready revision、latest 100%
traffic、root HTTPS `run.app` URIを検証してnormalized shapeへ変換する。project由来のoutput-only `threatDetectionEnabled`はevidenceへ
分離し、desired-state driftには使わない。IAM policyはpublic/excess bindingなし、Secret ManagerはSingapore user-managed replica、数値
fixed versionの`ENABLED`、exact secret-level accessor、Binary Authorizationはglobal policy有効、allowlist/specialized ruleなし、exact
attestorによるblock-and-auditをlocal raw schemaで照合する。controller custom roleとruntime `actAs`を含むlive API read-backは未接続であり、
Cloud Run Service、空のService resource IAM、primary/secondary secret、Binary Authorizationは同一project/environmentのatomic local
evidenceへ束ね、secondary observationの欠落・余剰を拒否する。read-only clientはCloud Run v2 Service/IAM、Secret Manager
secret/version metadata/IAM、Binary Authorization policyの固定endpointだけをGETし、redirect、非JSON、256 KiB超過、10秒timeoutを拒否する。
同じaccess tokenとquota projectで全endpointを2回readし、canonical response差分があれば観測を破棄する。`:access`によるsecret payload取得、
retry、mutationは行わない。cloud review後に実credentialで各authoritative observationを取得してこの検証へ渡す。
各ephemeral GPU Jobもcreate bodyとlive read-backの両方でBinary Authorization default policyを必須とし、欠落、無効化、
policy override、breakglassは実行前のresource driftとして拒否する。

controller authorityは[ADR 0078](./adr/0078-split-controller-iam-by-resource-boundary.md)に従うpure IAM planで分割する。Cloud Run Jobs roleは
実clientが呼ぶ8 permissionだけ、Firestore roleはtransactionとentity CRUDの5 permissionだけとし、database条件、runtime
`roles/iam.serviceAccountUser`、repository `roles/artifactregistry.reader`をcontroller principalの単独bindingとして固定する。raw custom
roleとIAM policy verifierは他principalのproject bindingを無視する一方、controllerの追加role、他principalとの混在、条件/resource driftを
拒否する。IAM read-only clientはcustom role GETとproject/repository/runtime service accountの`getIamPolicy`だけを固定endpointへ送り、
同じtoken/quota projectの2回のresponseが一致した場合だけ検証へ渡す。HTTP POSTは`:getIamPolicy`に限定し、`setIamPolicy`と不正bodyを
request送信前に拒否する。live IAM APIは未実行である。

## Local Google identity boundary

Google OAuth JWKSだけを固定HTTPS URLから取得し、redirect、5秒超過、64 KiB超過、非JSON、invalid Cache-Control、重複・
不明keyを拒否する。cache lifetimeはresponseの`max-age`と24時間上限の短い方とし、unknown `kid`によるfetch amplificationを
30秒cooldownで抑え、同時cache missは一つのrequestへまとめる。

tokenは8 KiB以下のRS256 JWTに限定し、Google署名、exact audience、`https://accounts.google.com` issuer、issue/expiry、
1時間上限、`sub == azp`、`email_verified == true`、service-account emailを検証する。Googleの`sub`/`azp`はservice accountの
数値IDでありemailではないため、runtime serviceは数値subjectとverified emailを別fieldで受け、dedicated runtime accountの
一致にはemailを使う。このadapterもdefault runtime serviceへ未注入である。

## Local evidence

```bash
pnpm --filter @scribe-drop/orchestrator typecheck
pnpm --filter @scribe-drop/orchestrator test:workers
pnpm exec vitest run apps/orchestrator/src/cloud-run-runtime-service.test.ts \
  apps/orchestrator/src/cloud-run-runtime-http.test.ts \
  apps/orchestrator/src/cloud-run-runtime-shadow.test.ts \
  apps/orchestrator/src/cloud-run-runtime-capabilities.test.ts \
  apps/orchestrator/src/cloud-run-controller-client.test.ts \
  apps/orchestrator/src/google-identity-verifier.test.ts \
  apps/gpu-controller/src/authentication.test.ts \
  apps/gpu-controller/src/controller-service.test.ts \
  apps/gpu-controller/src/firestore-control-store.test.ts \
  apps/gpu-controller/src/firestore-deployment.test.ts \
  apps/gpu-controller/src/firestore-readback-client.test.ts \
  apps/gpu-controller/src/control-plane-evidence.test.ts \
  apps/gpu-controller/src/deployment-readback-client.test.ts \
  apps/gpu-controller/src/google-runtime-auth.test.ts \
  apps/gpu-controller/src/container-invariants.test.ts \
  apps/gpu-controller/src/node-http-server.test.ts \
  apps/gpu-controller/src/process-configuration.test.ts \
  apps/gpu-controller/src/process.test.ts \
  apps/gpu-controller/src/runtime.test.ts \
  apps/gpu-controller/src/service-deployment.test.ts \
  apps/gpu-controller/src/google-control-plane-read.test.ts \
  apps/gpu-controller/src/iam-deployment.test.ts \
  apps/gpu-controller/src/iam-readback-client.test.ts \
  packages/contracts/src/cloud-run-controller.test.ts
pnpm d1:verify
pnpm container:build:gpu-controller
pnpm container:check:gpu-controller
pnpm container:sbom:gpu-controller
pnpm container:scan:gpu-controller
```

Workers integrationはbootstrap/claim replay、sequence 0 ACK、heartbeat順序、concurrent exact replay、terminal payload、
persist-before-revoke、source/result ownership driftをlocal D1で検証する。これはremote D1、Google identity、controller、
Cloud Run Job、R2 signed request、課金停止のevidenceではない。

## Remaining real staging gate

次の作業にはCI/cloud resource変更の明示承認と、release candidateのPhase境界に従うbranch/commitが必要である。

- Phase 8〜13の`develop`統合、`release/0.2.0`作成、version固定、一度だけのcandidate build
- dedicated named Firestore database/TTL policy、controllerへのadapter injection/service hosting、controller image publish、
  controller/worker imageのsignature/provenanceとattestation発行、Cloud Run v2/IAM/Secret Manager/Binary Authorization
  read-only clientの実credential実行とauthoritative evidence、
  HMAC secret rotation
- local Google identity token/JWKS verifierとcontroller attestation/cleanup clientの実service接続
- staging D1 migration、shadow mode/service injection、synthetic execution最大1件
- timeout/response loss/hard lifetime/reaper、artifact/manifest、resource/storage不存在、課金終了の期限付きevidence

実staging gateを開始するまで`CLOUD_RUN_RUNTIME_MODE`をsource configuration、dashboard、secretへ設定しない。
