# Cloud Run staging dark deployment

## Status and scope

- Status: second exact-one GPU execution failed closed; next candidate fix in local validation
- Date: 2026-08-13
- Product routing: RunPod Serverless
- Cloud/CI mutation: staging release supply chain and disabled controller control plane; production untouched

Phase 14の実staging gateに先立ち、Orchestratorのdurable runtime protocolとshadow namespaceをlocalで固定した。
2026-08-12にstaging release supply chainだけを構築し、source-controlled candidate workflowを追加した。
`CLOUD_RUN_RUNTIME_MODE`のsource defaultはstagingでも`disabled`、productionではbinding自体なしとする。Phase 14の実行直前だけ
ignored staging configへ`synthetic-shadow`をrenderし、reviewed production portsがすべて構成できた場合だけruntime serviceを注入する。

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
照合する。exact 1 execution、fixed manifest、runtime service account、task 1、retry上限のいずれかが一致しなければ
`found`を返さない。[ADR 0081](./adr/0081-attest-live-execution-before-controller-observe.md)に従い、controller observe前だけは
durable run intent、`EXECUTION_PENDING`、stored Job UID、exact 1 live Executionを条件にstored Execution UIDの欠落を許す。
observe後はstored/live Execution UIDも完全一致させる。attestationはread-onlyで、provider mutationを発生させない。

Orchestrator clientはHTTPS origin、最大60秒の署名lifetime、256 bit以上のsecret、10秒timeout、redirect拒否、
16 KiBのJSON response上限、request/handle identity一致を強制する。cleanupはlive attestationで得たcontroller versionを
条件にexact 1回だけ送る。timeoutまたはresponse loss後は結果不明として閉じ、自動再送しない。

staging限定composition rootはD1 store、Google OIDC verifier、controller attestation/cleanup、R2 capability、HMAC/Ed25519を
一つのserviceへ結ぶ。mode、2つの相異なるcanonical secret、exact controller/orchestrator origin、runtime identity、R2/account/bucketの
いずれかが欠ければserviceを生成せず、shadow routeは404または503へ閉じる。production configにはCloud Run runtime bindingを追加しない。
staging controller Serviceとremote Workerはsecond exact-one cleanup後にauthorization 0、shadow route 404へ戻し、
Cloud Run Job/Executionと今回のsynthetic dataも0へ収束した。

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
- request/execution documentは31日expiryに対応する`ttlExpiresAt`を持つ。staging databaseの両TTL policyは`ACTIVE`へ収束したが、
  即時削除をreplay/cleanupの前提にしない。

adapter restart、Firestore transaction callback retry、並行create/CAS、exact replay、stale version、rate/budget、cleanup release、
authorization/path/TTL/singleton driftをlocal serialized fakeで検証した。named Firestore database、TTL policy、IAM、ADCを持つ
controller Serviceへの注入とstrict read-backは完了した。disabled authorizationのためdocument mutationはまだ発生させていない。

[ADR 0079](./adr/0079-fix-controller-firestore-database-and-ttl-policy.md)のpure resource planはstaging databaseをSingapore、Native/
Standard、pessimistic transaction、delete protection有効、App Engine/MongoDB無効、Firestore API/Realtime有効、PITR無効へ固定する。
Standard/Native databaseが省略するFirestore/MongoDB access-mode fieldは固定defaultとしてのみ正規化し、明示された矛盾値を拒否する。
request/execution collection groupの`ttlExpiresAt`だけをoffset 0で設定し、raw field read-backが`ACTIVE`かつancestor index継承の場合だけ
受ける。Firestore Admin APIのdatabase/field exact GETとdatabase-wide `ttlConfig:*` list clientは同じtoken/quota projectで2回readし、
list methodが0以外の`pageSize`を拒否するlive contractに従ってpage sizeを送らず、response schema側で最大3件へ閉じる。
TTL fieldのinherited indexで既定`apiScope: ANY_API`が省略された場合だけ正規化し、別scopeとindex overrideを拒否する。
databaseのsliding `earliestVersionTime`と連動してetagもmutationなしに変化するため、double-snapshotの安定性比較から両方だけを除外し、
2回目のetagはevidenceとして保持する。期待2件以外、重複、paginationを拒否する。staging database作成、delete protection有効化、
両TTLの`ACTIVE`収束後に実credentialのstrict double-snapshotを通過した。
Service/security、IAM、Firestoreのraw observationは同じdeployment configから各planを導出するatomic verifierでも束ね、別project/databaseの
観測や未知sectionを混在させたevidenceを拒否する。deployment-level read-only clientは個別clientと固定endpoint builderを共有し、全endpointを
一つのaccess token/quota projectで並列取得する2 snapshotへまとめる。個別resource間でtokenや観測窓が分かれた結果をatomic evidenceとして
扱わない。

