# 継続的インテグレーション

## 対象

`.github/workflows/ci.yml` は `main` と `develop` への push と pull requestで動作する。
CIは外部サービスのcredentialを受け取らず、実際のCloudflareやRunPod resourceには
接続しない。release branchでは同内容の手動CIをcandidate workflowの直前に重ねず、
candidate自身のcomplete gateを使用する。release-to-main PRはcandidateとstaging
acceptanceが成功するまでclosedに保ち、成功後に同じPRをreopenして最終CIを一度だけ
実行する。

同じ branch と workflow の古い実行は concurrency 設定で取り消し、全 job に timeout を設定する。workflow 全体の `GITHUB_TOKEN` 権限は `contents: read` のみに制限する。

## Job

| Job                | 検査内容                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`          | lockfile固定install、toolchain、format、lint、型検査、Vitest、pytest、build、local D1 migration、Web/OrchestratorのWorkers/D1/R2 integration                              |
| `secrets`          | Gitleaks による完全な Git 履歴と現在の checkout の検査                                                                                                                    |
| `dependency-audit` | `pnpm audit` と `uv audit` による直接・推移依存の既知脆弱性検査                                                                                                           |
| `browser-e2e`      | 固定Playwright/Chromiumとmock API/R2によるupload、poll、download、delete、mobile、PWA cache検査                                                                           |
| `runpod-container` | 固定digest/snapshotからの実image buildまたは検証済み不変digestの再利用、非root・networkなし・read-only起動、model全hash、SPDX JSON SBOM、High/Critical vulnerability scan |

`pnpm audit` と `uv audit` は脆弱性データサービスへ接続するため、通常の `pnpm check` とは分離する。ローカルで CI 相当を確認するときは次を実行する。

```bash
pnpm check
pnpm playwright:install
pnpm test:e2e
pnpm ci:verify
pnpm secrets:check
pnpm audit --audit-level high
uv audit --preview-features audit-command --project apps/runpod-worker --frozen
pnpm container:build:runpod
pnpm container:check:runpod
```

release candidateまたはstaging promotionをdispatchする前に、
[ADR 0042](./adr/0042-preflight-pages-upload-permission.md)の同じgateをlocal credentialで
実行する。production releaseでは、時間のかかるcandidateを開始する前にGitHub側の
promotion入口とEnvironmentも検証する。

candidate workflowのpreflightはPages権限の確認後、checksum固定`runpodctl`を導入し、
GPU inventoryが[ADR 0050](./adr/0050-treat-runpod-stock-as-a-signal.md)の
Secure Cloud提供候補属性を満たすことと、REST endpoint/templateのreadinessを確認する。
瞬間的なavailable/stockはGPU処理を行わないcandidate publicationの合否に使わない。
このgateより前にcandidate artifactのdownload、build、container scanを開始しない。

```bash
pnpm cloudflare:pages:upload-permission:verify:staging
pnpm github:controls:verify:production
```

Pages projectの一覧取得だけではdeploy権限の証拠にならない。`GET /upload-token`の成功を
対象accountのCloudflare Pages Editだけを持つ専用`CLOUDFLARE_PAGES_API_TOKEN`で確認し、
返された短期capabilityは保持または表示しない。release-candidate preflightではreusable
candidate downloadとRunPod readinessより前、staging preflightではcandidate download、
RunPod CLI、D1より前に同じ検査を実行する。stagingのPages secret、project、deployment、
config hashのread-backも同じ専用tokenを使い、一般Cloudflare tokenへPages権限を要求しない。
Cloudflare資格情報の全役割とexact permissionは
[cloudflare-permissions.md](./cloudflare-permissions.md)を正とする。
`pnpm ci:verify`は機械可読policyも検証し、Backend/Access tokenの完成形8権限からの欠落、
exact application zone以外のscope、未reviewの権限追加を拒否する。

PlaywrightのOS共有libraryは公式の`playwright install --with-deps chromium`で準備する。
`sudo`を利用できないmanaged hostでは管理者に依頼し、CIはephemeral runnerへだけ導入する。
E2EのAPI、R2 multipart、artifact downloadは予約済みdummy値のbrowser routeで置換し、
Cloudflare、RunPod、Discordや実録音へ接続しない。traceは失敗時だけlocal/CI一時領域へ
残し、追跡対象や長期artifactへ保存しない。

## Phase 6 deterministic failures

Phase 6の障害試験は通常の`quality` jobに含める。実Cloudflare、RunPod、Discordへ接続せず、
固定clock/ID、型付きfake、Miniflare D1/R2、実migration、Pythonの固定httpx transportを
使う。`@scribe-drop/test-support`の予定障害が実行されなかった場合や、job、attempt、
submission、event、outboxの件数が一致しない場合はtestを失敗させる。

構造化logはJSON envelopeをparseし、scenario固有のtoken、署名query、object key、ETag、
本文fixtureの断片がないことを自動検査する。詳細なscenario対応表と回復区分は
[failure-injection.md](./failure-injection.md)を正とする。

## Supply chain

- third-party Action は release tag だけでなく full commit SHA に固定し、隣のコメントに対応する tag を残す。
- `pnpm ci:verify` は workflow 内の `uses:` を検査し、floating reference の混入を拒否する。
- Action の更新時は公式 release と tag の commit を確認し、workflow 内の全参照を同じ PR で更新する。
- Gitleaks と runpodctl は `tools/versions.json` の version と公式 SHA-256 に固定し、検証後の binary だけを `.tools/bin` へ導入する。
- JavaScript と Python の install はそれぞれ `pnpm-lock.yaml` と `uv.lock` を frozen mode で使用する。
- RunPod WorkerはDockerfile frontend、uv image、CUDA/cuDNN baseをamd64 manifest digestで固定し、Ubuntu package sourceを固定snapshotだけへ切り替える。PythonとFFmpegの直接package version、Syft/Trivyと各Action commitも`tools/versions.json`とworkflowへ固定する。
- SBOMはSyft 1.49.0でSPDX JSONを生成し、Trivy 0.72.0はOSとlibraryのHigh/Critical findingで失敗する。unfixed findingも無視しない。例外が必要な場合は期限と除去条件を持つADRを先に追加する。
- supply-chain artifactの保持は14日とし、credential、URL、録音、文字起こしfixtureを含めない。

固定model入りimageとscannerの一時rootfsには大きな容量が必要である。専用CI jobは
一時GitHub runnerから、このjobで使わないAndroid、.NET、Haskell、CodeQL toolchainの
固定directoryだけを削除し、25 GiB以上の空きを確認してからbuildする。この条件を
満たせない場合はscanを開始せず失敗する。localでは十分な空き容量を確認してからscanし、
空き容量不足をscan成功として扱わない。

`Publish RunPod release candidate` workflowは、RunPod Worker inputsが変わった
`release/<version>` commitではimageを一度だけbuildする。変更されていない場合に限り、
[ADR 0038](./adr/0038-reuse-unchanged-runpod-worker-image.md)の検証を通った過去の固定digestを
再利用できる。environment選択とproduction用再buildは持たない。RunPod imageはどちらの
経路でも現在runのoffline check、SBOM、High/Critical scanを通す。新規buildはGitHubの
短期`GITHUB_TOKEN`でGHCRへpushする。mutable tagをpromotion入力にせずregistry digestを
candidate evidenceへ保存する。push用tagはcommit、workflow run、attempt固有とし、
失敗attemptのtagを再実行で上書きしない。package visibilityを暗黙に変更しない。

このworkflowは[ADR 0034](./adr/0034-fail-before-release-candidate-cost.md)に従い、最初の
jobだけをstaging Environmentへ限定し、RunPod API keyとendpoint IDによるread-only
template listとendpoint getを並列実行する。remote readは最大約48秒で打ち切り、成功する
までapplication build、browser install、container build、scanを開始しない。build、
test、publish jobはstaging/production credentialとdeploy権限を持たず、RunPodや
Cloudflareのmutationも行わない。candidateはWeb asset、compiled Pages Functions、compiled Orchestrator、
migration、RunPod image、acceptance用synthetic M4A、supply-chain reportを含み、
manifestが各directoryのpath、byte数、file数、SHA-256を固定する。
compiled Orchestratorは[ADR 0027](./adr/0027-store-raw-orchestrator-module.md)に従い、
固定Wranglerのworkspace基準の絶対`--outdir`が生成するraw ES moduleだけを含める。
candidate作成時と検証時にmultipart upload bodyを拒否し、stagingとproductionは同じ
moduleを再buildせずdeployする。

[ADR 0028](./adr/0028-fail-fast-before-runpod-image-build.md)に従い、Web assets、Pages
Functions、Orchestratorは独立した`application` jobで一度だけbuildする。厳密なlayoutと
raw module条件を検証した短期artifactをrun/attempt固有名で保存し、`publish` jobはdownload
後に再検証してからRunPod imageのbuildとscanを開始する。`publish` jobではapplicationを
再buildしない。Pages Functions bundleの`/api/me`固有route、fallback、API middlewareと
route順もapplication artifact検証に含め、決定的なpackaging不良は高コストcontainer処理
より前に停止する。同じ検証をroot `pnpm check`のbuild直後とcandidateのcomplete quality
gateでも行う。release branchで通常CIを手動重複実行しない。

通常の1 release commitでstaging acceptanceまでに起動するworkflowはcandidate 1本と
staging 1本である。release-to-main PRをこの間にopenまたはreopenすると、その後のpushで
`pull_request.synchronize`によるPR CIが起動するため禁止する。staging acceptance成功後、
同じPRをreopenして確定commitの最終CIを1本だけ実行し、production promotion時に1本を
追加する。release branchで手動CIを先行させない。同じbranchの古いcandidate runは
concurrencyで取り消し、高コスト処理を並行させない。失敗後は安全なerror分類と失敗stepを
確認し、原因修正と対象preflightまたはlocal gateの成功を得るまで再dispatchしない。
code変更がなくcandidateが有効な場合はcandidateを再buildせず同じartifactを使い、
stagingだけを再実行する。

releaseの実行順序は次に固定する。

1. release-to-main PRがclosedであることを確認する。
2. candidate workflowを実行し、先頭readinessと全gateを通す。
3. 同じcandidateをstagingへdeployし、実service acceptanceを通す。
4. 同じPRをreopenし、以後release commitを変更せず最終PR CIを一度だけ通す。
5. production promotionを実行する。変更が必要ならPRをcloseして手順1へ戻る。

## Staging promotion gate

candidate manifestにはcommit SHA、RunPod image digest、Web、Pages Functions、
Orchestrator bundle、migration集合のSHA-256とconfig policy versionを含める。secret、
実origin、resource ID、署名URL、利用者dataは含めない。

staging workflowはcandidateだけを入力に取り、deploy後に実resourceをread-backしてから、
固定dummy mediaを実R2、Queue、RunPodへ通すE2Eを実行する。変更がOSやbrowser固有の
file picker、PWA、offline動作へ及ぶ場合は、対象実機smokeの承認もcandidateへ結び付ける。
candidate directoryは全promotion jobで`${{ github.workspace }}/release-candidate`の絶対pathに
固定し、package managerがsub-packageへworking directoryを変更しても相対pathとして再解釈
させない。`preflight`はcandidate検証直後に実M4A fixtureをacceptanceと同じreaderかつ
`apps/e2e` working directoryから読み、metadata、media contract、非空payloadを確認する。
このfixture preflightが成功するまでD1、Pages、R2、RunPod、Workerを変更しない。
`Deploy release candidate to staging`はcandidate workflow runのrepository、workflow path、
release branch、commit、成功statusをGitHub APIで照合する。applicationを再buildせず、
compiled bundleを`--no-bundle`でdeployする。R2 notification、Queue producer/consumer、
DLQ/retry、CORS、lifecycle、D1 migration、PagesのGit provider無効、active Worker versionと
binding、RunPod endpointをread-backする。Pagesはdeploy済みproduction
`wrangler_config_hash`と生成した追跡外configのSHA-256も照合する。Access service tokenの
claimと認証済み`GET /api/me`をupload前に検証し、実M4A、manifest-last、3成果物download、
削除受付を確認する。続いて音声を含まない合成破損M4Aを同じ経路へ投入し、exact
`FAILED`、現在versionのoutbox `SENT`、job/outbox送信時刻を固定Wranglerで確認する。
failure job IDはmode `0600`のrunner一時fileだけで受け渡し、実配送確認後に同じAccess
service principalで削除する。両fixture削除とscale-to-zero復元が成功した後だけ、
schema version 3の24時間有効なacceptance artifactを発行する。
`runner.*` contextはstep評価時だけ使用し、job-level `env`、`if`、strategyなどstepより
前のfieldでは参照しない。`pnpm ci:verify`は全workflowの各jobを静的検査し、この誤配置を
GitHubへのdispatch前に拒否する。複数stepで同じrunner一時fileを使う場合も、pathを各stepの
`env`へ明示してjob scopeへ持ち上げない。
acceptanceには実IDやoriginを含めず、retention、R2 policy、RunPod GPU・配置・runtime
invariantをenvironment markerで正規化したpolicy hashを含める。
[ADR 0043](./adr/0043-bound-runpod-start-slo-and-staging-wait.md)に従い、実E2Eは
RunPod winner claimを最大10分だけ待つ。FAILED、CANCELLED、EXPIRED、
SOURCE_MUTATEDは即時失敗とし、COMPLETEDだけを長時間待たない。synthetic jobは
成功・失敗にかかわらずexact job IDで削除を要求する。GPU開始SLOを満たさないrunを
自動retryせず、原因と供給状況を確認するまで次のworkflowを起動しない。
[ADR 0051](./adr/0051-prewarm-staging-before-job-creation.md)に従い、upload前に
`workersMin=1`を一時設定し、candidate template/imageのWorkerとhealth readinessを最大8分
だけ待つ。provider queue/in-progress/runningは0、idleまたはready Workerは1件以上を
必須とする。成功jobのWorker refresh後、失敗fixture前にも同じprewarmを再実行する。
idleにならなければsynthetic jobを作らず失敗し、prewarm内部とworkflowの
`always()` cleanupの両方で`workersMin=0`をexact read-backする。candidate Workerの
post-lifecycle evidenceとscale-to-zero復元が成功した後だけacceptanceを発行する。
[ADR 0059](./adr/0059-require-real-staging-failure-notification-acceptance.md)のfailure
notification確認またはfixture cleanupが失敗した場合も、`always()` cleanupで
failure fixture削除とscale-to-zeroを試みる。remote D1 read-backは固定Wranglerの
`--command --json`を引数配列で実行し、D1 ingestion用`--file`を使用しない。実録音、
job ID、SQL、query結果をartifactへ保存しない。
[ADR 0055](./adr/0055-separate-worker-evidence-from-idle-promotion-preflight.md)に従い、
post-lifecycle evidenceはpromotion前のidle-only preflightを再利用しない。専用のread-only
verifierがcandidate template/image、`RUNNING`・`EXITED`・`TERMINATED`だけのstatus、
最大1件のactive Worker、endpoint invariant、GPU/data center/complianceの完全一致を
確認する。通常preflightは`RUNNING`と未知statusを引き続き拒否する。専用verifierの成否に
かかわらずcleanupを実行し、失敗時はacceptanceを発行しない。
Access service tokenは[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)に
従い、browser requestをhopごとにinterceptする。exact application originだけへ外側用
標準2 headerと内側用JSON `Authorization`を同時送信する。routeはexact application
originだけに登録し、callback内でもoriginを再検証する。最初のnavigationで
`CF_Authorization` cookieとservice principal claimを確認した後も、二重Accessの内側が
要求するJSON `Authorization`を含む3 headerをexact application originへ継続する。
routeはcleanup完了後に新規callback受付を止め、進行中handlerを待ってからbrowser contextを
閉じる。途中で解除してcookie-onlyへ切り替えず、contextを先に閉じて保留中handlerを
失敗させない。route errorはrequest headerを含み得るため、raw errorを再throwまたはlogしない。
redirectはbrowserへ返して次requestを新たに評価させる。R2、Access team domain、
artifact download先、その他のcross-origin requestはadapterを通さず、browserが生成した
headerを変更しない。`route.fetch()`が同一origin mutationの`Sec-Fetch-Site`を
欠落させた場合は、unsafe method、exact `Origin`一致、header欠落の条件下だけ
`same-origin`を補完する。
最初のnavigationが2xxかつexact application originであることと、application cookieの
service principal claimを検証する。
`/api/me?candidate=<commit>`はそのoriginから構築した絶対URLへ送り、Access team domain上の
相対URLをdata-plane応答として受け入れない。
[ADR 0040](./adr/0040-verify-staging-service-auth-before-mutation.md)に従い、`preflight`は
dependency install直後に2 Access application、相異なるAUD、layer固有header、exact
Service Auth policyをcontrol planeからread-only検証し、同じService Tokenでroot cookieと
`GET /api/me`をdata planeから検証する。この検査はRunPod CLI install、candidate download、
browser install、D1 migrationを含むすべてのremote mutationより前に失敗する。credential
形式不正、Access login redirect、cross-origin redirect、cookie principal不一致、API拒否は
補正せず停止し、credential、cookie、JWT、redirect URL、response本文をlogへ出さない。
staging workflowは[ADR 0036](./adr/0036-defer-custom-domain-readiness-to-acceptance.md)に従い、
`preflight`、`migrate`、`deploy-pages`、`deploy-backend`、`acceptance`の独立jobへ
分ける。custom domainの認証済みreadinessは`acceptance`のbrowser lifecycle先頭で確認し、
成功するまでmedia uploadとGPU jobを開始しない。readiness失敗時は同じrunのfailed
`acceptance` jobだけを再実行し、成功済みmigration、Pages、backend promotionを
再実行しない。media mutation開始後はjob作成responseを30秒以内に直接観測して201を
要求する。失敗時は秘密値や本文を出さず、machine-readable error codeとOrigin、CSRF、
Fetch Metadataの有無だけを報告する。作成成功後もupload成功表示と安全なmultipart
action分類を直ちに競合させ、R2障害を長いGPU完了timeoutまで待たない。
Pages promotionは公式APIでcommit、production branch、deploy status、`uses_functions`、
設定hashを先に照合し、exact candidateがactiveならdeployを省略する。deploy応答喪失時も
mutationを再送せず、上限付きread-backだけで結果を確定する。
Pagesは[ADR 0029](./adr/0029-discover-pages-config-from-app-root.md)に従い、app rootから
追跡外config redirectを検出する。最初のremote mutationより前に同じ`--cwd`とprojectで
read-only deployment listを取得し、config discoveryまたは認証に失敗した場合は停止する。
staging browser credentialのorigin制限は
[ADR 0030](./adr/0030-scope-access-service-credentials-to-app-origin.md)を正とする。
[ADR 0033](./adr/0033-wait-for-pages-data-plane-convergence.md)と、それを一部更新する
[ADR 0036](./adr/0036-defer-custom-domain-readiness-to-acceptance.md)に従い、全read-only
control-plane preflightをremote mutation前に完了する。Pages promotionはcompiled routeと
公式APIのexact read-backで確定する。認証済み`/api/me?candidate=<commit>`はbackend
promotion後のacceptance先頭で上限付きにpollし、custom domainのdata-planeと固定E2E
identityが収束してからmedia lifecycleへ進む。
RunPod promotionは[ADR 0031](./adr/0031-retry-only-runpod-read-commands.md)と
[ADR 0034](./adr/0034-fail-before-release-candidate-cost.md)に従い、template listを
公式REST API、ほかのread-only CLIを上限付きで再試行し、結果不明のmutationを自動再送
しない。candidate workflowの最初にもread-only readinessを実行し、release全体で
高コスト処理より前にcontrol-plane障害を検知する。
stagingとproductionの両workflowは最初のremote mutationより前にRunPod preflightも
実行する。providerが追加する既知の二つのtemplate portだけは
[ADR 0032](./adr/0032-automate-runpod-default-port-normalization.md)の安全条件下で
1回だけ自動除去し、厳格なread-back後にpromotionする。
productionは[ADR 0056](./adr/0056-require-production-capacity-before-promotion.md)と
[ADR 0057](./adr/0057-split-runpod-capacity-mutations.md)に従い、
GPU、data center、complianceが固定planへ完全一致した場合だけpreflightを成功させる。
`capacity update pending`をproductionの成功条件にせず、capacity移行をD1、R2、
candidate promotionと同じworkflow内で初めて試さない。GraphQLのdata center更新とRESTの
GPU更新を分離し、各mutationを1回だけ送る。各段階は最大30秒のbounded read-backだけを行い、
事前移行が失敗または未実施ならworkflowをdispatchしない。事前移行はWorker上限0の
read-back後、terminal Worker履歴ではなくhealthのidle/initializing/ready/runningが
すべて0へ収束したことを最初のcapacity mutation前に検証する。

promotion workflowをdispatchする前に、少なくとも`pnpm check`、`pnpm test:e2e`、
`pnpm secrets:check`、`pnpm security:audit`をlocalで成功させる。変更対象に応じた専用testと
`pnpm ci:verify`も先に通す。local gateが未完了または失敗している間は、検証目的でremote
workflowを起動しない。

production workflowはGitHubのproduction Environmentだけにcredentialを持ち、次をすべて
満たす場合に限り同じcandidateをdeployする。

- staging acceptanceが成功し、取消しまたは期限切れでない
- commitと全artifact digestがcandidate manifestに一致する
- acceptance後にcode、dependency、migration、deployment設定が変更されていない
- 正規化したstaging/production構成の差分がenvironment固有allowlist内だけである
- protected branchとrequired reviewerの条件を満たす

environment policyはR2 CORSのexact originと環境固有rule IDを検証してから両方をmarkerへ
正規化する。fixtureからrule IDを省略して見かけ上hashが一致するtestを禁止し、別environment
のrule ID、retention、GPU、location、runtime driftをそれぞれ回帰testで拒否する。

production workflowはbuild stepと任意image引数を持たない。通常のlocal環境とstaging
workflowへproduction credentialを渡さない。break-glassはADR 0023の記録と明示承認を
満たす別経路とし、通常workflowの条件を一時的に緩めない。
production Pagesのupload capability、secret名、deployment list、deploy、config hash
read-backはproduction専用`CLOUDFLARE_PAGES_API_TOKEN`だけを使う。一般
`CLOUDFLARE_API_TOKEN`は
[Cloudflare権限表](./cloudflare-permissions.md)のBackend CI権限だけに限定し、
Pages権限不足をbackend mutation後まで遅延させない。
production controls verifierはGitHub APIから値ではなく設定名だけを抽出し、default branch
`develop`上のproduction workflow、required reviewer、custom `release/*` branch policy、
review済み15変数と4 secretのexact setを要求する。production workflowをrelease branchだけ
へ初めて追加した状態ではdispatchが成立しないため、同じpathをrelease freeze前にfeature PR
で`develop`へ登録する。登録漏れやEnvironment未設定をremote workflowの404または長時間
処理の後で発見しない。

candidate workflowは[ADR 0038](./adr/0038-reuse-unchanged-runpod-worker-image.md)に従い、
同じrelease branchの成功済みcandidate run IDを明示した場合だけ、変更されていないRunPod
Worker digestを再利用できる。任意image referenceは入力に取らない。source runと完全な
candidate artifactを検証し、source commitが現在commitの祖先であり、`.dockerignore`、
`apps/runpod-worker/`、`tools/versions.json`に差分がないことをremote build前に要求する。
再利用時も現在runでdigestをpullし、offline container check、synthetic M4A、SBOM、
High/Critical scanを実行する。source identityと現在runの再検査はcandidateのsupply-chain
provenanceへ記録する。

`Promote staging-accepted candidate to production`はproduction Environment承認前のjobで
staging runとcandidate runを検証し、承認後のjobでもartifactを再downloadして全検証を
繰り返す。production設定から同じ正規化policy hashを再計算し、最初のD1/R2/RunPod/
Cloudflare mutationより前にstaging evidenceとの一致を要求する。evidenceが承認待ち中に
期限切れになった場合、またはproduction job上限25分に対して30分未満しか残っていない
場合はdeployしない。legacyの
`pnpm runpod:deploy:production`は引き続き常に失敗し、証跡を内部検証するpromotion script
だけをproduction workflowから使用する。

## Branch protection

`main`と`develop`への直接pushを禁止し、`Quality gate`、`Secret scan`、
`Dependency audit`、`Browser E2E`、`RunPod container supply chain`の5件をstrictな
required status checkに設定する。承認1名、stale review破棄、最新push以外の承認拒否、
conversation解決を要求し、管理者にも適用する。force-pushとbranch削除は禁止する。

現行`release/<version>`はrelease修正を直接積めるGit-flowを維持するためPRとstatus checkを
必須にしない。一方で管理者を含むforce-pushとbranch削除は禁止する。production deployは
production Environmentのrequired reviewerとcustom `release/*` policyで別途保護する。
`pnpm github:controls:verify:production`は、3 branchのこの非対称な設定も値を表示せず
read-backし、欠落や緩和があればcandidate開始前に失敗する。

production Environmentにはrequired reviewerとrelease branch制限を設定する。
candidate publication、staging acceptance、production promotionを別のGitHub Deployment
として記録し、production jobは対応するstaging成功statusをAPIで照合する。
staging Environmentにはstaging専用credentialだけを置く。Cloudflare Pages projectは
Git providerを`No`にし、pushによる自動build/deployでcandidate gateを迂回できない状態を
各promotionのread-backで検証する。

private repositoryでこれらを利用できないGitHub planの場合は
[ADR 0025](./adr/0025-require-supported-github-deployment-protection.md)に従い、
repository secretやworkflow inputで代替しない。staging Environmentを利用できず
read-only readiness credentialを分離できない場合は、candidate publicationを含むrelease
workflowを停止する。
