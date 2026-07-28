# ADR 0034: release candidateの高コスト処理前に実環境readinessを検査する

## Context

release branchからmainへのdraft PRにより自動CIとcandidate publicationが成功した後、
staging workflow先頭の
RunPod preflightで`runpodctl template list`が3回とも正常な配列を返さず停止した。
staging内では最初のmutation前に停止できたが、release全体ではCIとcandidateに約20分を
費やした後の検知だった。candidate内のquality、security、browser gateも、同じcommitの
自動CIと重複していた。

固定`runpodctl`のread pathを同じ条件で再試行するだけでは、provider API自体が正常でも
CLIの応答変換で失敗し続ける可能性がある。また、preflightを別workflowにすると失敗時の
待ち時間は短くなるが、releaseごとのworkflow run数が増える。

## Decision

- `.github/workflows/ci.yml`の手動起動を廃止する。`develop`と`main`のpush/PRで自動実行し、
  release branchからmainへのPRもこのCIを正とする。
- release PRのCIでは、staging Environmentへ限定したreadiness jobを最初に実行する。
  quality、secret、dependency、browser、containerの全jobはreadinessへ依存し、失敗時は
  既存required checkも直ちに失敗させ、高コスト処理を開始しない。release PR以外では
  readinessをskipし、credentialless CIを維持する。
- candidate workflowの最初のjobは、GitHub APIから同じrepository、workflow path、
  release branch、commit、event、成功statusを満たすCI runを検証する。候補がなければ
  applicationまたはcontainer buildを開始しない。
- candidateではCI済みのquality、secret、dependency、browser gateを再実行しない。
  application artifactのbuild/検証と、実際に発行するcontainer自身のoffline check、
  SBOM、vulnerability scanは引き続き実行する。
- candidateの最初のjobでもstaging RunPod readinessを再検証する。CI成功後のcontrol-plane
  変化を見落とさず、後続jobはこのjobの成功を必須とする。
- CIとcandidateのreadiness jobへ渡すstaging secretはRunPod API keyとendpoint IDだけに
  限定する。
  Cloudflare credential、registry credential、production secretを渡さず、RunPod mutationを
  実行しない。candidateのbuild、test、publish jobにはstaging Environmentを付けない。
- readinessは公式REST APIのtemplate listとendpoint getを並列実行する。template listは
  `includeEndpointBoundTemplates=true`を必須とし、既存endpointへ接続中のtemplateも
  見落とさない。
- host、path、query、GET method、redirect拒否、15秒timeout、2 MiBのresponse上限を固定する。
  API keyはAuthorization headerだけで送る。
- transport error、408、429、5xx、malformed responseだけを1秒、2秒の待機で最大3回まで
  再試行する。401など恒久的な4xxは再試行しない。二つのreadは並列なので、remote readの
  上限は約48秒とする。logにはcommand種別とattemptだけを残す。
- candidate作成後のstaging workflowにもpreflightを残す。ここではcandidate manifestから
  導出した完全なplanに対してtemplate、endpoint、worker状態を厳格に再検証し、readinessの
  古い成功だけをpromotion根拠にしない。
- template列挙はpromotionでも公式REST APIを使う。template作成、template個別取得、
  endpoint取得・更新は、既存の固定`runpodctl`境界を維持する。既知portの空配列更新だけは
  ADR 0032の公式REST API例外を維持する。
- candidate workflowはbranch単位のconcurrency groupを持ち、高コストなcandidate publicationを
  同時に実行しない。新しいdispatchは同じbranchの古いcandidateを取り消す。candidateの
  registry tagとartifact名はrun/attempt固有でdeployを含まないため、古いrunの中断で
  environment resourceを半端に更新しない。preflight失敗はそのrunだけを停止する。

## Consequences

- 今回と同じRunPod認証、template list、endpoint read障害は、自動CIの最初のremote read
  約48秒以内に検知し、quality、browser、containerを開始しない。
- candidateは同じcommitのCI成功を再利用するため、quality、secret、dependency、browserの
  重複jobを削減できる。
- 通常の1 release commitでstaging acceptanceまでに起動するworkflowは、自動CI、
  candidate、stagingの3本とする。production promotion時だけ1本を追加する。失敗後は
  原因の特定、修正、対象preflightまたはlocal gateの成功なしに再dispatchしない。
- release PRのCIとcandidate workflow全体は完全なcredentiallessではなくなる。staging
  secretはread-only jobだけに限定され、通常CI、artifact build/publish jobからは利用
  できない。
- staging EnvironmentにはCIとcandidateのreadiness jobのDeployment記録も残る。実deployの成否は
  workflow pathとstaging acceptance artifactで区別し、readiness成功をdeploy成功として
  扱わない。
- 外部control planeはpreflight後にも変化し得るため、staging直前のcandidate固有再検証を
  省略できない。

## Status

Accepted

## References

- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
- [ADR 0031: RunPod promotionではread commandだけを再試行する](./0031-retry-only-runpod-read-commands.md)
- [ADR 0032: RunPodの既定template portを自動で正規化する](./0032-automate-runpod-default-port-normalization.md)
- [RunPod list templates API](https://docs.runpod.io/api-reference/templates/GET/templates)
- [RunPod get endpoint API](https://docs.runpod.io/api-reference/endpoints/GET/endpoints/endpointId)