## Local controller composition

strict composition rootはmanifest、synthetic authorization、Firestoreを一度に検証し、environmentとprojectを一致させる。
immutable imageは同projectのSingapore Artifact Registry digest、runtime identityは同projectのuser-managed service account
だけを許可する。orchestrator originはschema境界でroot末尾`/`付きへ正規化し、Jobのidentity audienceをそのorigin直下の
`internal/cloud-run/bootstrap`へ完全一致させる。構成が成立した後にFirestore store、Cloud Run Admin client、controller service、
HMAC HTTP handlerを結ぶ。
default disabled authorizationをseedしたlocal testでは、正しい署名のcreateも`BUDGET_EXHAUSTED`となり、Google ADC token取得と
provider HTTPは0回である。

Google Admin API token adapterはofficial Google Auth LibraryのADC/cloud-platform scopeを使い、null、control/whitespace、
8 KiB超過tokenを拒否する。HMAC key adapterはSecret Managerから将来注入する値をcanonical base64urlとしてdecodeし、32〜64
byte、primary/secondary非同一、defensive copyを強制する。token、secret、signatureはlog recordへ入れない。
live stagingでは`basenc --base64url`が付けたpaddingをstartup parserがfail closedで拒否した。payloadをread-backせず、paddingを
除く生成pipelineでversion 2を作成し、未使用version 1を復元可能なdisabledへ移した。Serviceは数値version 2だけを参照する。

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
pure transport/config testに加え、stagingではSecret Managerの固定versionをCloud Run Serviceへbindingし、ready状態と
実credentialによるdeployed service double-snapshotを確認した。authorizationはexecution/request/budgetすべて0である。

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
先行candidateでpublish済みの署名付きimageは非GPU preflightだけに利用した。このread-back修正を含む最終candidateのpublish、
署名/provenance検証、Serviceへのdigest差し替えは実staging gateに残す。

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
同じprojectへ限定する。gcloudがservice labelsをrevision templateへも伝播するため、component/environment/policyの3固定labelを
ServiceとRevisionの両方で完全一致させ、欠落と追加を拒否する。

normalized read-back verifierはcontroller Serviceのimage、identity、secret version、ingress、Binary Authorization、scaling、traffic、resource、
environmentの完全一致だけを受ける。Cloud Run v2 raw adapterはstrict response schema、generation収束、ready revision、latest 100%
traffic、root HTTPS `run.app` URIを検証してnormalized shapeへ変換する。project由来のoutput-only `threatDetectionEnabled`はevidenceへ
分離し、desired-state driftには使わない。Cloud Run v2が省略する`reconciling: false`と追加した`sshEnabled: false`だけを安全な
defaultとして許可し、trueを拒否する。自動注入されるstartup TCP probeはport 8080、timeout/period 240秒、failure threshold 1だけを
許可し、変更を拒否する。IAM policyはpublic/excess bindingなし、Secret ManagerはSingapore user-managed replica、数値fixed versionの
`ENABLED`、exact secret-level accessorへ固定する。Secret Managerのlive metadataがcanonical resource名にproject numberを
返すため、read-back expectationにauthoritative project numberを含め、requestのproject IDとresponseのproject numberを別々に完全照合する。
LATEST/100%の`trafficStatuses`でrevisionが省略された場合はlatest ready/created一致とdesired LATEST/100%で補い、明示されたrevisionは
latest readyとの完全一致だけを許可する。
Binary Authorizationはglobal policy有効、allowlist/specialized ruleなし、exact
attestorによるblock-and-auditをlocal raw schemaで照合する。controller custom roleとruntime `actAs`を含むlive API read-backも実施し、
Cloud Run Service、空のService resource IAM、primary/secondary secret、Binary Authorizationは同一project/environmentのatomic local
evidenceへ束ね、secondary observationの欠落・余剰を拒否する。read-only clientはCloud Run v2 Service/IAM、Secret Manager
secret/version metadata/IAM、Binary Authorization policyの固定endpointだけをGETし、redirect、非JSON、256 KiB超過、10秒timeoutを拒否する。
同じaccess tokenとquota projectで全endpointを2回readし、canonical response差分があれば観測を破棄する。`:access`によるsecret payload取得、
retryは行わない。staging resource作成後、実credentialのauthoritative observationをこの検証へ渡して完全一致を確認した。
各ephemeral GPU Jobもcreate bodyとlive read-backの両方でBinary Authorization default policyを必須とし、欠落、無効化、
policy override、breakglassは実行前のresource driftとして拒否する。

