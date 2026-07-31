# ADR 0028: RunPod image build前にapplication artifactを確定する

## Context

release candidate publicationの`publish` jobは、固定modelを含むRunPod imageのbuild、
offline検査、SBOM生成、脆弱性scan、registry pushを行うため数分以上かかる。
従来はWeb、Pages Functions、Orchestratorのbuildとcandidate構成検証を、この高コスト処理の
後に実行していた。

Orchestrator artifactがmultipart upload bodyだった問題と、Wranglerの相対`--outdir`が
想定外のdirectoryへmoduleを出力した問題は、いずれもcontainer処理を終えた後のcandidate
作成で初めて検出された。検証自体はfail closedだったが、数秒で判定できる決定的な
packaging不良を高コスト処理の後まで遅らせる理由はない。

単に同じbuildを前段でも試すだけでは、実際にcandidateへ含める後段の再buildと同一である
ことを保証できない。

## Decision

- candidate identity確認の直後に独立した`application` jobを実行する。
- `application` jobはWeb assets、compiled Pages Functions、raw Orchestrator ES moduleを
  一度だけbuildする。
- build結果を`web-assets`、`pages-functions`、`orchestrator`だけを持つ厳密なlayoutへ
  構成し、regular file、symlink拒否、必須file、raw module条件を検証する。
- 検証済みapplication artifactはcommit、workflow run、run attempt固有の名前でGitHub
  Actions artifactへ保存し、保持期間を1日に限定する。secret、credential、実resource
  identifier、利用者dataを含めない。
- `quality`、browser E2E、security jobは`application` jobと並行して実行できる。
- 高コストな`publish` jobは`application`を含む全gateへ依存し、検証済みartifactを
  downloadして同じlayoutと内容条件を再検証してから、runner cleanup、RunPod image build、
  scan、pushを開始する。
- `publish` jobはJavaScript applicationを再buildしない。downloadしたapplication
  artifactをRunPod image digest、acceptance fixture、supply-chain evidence、migrationと
  合成し、release candidate manifestでhashする。
- application artifactの生成、upload、download、再検証、高コストcontainer処理の順序を
  CI構成検査で固定する。third-party Actionはfull commit SHAに固定する。

## Consequences

- application packaging不良はcontainer build開始前に失敗し、長いbuildとscanを消費しない。
- candidateに含めるapplicationは前段で検証したものと同じbyte列になり、後段の再build差分が
  なくなる。
- workflow内に短期の中間artifactが1つ増えるが、最終candidateとは別名・短期保持であり、
  production promotion入力にはならない。
- RunPod image固有の不良は引き続き高コストjobでしか検出できないが、application不良とは
  分離して原因を判定できる。

## Status

Accepted

## References

- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
- [ADR 0027: Orchestratorのraw ES moduleをrelease candidateへ保存する](./0027-store-raw-orchestrator-module.md)
