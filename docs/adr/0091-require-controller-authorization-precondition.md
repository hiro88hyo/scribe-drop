# ADR 0091: production controller authorizationをcutover前提条件へ含める

- Status: Accepted
- Date: 2026-08-20
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0086、ADR 0088、ADR 0089

## Context

production cutover `32330064196`はexact-one smokeを開き、実Cloud Run lifecycle、artifact、cleanup、Discord配送を
成功した。処理時間が未取得だったためfinalizeを保留し、消費済みauthorizationは`reservedExecutions=1`のまま
保持された。処理時間修正candidateのproduction preflight `32338096197`は成功したが、controller preflightはCloud Run
Serviceのvalidate-only requestとdeployment read-backだけを検査し、Firestore authorizationを読まなかった。

後続cutover `32338679303`はmigration、R2 policy、RunPod image promotion後、有限authorizationを開くcontroller deployで
旧consumed smokeを検出し、`A finite authorization must start from the disabled zero state`として停止した。application deploy、
provider切替、authorization更新、GPU executionは行われていない。同じcandidate、workflow input、preflight evidenceでも、
暗黙のFirestore状態により結果が変わるため、宣言された前提条件が不完全だった。

## Decision

- `cloud-run:controller:deploy preflight <environment> disabled`はCloud Run Service validate-onlyより前にFirestore
  authorizationをread-onlyで取得し、environment、期待epoch、active/max/request-rate/reserved/cost/expiryを完全一致検査する。
  document欠落、active execution、environment不一致、budget/epoch/reservation不一致はremote mutation前に拒否する。
- production cutoverはepoch `disabled`、epoch expiry、active/max/request-rate/reserved/costの全値0だけを許可する。
  production finalizeはsource cutoverから組み立てたexact epochのexact-one smokeを、消費済みの`reservedExecutions=1`、
  `reservedWorstCaseJpy=250`だけで許可する。両者を同じ暗黙defaultで扱わない。
- 実cutoverはproduction preflight evidenceだけに依存せず、同じread-only controller preflightを再実行してから最初の
  mutationへ進む。production workflow concurrencyの外からauthorizationが変更されてもfail closedする。
- 消費済みproduction smokeのrecoveryは通常のfailed-cutover recoveryと分離する。既定ではproduction recoveryは
  unconsumed `reservedExecutions=0`だけを許可し、`SCRIBE_DROP_CLOUD_RUN_ALLOW_CONSUMED_PRODUCTION_RECOVERY=1`を
  明示した場合だけexact `recovery epoch`、environment production、active 0、reserved 1、cost 250を許可する。
- consumed recoveryの前に、source cutover runに限定したcleanup verifierでCloud Run Job/Execution 0、provider record
  `CLEANED`、active 0、reserved 1を確認する。明示承認、exact epoch、CAS write、disabled/zero read-backなしに実行しない。
- recoveryはstaging acceptanceやproduction release evidenceを発行せず、新しいGPU枠も開かない。安全状態へ戻した後、
  既に全input/preflight検証を通ったfailed cutover jobを同じrun attemptのre-run機構で再開する。
- controller preflightとrecovery guard、cutover/finalizeの期待reservation bindingをunit/static testで固定する。
- GitHubのfailed-job rerunは成功したcutoverの`head_sha`を元runのsourceへ固定する。finalizeはcutover runを同じrelease
  branch、repository、workflow pathの成功runとして検証し、cutover evidenceをcandidate commitとcutover run IDへ固定するが、
  後続のsource-only gate修正headやreplacement staging evidence IDへ書き換えない。finalizeで使う最新staging evidenceは別に
  workflow identity、candidate identity、期限、live parityを検証する。

## Consequences

- production cutoverの成否を左右するauthorization状態が明示的なpreconditionとなり、今回の失敗は最初のproduction mutation前に
  検出される。
- finalizeは消費済みexact-one以外を拒否するため、未実行smokeや別environmentの状態を終了処理へ読み替えない。
- consumed recoveryは旧smokeを成功evidenceへ昇格する経路ではない。処理時間欠落を補正せず、旧枠を安全に閉じるだけである。
- workflowとdeployment verifierのsource変更であるため、productionへ直接適用せず、GPU-free staging evidenceを更新してから
  production recoveryとcutover re-runへ進む。
- source-only gate修正後も、既に成功したcutoverの実sourceと当時のstaging evidenceは監査記録として保持される。同一candidateを
  検証したreplacement staging evidenceはfinalizeの現在gateを満たすが、過去cutoverのsource identityとは同一視しない。