release attestorの供給網は
[ADR 0080](./adr/0080-use-kms-backed-binary-authorization-attestations.md)に従う。project singleton attestorとglobal Artifact
Analysis Noteはrelease candidate専用とし、private keyをexportせずSingapore software KMS ECDSA P-256 keyでcontroller/worker
両digestを署名する。global Noteはdigest/signature metadataだけの明示例外であり、application dataを保存しない。attestor、Note、
KMS public key/signing version、publisher/signer/repository IAMのpure planとstrict read-back verifierを追加した。read-only clientは
Binary Authorization、global Artifact Analysis、Singapore KMS、Artifact Registry、Resource Managerの固定resourceだけを同じtoken/
quota projectで2回取得する。両digestのOccurrenceは`ATTESTATION` kind、exact Note/image/KMS key ID、gcloud 579のcanonical
payload、各1件へ固定し、Binary Authorization validationが両方`VERIFIED`であることとvalidation前後の不変性をlocal検証する。
release用WIFのpure planはglobal pool/provider、Google canonical audience、immutable repository/owner ID、exact staging
Environment subject、release branch、`workflow_dispatch`、固定candidate workflowを同時に要求する。publisher/signerの各service
accountにはrepository IDの単一principalだけを`roles/iam.workloadIdentityUser`で許可する。strict read-backはpool/providerの
active状態、exact attribute mapping/condition、相異なるservice-account ID、exact IAM、user-managed key 0を固定IAM endpointの
double snapshotで照合する。

2026-08-12に必要API、Singaporeのimmutable `controller`/`worker` repository、WIF pool/provider、publisher/signer、KMS key
version 1、Note、attestor、project default policyと限定IAMを作成した。実credentialのstrict double snapshotはexact planとの
一致と途中変更なしを確認した。live APIはNote IAMの`POST :getIamPolicy`、`userOwnedGrafeasNote`、false値を省略する
`importOnly`/`disabled`へ合わせ、trueや未知fieldは引き続き拒否する。candidate workflowはrelease branchとcommit/version一致、
OIDC、full gate、SBOM/scan、各image 1 push、registry digest、KMS署名、0600のmetadata-only evidenceへ固定した。
初回workflowは旧branch-context subjectをpublisher OIDC preflightで拒否し、後続stepを実行しなかった。GitHub OIDC
customization APIのimmutable subject prefix、staging Environmentの`release/*`単一branch policyをread-backし、subjectを
exact `environment:staging` contextへ修正した。失敗後も両repositoryは空、project Occurrenceは0であり、candidate image、
attestation、Cloud Run Service/Jobはその時点ではまだ存在しなかった。修正後runではOIDCとkeyless gcloud preflightが成功したが、auth actionの
一時`gha-creds-*.json`をroot Prettierが走査してapplication gateで停止し、image buildへ到達しなかった。application/secret/
dependency gateをcloud authより前、OIDC preflightをimage build直前へ固定し、一時credentialをGitとDocker build contextから
明示除外した。次のrunはfull gate、OIDC、keyless gcloud preflightを通過し、controller image build後のinspectionで停止した。
Dockerfileの`CMD []`はDocker engineによりlive `docker inspect`で`Config.Cmd: null`またはfield省略となるため、no-command
の2 serializationだけを許可し、unexpected commandを拒否する回帰テストを追加した。push/signingには到達しておらず、
controller build/check/SBOM/Trivy、RunPod worker build、Cloud Run worker build/check/SBOM/Trivyの同一9 commandはlocalで成功した。
次のrunは同じgateと両imageの1回push、registry digest解決、isolated signer OIDCまで成功した。pinned gcloudに`beta`
componentがなく、attestation commandが非対話promptの前に停止したため、両repositoryに各1 image、Occurrence 0をread-backした。
公式setup-gcloudの`install_components: beta`をversion 579と同時に固定し、static verifierで必須化する。失敗candidate imageは
成功candidateのread-back後にexact tag/digestで削除し、成功artifactを保持する。
component修正後runは全stepに成功し、candidate evidenceのcommit/run/attempt/digestも一致した。Artifact Analysisには両
Occurrenceが存在したが、strict clientのproject-scoped、schemeなしfilterが空を返した。GoogleのBinary Authorization手順と
同じNote-scoped endpointへ修正する。live gcloud 579のOccurrenceはschemeなし`resourceUri`を保存し、Note-scoped比較では
schemeなしfilterだけが各1件、`https://` filterは0件だったため、単一`resourceUrl="<digest image>"` filterへ固定する。
responseでkind、Note、resource URI、payload、keyを完全照合し、Binary Authorization `VERIFIED`、validation前後不変を
再検証する。このverifier変更を含む新candidateを作るまで既存成功runをstaging evidenceに採用しない。

