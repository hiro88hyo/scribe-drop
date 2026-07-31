# ADR 0038: 変更されていないRunPod Worker imageを再利用して再検査する

## Context

release candidate workflowはcommitごとにRunPod Worker imageを無条件にbuildしていた。
Web、E2E、文書だけの変更でも、固定済みmodel snapshotをHugging Faceから再取得して
containerを再構築する。その結果、Worker build inputsに差分がないcandidateでmodel Hubの
rate limitによる429が発生し、application、quality、browser、security gateがすべて成功
した後にcandidate publicationだけが失敗した。

[ADR 0023](./0023-promote-only-staging-verified-artifacts.md)はproductionでの再buildを禁止し、
candidateが固定RunPod image digestを持つことを要求する。一方、内容が変わらない
content-addressed imageをrelease branchの各commitで再構築することまでは、candidateの
同一性やstaging検証に必要ない。任意のimage referenceをworkflow inputとして受け入れると
build、scan、source identityを迂回できるため許可できない。

## Decision

- candidate workflowは任意のimage referenceを入力に取らない。任意指定できるのは、同じ
  official candidate workflowで成功した過去のrun IDだけとする。
- 再利用元runについて、GitHub APIとartifactを使い、run ID、repository、workflow path、
  `workflow_dispatch` event、成功status、同じrelease branchを検証する。
- 再利用元commitは現在commitの祖先でなければならない。
- `.dockerignore`、`apps/runpod-worker/`、`tools/versions.json`のいずれかに差分があれば
  再利用を拒否し、新しいimage buildを必須とする。この集合はDocker build context、
  Dockerfile、Python lock、Worker source、model/base image pin、SBOM・scan tool policyを
  含む。
- 再利用元の完全なcandidate artifactをhash検証し、そのmanifestに含まれるGHCR digest
  referenceだけを抽出する。tagやworkflow input由来のimage referenceは受け入れない。
- 現在runはそのdigestをGHCRからpullし、non-root・networkなし・read-only container check、
  synthetic M4A生成、SBOM生成、High/Critical Trivy scanを改めて実行する。過去のscan結果を
  現在runの代わりにしない。
- 現在candidateのsupply-chain artifactへ、build/reuse mode、current candidate identity、
  Worker source candidate identity、image digest、現在runでの再検査項目を記録する。
- 再利用条件、artifact検証、GHCR digest確認、現在runのcontainer checkまたはscanの
  いずれかが失敗した場合はfail closedとし、自動的に別imageやmutable tagへfallbackしない。
- 再利用元を指定しない場合、またはWorker inputsが変更された場合は、従来どおり現在commit
  から一度だけbuildして固定digestを発行する。

この決定はADR 0023の「単一candidateから一度だけbuildする」を、変更されていない
content-addressed Worker artifactについて「以前一度buildされた検証可能なdigestを再利用
できる」と明確化する。現在candidate全体は現在commitへ結び付き、再利用したdigestを含めて
改めてstaging acceptanceを通過しなければproductionへ進めない。

## Consequences

- Webやdeployment toolingだけの修正でmodelを再downloadせず、外部rate limitと長時間buildを
  回避できる。
- 新しく発見された脆弱性は現在runのscanで検出されるため、過去のclean結果だけで通過しない。
- 過去candidate artifactとGHCR digestがretention期間内に存在する必要がある。欠落時は
  再利用せず停止し、明示的に新規buildを選択する。
- Worker source、lock、Dockerfile、model pin、scan policyが変わったcandidateは必ず新規
  buildとなる。
- candidate provenanceから、application commitとWorker imageを最初にbuildしたsource runを
  区別できる。

## Status

Accepted

## References

- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
- [Continuous integration](../continuous-integration.md)
- [Deployment](../deployment.md)
