# ADR 0036: custom domain readinessをacceptanceの先頭へ移す

## Context

candidate Pages deploymentについて、公式APIのproduction deployment、commit、branch、
status、`uses_functions`、deployment alias、設定hashは一致していた。デプロイ後に人間が
同じcustom domainへMFAでアクセスすると、candidate commitの`/api/me`は正しいJSONを
返した。一方、直後のGitHub-hosted runnerからservice tokenで同じrouteを取得すると、
Access認証成立後もstaticまたはedge由来と分類される404が継続した。

この結果は、任意地域のcustom domain edgeがその時点で収束しているかを示すが、
candidate artifactまたはPages promotionの正しさを決定する証拠にはならない。
このprobeをPages promotion直後の独立jobに置くと、地域伝播の一時差をbackend promotionの
恒久的なblockerとして扱い、workflowの進行と再実行を不必要に増やす。

ただし、未収束または誤ったdata planeからmedia uploadを開始してはならない。R2 policy、
RunPod template、Orchestratorのpromotionは冪等な構成更新であり、それ自体はGPU jobを
開始しない。GPU利用はbrowser E2Eがuploadを開始した後にだけ発生する。

## Decision

- Pages promotionの成立条件は、candidate作成時のcompiled route検証と、公式Pages APIによる
  exact read-backとする。commit、branch、environment、deploy status、`uses_functions`、
  deployment alias、設定hashの一致を必須にする。
- staging workflowは`preflight`、`migrate`、`deploy-pages`、`deploy-backend`、
  `acceptance`の5 jobとし、`deploy-backend`は`deploy-pages`の成功だけに依存する。
- デプロイ直後に独立したcustom domain readiness job、固定sleep、地域伝播をdeployment
  correctnessへ読み替えるpollを置かない。
- 認証済み`GET /api/me?candidate=<commit>`のreadinessは、`acceptance` jobの実browser
  lifecycleの先頭で検証する。固定E2E identityとAPI response schemaが一致するまで、
  `setInputFiles`、upload、Queue、RunPod GPU jobを開始しない。
- `acceptance`の前にcandidateとlive resourceのread-backを行う。readinessが失敗した場合、
  acceptance artifactは発行しない。
- readiness失敗時はworkflow全体を再dispatchしない。原因をread-onlyに確認し、同じrunの
  failed `acceptance` jobだけを再実行する。成功済みmigration、Pages、backend promotionを
  再実行しない。
- workflow構造と、readinessがuploadより前であることを`pnpm ci:verify`で検査する。

## Consequences

- GitHub runnerが一時的に未収束edgeへ到達しても、それをcandidateまたはPages deploymentの
  不正と誤判定しない。
- backend構成はcustom domain readinessより先にpromotionされる。ただし、その工程はGPU
  jobやmedia uploadを開始せず、実利用者フローは引き続きfail closedとなる。
- edgeが未収束ならacceptanceだけが失敗し、時間と状態変更を伴う成功済みjobを繰り返さずに
  後から再検証できる。
- control planeのexact read-backと利用者data planeの受け入れ確認の責務が分離される。

## Status

Accepted

## References

- [ADR 0033: Pagesのdata-plane収束後にstaging E2Eを開始する](./0033-wait-for-pages-data-plane-convergence.md)
- [ADR 0035: staging readinessをremote mutationからjob単位で分離する](./0035-isolate-staging-readiness-from-mutations.md)
- [Cloudflare Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/)