controller authorityは[ADR 0078](./adr/0078-split-controller-iam-by-resource-boundary.md)に従うpure IAM planで分割する。Cloud Run Jobs roleは
実clientが呼ぶ8 permissionだけ、Firestore roleはtransactionとentity CRUDの5 permissionだけとし、database条件、runtime
`roles/iam.serviceAccountUser`、repository `roles/artifactregistry.reader`をcontroller principalの単独bindingとして固定する。raw custom
roleとIAM policy verifierは他principalのproject bindingを無視する一方、controllerの追加role、他principalとの混在、条件/resource driftを
拒否する。IAM read-only clientはcustom role GETとproject/repository/runtime service accountの`getIamPolicy`だけを固定endpointへ送り、
同じtoken/quota projectの2回のresponseが一致した場合だけ検証へ渡す。HTTP POSTは`:getIamPolicy`に限定し、`setIamPolicy`と不正bodyを
request送信前に拒否する。live custom role responseで削除されていないroleの`deleted: false`が省略された場合だけfalseへ
正規化し、`deleted: true`、permission、stage、title、description、binding/conditionの差分は引き続き拒否する。

## Staging non-GPU preflight

2026-08-12に、既存の署名検証済みcandidate imageを使って最終image buildを待たずに次を先行検証した。既存imageは後続の
source変更を含まないため、最終acceptance evidenceやproduction昇格artifactには使用しない。

- Firestore named databaseをSingapore/Native/Standard、delete protection有効、PITR無効で作成し、request/executionのTTL 2件を
  `ACTIVE`へ収束させた。database/TTLのstrict double-snapshotは完全一致した。
- controller/runtime service account、Jobs/Firestore custom role、database/repository/runtime/secretの限定bindingを作成し、IAMの
  strict double-snapshotを通過した。
- canonical base64url HMAC secretの固定versionと、execution/request/budgetをすべて0にしたcontroller Serviceをdeployした。
  Service、IAM、Secret metadata、Binary Authorization、Firestoreを一つの観測窓で2回読み、readyかつ完全一致を確認した。
- 固定L4 manifestのephemeral Jobを1件だけcreate/read-backし、Binary Authorization、runtime identity、worker digest、task/retry/
  timeoutを照合した。`jobs.run`は呼ばず、Execution 0を再確認してJobをexact deleteし、不存在までread-backした。
- production resource、CI、remote D1、Cloudflare routingは変更していない。Cloud Run GPU executionも0である。

## Local Google identity boundary

