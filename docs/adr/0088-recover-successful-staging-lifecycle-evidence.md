# ADR 0088: 完了済みstaging lifecycleをGPU-free evidenceへ復旧する

- Status: Accepted
- Date: 2026-08-16
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0086、ADR 0087

## Context

Phase 16のbounded staging acceptanceでは、exact-one Cloud Run L4 authorizationの下で実M4Aの
upload、artifact、notification、利用者deleteが成功した。直後のcleanup verifierはreaperの非同期Firestore
更新を1回だけ読み、JobとExecutionの削除後も`activeExecutions=1`だった瞬間を失敗と判定した。その後の
recoveryはprovider recordを`CLEANED`、authorizationをdisabled/zero、Cloud Run Job/Executionを0へ
収束させ、RunPod baselineも復元した。

ADR 0087はfailed acceptanceからevidenceを発行せず、新commitで再実行する原則を定めた。この原則を
機械的に適用すると、既に成功して追加検証不能な同じ実lifecycleをもう一度GPUで実行する。一方、任意の
failed runを後から成功へ読み替えるとstaging promotion gateを弱める。成功済みlifecycleと単なる失敗を
外形的に区別し、providerの最終状態を独立して再検証する狭い復旧経路が必要である。

## Decision

- 通常のfailed/cancelled acceptanceは引き続きADR 0087に従い、evidenceを発行しない。
- GPU-free復旧は、明示されたsource runが初回workflow dispatch、exact release branch/repository/workflow、
  exact candidate run IDであり、preflight成功、mutation job skip、実M4A lifecycle成功、cleanup convergence
  verifierだけ失敗、後続のauthorization disable・RunPod restore・evidence発行がskipだった場合だけ許可する。
- source recoveryはreaper convergence、同run authorization disable、RunPod復元、最終safety read-backの
  各step成功を必須とする。jobの最終集約が別の生成plan欠落で失敗していても、この各stepと現在のlive stateを
  独立して再検証できる場合だけ続行する。
- source commitが現在のrelease workflow commitの祖先であること、同じimmutable application/Cloud Run
  candidateであることを検証する。candidate commitをworkflowの`GITHUB_SHA`へ読み替えない。
- 現在のlive stateはCloud Run Job/Execution 0、authorization disabled/全上限0、source runの時間範囲内に
  作成・更新されたexact-one execution record `CLEANED`、RunPod baseline、全Cloudflare resource read-backを
  必須とする。controller execution collection全体が1件であることは要求しない。bounded inventoryを取得し、source runの
  時間範囲外にある履歴recordもすべて`CLEANED`であることを要求する。paginationや100件超過はfail closedとする。
- 復旧jobはD1 migration、Pages/Worker/RunPod deploy、controller apply、実E2Eを実行しない。通常acceptance
  jobがskipされたことをjob dependencyで確認し、paid GPU executionを0に固定する。
- 合格時は現在の成功した復旧workflow run IDに結び付けた短命schema version 3 evidenceを発行する。
  productionは従来どおり、この成功runとimmutable candidateを再検証してから昇格する。
- 今後の通常acceptanceではcleanup read-backを最大20分bounded pollし、一時的な`activeExecutions=1`を
  permanent failureとしない。epoch、reserved count、cost、record identityの不一致は即時失敗とする。
- source-run shape、live provider state、resume input、GPU-free jobの禁止command、candidate commit identityを
  local unit/static testで固定する。

## Consequences

- 成功済みの実lifecycleを再課金・再実行せず、監査可能なevidenceへ復旧できる。
- 復旧はfailureの一般的な上書きではなく、限定したstep fingerprintと現在のprovider/resource状態の二重検証に
  失敗すれば閉じる。
- workflow controlと検証器の変更であり、application artifact、migration、runtime deployment設定は変更しない。
  復旧evidenceは元のimmutable candidateだけを参照する。
- 通常cleanupとGPU-free復旧は同じsource-run scoped identity規則を使用するため、過去の正常な`CLEANED` recordが
  残っていても現在runを一意に検証でき、未cleanupの履歴や同一run内の複数recordは拒否する。
