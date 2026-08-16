# ADR 0089: production workflow identityとcandidate identityを分離する

- Status: Accepted
- Date: 2026-08-16
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0086、ADR 0088

## Context

Phase 16ではimmutable candidateのbuild後にstaging/production gateの修正が必要になり、release branchの
workflow commitがcandidate commitより先へ進んだ。stagingはcandidate commitを明示入力として扱える一方、
production workflowは`GITHUB_SHA`をcandidate artifact名、deployment label、RunPod acceptance、cutover/release
evidenceへ使用していた。そのため有効なstaging acceptanceがあっても、production verifyのartifact downloadで
必ず停止し、後続で同じ誤ったidentityを繰り返す構造だった。

また、productionのfoundation/provider preflightと最初のmigration/deployが同じjobにあり、外形的な全前提の
成功を確認してからmutationを承認する境界がなかった。

## Decision

- production workflowは必須の`candidate_commit_sha`を受け取る。40桁commit以外を最初のlocal input gateで拒否し、
  staging acceptance、application/Cloud Run candidate、deployment label、authorization epoch、cutover/release evidenceの
  identityにはこの値だけを使う。
- `GITHUB_SHA`はsource-controlled workflow commitとして、staging workflow runとcutover workflow runの信頼検証に
  だけ使う。candidate commitへ代用せず、用途の出現数をstatic gateで固定する。
- RunPod production promotionと3種のacceptance/evidence CLIは`EXPECTED_COMMIT_SHA`だけをcandidate identityとして
  使用する。workflow commitを読む実装をstatic gateで拒否する。
- staging acceptanceからexportするcandidate run IDは`GITHUB_ENV`のstep間契約として扱う。exportした同じstepでは
  candidate downloadに使用せず、次の独立stepだけで参照する。この境界をcutover/finalizeの両方でstatic検査する。
- `preflight_only=true`のproduction cutover modeを追加する。このmodeはstaging evidence、両candidate、production
  foundation、controller validate-only、Cloudflare credential/resource、Pages、Access、RunPodを実環境で検証する。
- preflight modeではmigration、R2 policy、RunPod promotion、controller apply、Worker/Pages deploy、drain、provider
  selection、GPU authorization、evidence発行の9 stepをworkflow conditionでskipする。各stepのconditionをstatic
  verifierで固定する。
- mutating cutoverは同じworkflow commitとstaging runに結び付いた成功preflight run IDを必須入力とする。source runの
  exact workflow/repository/branch/commit/title、初回attempt、artifact検証step、全external preflight stepの成功、9 mutation
  stepとfinalize jobのskipをGitHub API read-backから検証してから進む。
- finalizeはcutover evidenceへ結び付くためpreflight run IDを受け取らず、`0`だけを許可する。

## Consequences

- workflow gateを修正してもimmutable application candidateを再buildせず、candidateとworkflowの両identityを監査できる。
- production mutationの前に、同じsourceとcredentialで全remote prerequisiteを独立runとして完了できる。mutating cutoverを
  preflightなしで直接dispatchしても最初のverification jobで停止する。
- production workflow変更後のstaging evidenceはADR 0088のGPU-free full live read-backで更新し、変更後workflow commitへ
  結び直す。実M4AやGPU executionは繰り返さない。