Google OAuth JWKSだけを固定HTTPS URLから取得し、redirect、5秒超過、64 KiB超過、非JSON、invalid Cache-Control、重複・
不明keyを拒否する。cache lifetimeはresponseの`max-age`と24時間上限の短い方とし、unknown `kid`によるfetch amplificationを
30秒cooldownで抑え、同時cache missは一つのrequestへまとめる。transport failure、429、5xxだけを指数backoffとbounded jitterで
最大3 attemptまで再試行し、redirect、schema、signature、claim拒否は再試行しない。verifier例外はruntime boundaryで
`AUTHENTICATION_FAILED`へ正規化する。拒否時はtoken、claim、URL、provider responseを記録せず、allowlist済みの検証stageだけを
`cloud_run_identity_rejected.errorCode`へ1回記録する。

tokenは8 KiB以下のRS256 JWTに限定し、Google署名、exact audience、`https://accounts.google.com` issuer、issue/expiry、
1時間上限、`sub == azp`、`email_verified == true`、service-account emailを検証する。Googleの`sub`/`azp`はservice accountの
数値IDでありemailではないため、runtime serviceは数値subjectとverified emailを別fieldで受け、dedicated runtime accountの
一致にはemailを使う。このadapterはstaging限定composition rootへ接続し、remote Workerのmodeが`disabled`の間は生成されない。

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
  apps/gpu-controller/src/release-supply-chain.test.ts \
  apps/gpu-controller/src/release-supply-chain-readback.test.ts \
  apps/gpu-controller/src/release-supply-chain-readback-client.test.ts \
  apps/gpu-controller/src/candidate-attestation-readback.test.ts \
  apps/gpu-controller/src/candidate-attestation-readback-client.test.ts \
  apps/gpu-controller/src/release-workload-identity.test.ts \
  apps/gpu-controller/src/release-workload-identity-readback.test.ts \
  apps/gpu-controller/src/release-workload-identity-readback-client.test.ts \
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

## First exact-one staging execution

2026-08-13に最終candidateのdigest/attestation、staging resource、finite 1 execution/250 JPY authorization、L4 quota、
Execution 0、disabled shadow routeを照合した後、合成fixtureだけでCloud Run GPU Executionをexact 1件起動した。task count 1、
parallelism 1、retry 0を維持したが、taskは約21秒でallowlist marker `INTERNAL_ERROR`を出して終了した。bootstrap D1 eventは0、
R2 capability発行、source download、transcription、artifact uploadはいずれも0であり、application data effectより前にfail closedした。

cleanupはcontrollerのresponse lossを結果不明として再観測し、`CLEANED`へ収束した。Cloud Run Job/Execution 0、Firestoreの
synthetic request/execution/environment document 0、R2 fixture/result/manifest不存在、shadow route 404、controller
authorization 0へ戻した。D1 synthetic contextのdeleteは成功したが、その直後の独立zero-count readはOAuth 7403で失敗したため、
再認証後に同じtargetだけをread-only queryし0件を確認した。database全体には既存staging fixtureがあるため、全table 0ではなく
今回のexact target不存在をcleanup条件とする。production resourceとroutingは変更していない。

同じworker imageをlocalでGPUなし・networkなしに起動してmarkerを再現し、`python -m`でentry moduleが`__main__`、HTTP adapterの
runtime importがpackage moduleとして二重ロードされ、`OneShotRuntimeError` classが二つになることを確認した。このためmetadata側の
正常な`BOOTSTRAP_REJECTED`がentrypointのgeneric exceptionへ落ちていた。shared errorを独立moduleへ移し、module entrypoint回帰testを
追加する。また実Cloud Run v2 responseの`Execution.job`は短いJob IDだったため、exact requested IDとExecution full parentを照合して
canonical parentへ正規化する。これらのsource変更は既存candidate evidenceを無効化し、新candidateからPhase 14 gateをやり直す。

## Second exact-one staging execution

entrypointとExecution parent修正を含むcandidate `c3b1e89`について、controller/worker attestation各1件、Binary Authorization
`VERIFIED`、controller Service、staging D1/R2、finite 1 execution/250 JPY authorization、L4 quota 3、Execution 0を再照合した。
2026-08-13に合成WAV fixtureだけでGPU Executionをexact 1件起動し、task 1、parallelism 1、retry 0を維持した。image importは
約1分37秒、taskは約9秒で`SESSION_REJECTED`となり、D1 bootstrap/event 0、capability、source download、CUDA/model load、
transcription、artifact uploadはすべて0のままfail closedした。この承認済みexact-oneは消費済みであり、追加実行は別承認を要する。

