# ADR 0034: release candidateの高コスト処理前に実環境readinessを検査する

## Context

release-to-mainのdraft PRを開いたままrelease branchを更新したため、各pushでPR CIが
自動起動していた。さらにcandidate publicationが成功した後、staging workflow先頭の
RunPod preflightで`runpodctl template list`が3回とも正常な配列を返さず停止した。
staging内では最初のmutation前に停止できたが、release全体ではPR CIとcandidateに約20分を
費やした後の検知だった。PR CIとcandidate内のquality/security/browser/container gateも
重複していた。

固定`runpodctl`のread pathを同じ条件で再試行するだけでは、provider API自体が正常でも
CLIの応答変換で失敗し続ける可能性がある。また、preflightを別workflowにすると失敗時の
待ち時間は短くなるが、releaseごとのworkflow run数が増える。

## Decision

- `.github/workflows/ci.yml`の手動起動を廃止する。通常CIは`develop`と`main`のpush/PRに
  限定し、release branchではcandidate workflow自身の同等以上のquality、security、
  browser、container gateを一度だけ実行する。
- release-to-main PRはcandidate publicationとstaging acceptanceが成功するまでclosedに
  保つ。成功後に同じPRをreopenし、確定済みcommitに対する最終PR CIを一度だけ実行する。
  reopen後にcode、dependency、migration、deployment設定を変更した場合はPRを再びcloseし、
  candidateとstaging acceptanceを無効化して最初からやり直す。
- candidate workflowの最初のjobをstaging Environmentへ限定し、release identityの検査後、
  高コストなbuild、browser install、container build、scanより前にRunPodのreadinessを
  検査する。後続jobはこのjobの成功を必須とする。
- readiness jobへ渡すstaging secretはRunPod API keyとendpoint IDだけに限定する。
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

- 今回と同じRunPod認証、template list、endpoint read障害は、別workflowや高コスト処理を
  開始せず、candidate workflowの最初の1分程度で検知できる。
- release branchでPRを開いたまま更新せず、手動CIも重ねないため、作業中のpushごとに
  高コストなPR CIを起動しない。
- 通常の1 release commitでstaging acceptanceまでに起動するworkflowはcandidate 1本と
  staging 1本とする。その後、PRをreopenして最終CIを1本だけ実行し、production
  promotion時に1本を追加する。失敗後は原因の特定、修正、対象preflightまたはlocal
  gateの成功なしに同じworkflowを再dispatchしない。
- candidate workflow全体が完全なcredentiallessではなくなる。staging secretは最初の
  read-only jobだけに限定され、artifact build/publish jobからは利用できない。
- staging Environmentにはreadiness jobのDeployment記録も残る。実deployの成否は
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
