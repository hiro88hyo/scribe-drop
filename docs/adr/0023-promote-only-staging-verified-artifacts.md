# ADR 0023: Promote only staging-verified artifacts

## Context

`docs/implementation-plan.md`はstaging smoke後にproductionへ進むとしていたが、何を同一と
みなすか、どの証跡をproduction deployが検証するかを定めていなかった。
RunPod image publicationもenvironmentごとにbuildでき、stagingで検証したdigestとは別の
digestをproductionへ指定できた。browser mock E2Eが成功していても、変更対象のmediaを
実R2、Queue、RunPodへ通していない状態でproductionへ進める余地があった。

その結果、stagingの成功をproductionの根拠として扱いながら、同じrelease candidateと
実経路を検証したことを機械的に証明できなかった。文書上の確認項目だけでは、手動deploy
や別buildによる迂回を防げない。

## Decision

runtime、依存、deployment設定、migrationまたは外部service連携へ影響する変更は、同じ
release candidateがstaging acceptanceを通過するまでproductionへdeployしない。

release candidateは`release/<version>`の単一commitから一度だけbuildする。candidateには
少なくとも次の同一性を含める。

- commit SHA
- RunPod Workerのimmutable image digest
- Web assetとPages Functions bundleのSHA-256
- Orchestrator bundleのSHA-256
- migration集合のSHA-256
- environment差分を正規化するconfig policy version

stagingとproductionはD1、R2、Queue、DLQ、Access、RunPod endpoint、template、secretを
共有しない。一方、application artifact、RunPod image digest、migration集合は同じ
candidateを使用する。production用に再buildしない。

staging acceptanceはcandidateごとに行い、次を満たす。

1. stagingへcandidateをdeployし、binding、R2 notification、Queue consumerとDLQ、
   migration、RunPod endpoint invariantを実resourceからread-backする。
2. 変更範囲を通る実service E2Eを実行する。upload変更では固定dummy mediaを実R2、
   Queue、RunPodへ通し、claim、heartbeat、manifest-last、finalize、成果物downloadまで
   確認する。
3. OSやbrowser固有のfile picker、PWA、offline動作を変更した場合は、対象実機のstaging
   smokeも必須とする。
4. candidate manifestとstaging acceptance結果をCI artifactまたはGitHub Deploymentへ
   結び付ける。secret、実origin、resource ID、署名URL、録音・文字起こし内容は含めない。

production deployは任意のbranch、commit、image、local buildを入力に取らず、成功した
staging evidenceが参照するcandidateだけを受け付ける。次の場合はdeployを拒否する。

- candidateのcommitまたはいずれかのartifact digestが一致しない
- staging acceptanceが未実行、失敗、取消しまたは期限切れである
- acceptance後にcode、dependency、migration、deployment設定が変更された
- 許可したenvironment差分以外でstagingとproductionの正規化設定が異なる
- production credentialを持つGitHub Environmentのreview条件を満たしていない

production credentialはproduction用GitHub Environmentに限定し、通常のlocal手順と
staging workflowへ渡さない。production workflowはprotected branch、required review、
candidate照合、deploy前後のread-backを通る唯一の通常deploy経路とする。

緊急のsecurityまたはavailability対応で通常gateを省略する場合はbreak-glassとして扱う。
対象、理由、承認、rollback先、実行者、除去条件を事前にincident記録または追加ADRへ残し、
明示承認なしに実行しない。復旧後は同じ変更をstagingで検証し、通常candidateへ収束させる。

## Consequences

- release branch上のcandidateをstagingへdeployする工程が必要になる。
- stagingとproductionのendpoint/templateは分離したまま、同じRunPod image digestを参照する。
- mock E2Eとunit testは高速なPR gateとして維持するが、実service staging acceptanceの
  代替にはしない。
- staging acceptance後の小さな修正でもcandidateは無効になり、buildとacceptanceを
  やり直す。
- promotion workflow、candidate manifest、実resource parity verifierを実装するまで、
  通常のproduction deployを停止する。
- production障害時のrollbackも、新規buildではなく過去にstaging acceptanceを通過した
  candidateを使用する。

## Status

Accepted