Cloudflare側ではbootstrap HTTP 500が1件、同じWorker invocationのexternal subrequestは0、remote D1のexact attempt lookupは
1 query/1 row、controller attest requestは0だった。exact staging rowとlive-shaped Google RSA/JWTをworkerdで再現すると両方成功したため、
失敗点はapplication parse/Google identity境界まで絞れたが、単一のremote root causeは断定しない。Google JWKSの限定retryと
authentication error正規化を追加した。またtaskがcontroller observeを追い越す正常な順序では旧attestationが必ず拒否する別のraceを
特定し、ADR 0081の条件と回帰testで修正した。

失敗後はcontrollerを`FAILED`から`CLEANED`へ収束させ、Cloud Run Job/Execution 0、Firestore synthetic document 0、R2 fixture/result/
manifest不存在、D1 exact target 0、shadow route 404、controller authorization 0をread-backした。Service/IAM/Secret/Binary
Authorization/Firestoreのdisabled deploymentも再照合し、localのsecretとfixtureを削除した。production resource、product routing、
CI configは変更していない。今回のsource変更によりcandidate `c3b1e89`のstaging evidenceは無効である。

## Third exact-one staging execution and edge root cause

identity retry/error normalizationとpending Execution attestationを含むcandidate `810189b`を
build run `31673063867`から一度だけpublishし、2 image attestation、Binary Authorization、
controller Service、D1/R2 fixture、finite 1 execution/250 JPY authorization、L4 quota、Execution 0を
再照合した。承認済みGPU Executionはtask 1、parallelism 1、retry 0のままimage importとcontainer
起動に成功したが、約16秒で`SESSION_REJECTED`/exit 1となった。D1 bootstrap/session event、R2
capability、source download、CUDA/model load、transcription、artifact uploadは0だった。

同じcandidate image/runtime service accountのGPUなしprobeで、metadata identity tokenの公開shapeと
全固定claimがcontractに一致することを確認した。実bootstrap POSTはHTTP 403、17 byte、non-JSONで、
同時のWorkers POST tailには到達しなかった。Cloudflare Security EventsはCloud Run Singapore ASNの
probeを`action=block`、`source=bic`として記録し、このPCから同じendpointへ送る無効JSONはWorkerの
`INVALID_REQUEST` JSONを返した。これによりGoogle OIDC/JWKSではなくBrowser Integrity Checkのedge
blockをroot causeと確定した。

[ADR 0082](./adr/0082-skip-browser-integrity-check-for-cloud-run-runtime.md)に従い、zone全体ではなく
staging host、queryなしPOST、5 exact runtime pathだけでproduct `bic`をskipする。ruleはloggingを
維持し、managed WAF、rate limit、Security Levelなどをskipしない。GPU execution前には同じcandidate
image/runtime service accountのGPUなしpreflightで、D1 context/Google OIDC後のcontroller
`RESOURCE_DRIFT` JSONまで到達することを必須にする。edge 403/non-JSONの間はGPUを起動しない。

失敗後はCloud Run Job/Execution、Firestore controller document、D1 exact target、R2 fixture/result/
manifestを0/不存在へ戻し、shadow routeとcontroller authorizationをdisabled/0へ戻した。production、
CI workflowは変更していない。WAF planとpreflightのsource変更によりcandidate `810189b`は無効である。

## Post-BIC GPU-free staging preflight

WAF/preflight修正commit `4fa6c80`のcandidate build `31678897389`はfull application gate、両imageの
build/check/SBOM/HIGH・CRITICAL scan、各1回のpush、KMS署名、controller/worker各1件のBinary
Authorization `VERIFIED`を完了した。controller Serviceを同candidate digestへ更新し、Service/IAM/
Secret/Binary Authorization/Firestoreのstrict read-backも成功した。staging WAFへADR 0082のexact
BIC skipを適用し、独立read-backでhost、queryなしPOST、5 path、`bic`だけ、logging有効を確認した。

