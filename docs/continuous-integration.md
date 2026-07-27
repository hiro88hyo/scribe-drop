# 継続的インテグレーション

## 対象

`.github/workflows/ci.yml` は `main` と `develop` への push と pull request、および手動実行で動作する。CI は外部サービスの credential を受け取らず、実際の Cloudflare や RunPod resource には接続しない。

同じ branch と workflow の古い実行は concurrency 設定で取り消し、全 job に timeout を設定する。workflow 全体の `GITHUB_TOKEN` 権限は `contents: read` のみに制限する。

## Job

| Job                | 検査内容                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`          | lockfile固定install、toolchain、format、lint、型検査、Vitest、pytest、build、local D1 migration、Web/OrchestratorのWorkers/D1/R2 integration |
| `secrets`          | Gitleaks による完全な Git 履歴と現在の checkout の検査                                                                                       |
| `dependency-audit` | `pnpm audit` と `uv audit` による直接・推移依存の既知脆弱性検査                                                                              |
| `browser-e2e`      | 固定Playwright/Chromiumとmock API/R2によるupload、poll、download、delete、mobile、PWA cache検査                                              |
| `runpod-container` | 固定digest/snapshotからの実image build、非root・networkなし・read-only起動、model全hash、SPDX JSON SBOM、High/Critical vulnerability scan    |

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

`Publish RunPod release candidate` workflowは`release/<version>`の単一commitからRunPod
imageを一度だけbuildする。environment選択とproduction用再buildは持たない。RunPod imageは
CIと同じoffline check、SBOM、High/Critical scanを通し、GitHubの短期`GITHUB_TOKEN`で
GHCRへpushする。mutable tagをpromotion入力にせずregistry digestをcandidate evidenceへ
保存する。push用tagはcommit、workflow run、attempt固有とし、失敗attemptのtagを再実行で
上書きしない。package visibilityを暗黙に変更しない。

このworkflowはcandidate publicationだけを行い、staging/production credentialとdeploy
権限を持たない。candidateはWeb asset、compiled Pages Functions、compiled Orchestrator、
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
再buildしないため、決定的なpackaging不良は高コストcontainer処理より前に停止する。

## Staging promotion gate

candidate manifestにはcommit SHA、RunPod image digest、Web、Pages Functions、
Orchestrator bundle、migration集合のSHA-256とconfig policy versionを含める。secret、
実origin、resource ID、署名URL、利用者dataは含めない。

staging workflowはcandidateだけを入力に取り、deploy後に実resourceをread-backしてから、
固定dummy mediaを実R2、Queue、RunPodへ通すE2Eを実行する。変更がOSやbrowser固有の
file picker、PWA、offline動作へ及ぶ場合は、対象実機smokeの承認もcandidateへ結び付ける。
`Deploy release candidate to staging`はcandidate workflow runのrepository、workflow path、
release branch、commit、成功statusをGitHub APIで照合する。applicationを再buildせず、
compiled bundleを`--no-bundle`でdeployする。R2 notification、Queue producer/consumer、
DLQ/retry、CORS、lifecycle、D1 migration、PagesのGit provider無効、active Worker versionと
binding、RunPod endpointをread-backする。Pagesはdeploy済みproduction
`wrangler_config_hash`と生成した追跡外configのSHA-256も照合する。Access service tokenの
claimと認証済み`GET /api/me`をupload前に検証し、実M4A、manifest-last、3成果物download、
削除受付が成功した後だけ24時間有効なacceptance artifactを発行する。
acceptanceには実IDやoriginを含めず、retention、R2 policy、RunPod GPU・配置・runtime
invariantをenvironment markerで正規化したpolicy hashを含める。
Pagesは[ADR 0029](./adr/0029-discover-pages-config-from-app-root.md)に従い、app rootから
追跡外config redirectを検出する。最初のremote mutationより前に同じ`--cwd`とprojectで
read-only deployment listを取得し、config discoveryまたは認証に失敗した場合は停止する。
staging browser credentialのorigin制限は
[ADR 0030](./adr/0030-scope-access-service-credentials-to-app-origin.md)を正とする。
[ADR 0033](./adr/0033-wait-for-pages-data-plane-convergence.md)に従い、control-plane
read-back後は認証済み`/api/me`の上限付きpollでcustom domainのdata-plane収束を確認し、
固定E2E identityへ一致してからmedia uploadを開始する。
RunPod promotionは[ADR 0031](./adr/0031-retry-only-runpod-read-commands.md)に従い、
read-only CLIだけを上限付きで再試行し、結果不明のmutationを自動再送しない。
stagingとproductionの両workflowは最初のremote mutationより前にRunPod preflightも
実行する。providerが追加する既知の二つのtemplate portだけは
[ADR 0032](./adr/0032-automate-runpod-default-port-normalization.md)の安全条件下で
1回だけ自動除去し、厳格なread-back後にpromotionする。

production workflowはGitHubのproduction Environmentだけにcredentialを持ち、次をすべて
満たす場合に限り同じcandidateをdeployする。

- staging acceptanceが成功し、取消しまたは期限切れでない
- commitと全artifact digestがcandidate manifestに一致する
- acceptance後にcode、dependency、migration、deployment設定が変更されていない
- 正規化したstaging/production構成の差分がenvironment固有allowlist内だけである
- protected branchとrequired reviewerの条件を満たす

production workflowはbuild stepと任意image引数を持たない。通常のlocal環境とstaging
workflowへproduction credentialを渡さない。break-glassはADR 0023の記録と明示承認を
満たす別経路とし、通常workflowの条件を一時的に緩めない。

`Promote staging-accepted candidate to production`はproduction Environment承認前のjobで
staging runとcandidate runを検証し、承認後のjobでもartifactを再downloadして全検証を
繰り返す。production設定から同じ正規化policy hashを再計算し、最初のD1/R2/RunPod/
Cloudflare mutationより前にstaging evidenceとの一致を要求する。evidenceが承認待ち中に
期限切れになった場合、またはproduction job上限25分に対して30分未満しか残っていない
場合はdeployしない。legacyの
`pnpm runpod:deploy:production`は引き続き常に失敗し、証跡を内部検証するpromotion script
だけをproduction workflowから使用する。

## Branch protection

GitHub repository 作成後、`main` と `develop` への直接 push を禁止し、少なくとも
`Quality gate`、`Secret scan`、`Dependency audit`、`RunPod container supply chain`を
required status checkに設定する。これはrepository側の設定であり、ローカル基盤作成では
変更しない。

production Environmentにはrequired reviewerとrelease branch制限を設定する。
candidate publication、staging acceptance、production promotionを別のGitHub Deployment
として記録し、production jobは対応するstaging成功statusをAPIで照合する。
staging Environmentにはstaging専用credentialだけを置く。Cloudflare Pages projectは
Git providerを`No`にし、pushによる自動build/deployでcandidate gateを迂回できない状態を
各promotionのread-backで検証する。

private repositoryでこれらを利用できないGitHub planの場合は
[ADR 0025](./adr/0025-require-supported-github-deployment-protection.md)に従い、
repository secretやworkflow inputで代替しない。credentialを持たないcandidate publication
だけを許可し、staging/production promotionは停止する。