GPU 0、CPU 1、512 MiB、task 1、parallelism 1、retry 0の専用Jobを作成し、実行前のmanifestと
Execution 0を完全照合してからGPU-free bootstrap preflightを1回だけ実行した。Cloudflare Security
Eventsは同requestを`action=skip`、Worker analyticsは同時刻の1 requestを記録し、edge statusは403だった。
BIC blockは解消した一方、preflightは期待するapplication `RESOURCE_DRIFT` markerを得ずexit 1となった。
D1 context lookup後もbootstrap/session eventは0で、controller attestationへ到達した証拠もないため、
失敗境界はGoogle identity verificationまでに限定できる。既存の同runtime account metadata probeでは
header、claim type、audience、issuer、service-account email、`sub == azp`、1時間lifetimeが全てcontractと
一致している。Cloudflare公式上、例外になったfetchはsubrequest countへ含まれないため、analyticsの
subrequest 0だけではtoken precheckとJWKS transport exceptionを区別できない。

同じcandidateのblind retryは行わず、JWKS一時障害を最大3 attemptへ強化し、秘密値を含まないallowlist
rejection stageを構造化logへ追加した。このsource変更を含む新candidateのGPU-free preflightで
`RESOURCE_DRIFT`まで証明するまではGPU executionへ進まない。preflight後はCloud Run Job/Execution 0、
Firestore controller collection 3件空、D1 exact target 5系統0、shadow route 404、controller authorization 0へ
戻した。R2は作成せず、productionとCI workflowは変更していない。WAFのexact BIC skipとdisabled candidate
controller Serviceは次のpreflightのため維持する。

identity rejection stageを含むcommit `11cabe1`のcandidate build `31685398800`はfull application gate、
両imageのbuild/check/SBOM/HIGH・CRITICAL scan、各1回のpush、KMS署名、各1件のattestationを完了し、
Binary Authorizationは両digestとも`VERIFIED`だった。controller Serviceをcandidate digestへ更新して
Service/IAM/Secret/Firestoreをstrict read-backし、GPU 0、CPU 1、512 MiB、task 1、parallelism 1、retry 0の
GPU-free preflightをexact 1回だけ実行した。Workerのallowlist logは
`cloud_run_identity_rejected` / `JWKS_TRANSPORT_REJECTED`を1件記録し、3 attemptすべてでGoogle JWKSの
`fetch`がHTTP response前に例外となったことを確定した。token、claim、URL、provider responseは記録していない。

原因はnetworkやGoogle responseではなく、Google JWKS verifierだけが[ADR 0016](./adr/0016-use-manual-redirects-in-workers.md)に
反して`redirect: "error"`を指定していたことだった。live Workers runtimeはこの値をrequest構築時に`TypeError`で拒否するため、
retryしても通信は開始されない。外向きfetchを`redirect: "manual"`へ統一し、3xxを追従せず既存の
`JWKS_RESPONSE_REJECTED`へfail closedにする。unit testとworkerd integrationは実`Request`を構築して`manual`を固定し、
redirect responseの拒否も維持する。

preflightではGPU、R2、controller attestation、bootstrap/session eventを使用しなかった。終了後はWorker routeを404、
controller authorizationを0へ戻し、Cloud Run Job/Execution 0、D1 exact target 5系統0、Firestore controller collection
3件空を確認した。Service generation 16、IAM/Secret/TTLも再read-backし、local synthetic inputを削除した。productionと
CI workflowは変更していない。このsource修正によりcandidate `11cabe1`のevidenceは無効であり、次はlocal gateをまとめて
完了した単一commitからcandidateを1回buildする。

## Remaining real staging gate

release candidateのPhase境界に従うbranch/commitを作り、次を順番に完了する。

- manual redirect修正と3-attempt bounded JWKS retryを含むversion-pinned `release/0.2.0` commitの全gateと新candidate build
- 最終candidateのcontroller/worker attestation各1件、Binary Authorization `VERIFIED`、Service digest差し替え
- staging D1 migration、相異なるruntime/controller HMAC secret、shadow mode/service injectionのstrict read-back
- finite controller authorizationとD1/R2 synthetic fixtureを同じexecution handleへ固定したsynthetic execution最大1件
- timeout/response loss/hard lifetime/reaper、artifact/manifest、resource/storage不存在、課金終了の期限付きevidence

GPU execution直前までsource defaultとdeployed staging bindingを`disabled`へ保ち、strict preflight後だけ
`synthetic-shadow`へ切り替える。productionへmode、secret、routeを設定しない。
