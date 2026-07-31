# ADR 0063: solo maintainerでは独立承認を必須にしない

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0025の`main`・`develop` branch review policy
- Does not change: production Environmentのrequired reviewer

## Context

release 0.1.0のGit-flow統合時、`main`と`develop`にはrepository rulesetとclassic branch
protectionが重複していた。rulesetはPR、merge commit、strictな5 required checks、conversation
解決を要求し、承認人数は0だった。一方、classic protectionは承認1名とlast pusher以外の
承認を要求し、管理者にも適用していた。

repositoryには独立したmaintainer accountが存在しない。全CI、formal staging、exact artifact
production promotion、post-deploy read-backが成功しても、自分のPRを自分で承認できないため
releaseをGit-flowで完了できなかった。admin mergeもclassic protectionに拒否された。

承認専用の別accountやbotを作ることは独立reviewにならず、security controlを満たしたように
見せるだけである。一方、PRやrequired checks自体を外すと、直接push、未検証merge、監査証跡
欠落を許すため許容できない。

## Decision

- 独立したqualified maintainerが存在しない間、`main`と`develop`のapproving review countを
  0、last push approvalをfalseにする。これはsolo maintainer制約への明示的な例外であり、
  reviewを偽装するaccountやbotは使わない。
- `main`と`develop`は引き続きPR経由だけで変更する。直接push、force-push、branch削除を禁止し、
  管理者にも同じ保護を適用する。
- merge方法はmerge commitだけを許可し、conversation resolutionと次のstrict required checksを
  必須にする。
  - `Quality gate`
  - `Secret scan`
  - `Dependency audit`
  - `Browser E2E`
  - `RunPod container supply chain`
- security、authorization、schema、migration、deployment gateの変更はPR本文に判断と検証を
  明記し、未解決指摘があればmergeしない。必要に応じて外部reviewを依頼し、solo maintainer
  例外を急ぐ理由には使わない。
- branch protectionはmachine-readable request、read-back verifier、unit test、運用文書を同じ
  変更で同期する。dashboardやAPIだけの未記録変更を残さない。
- production Environmentのrequired reviewerと`release/*` deployment policyはcredential公開前の
  人手承認境界であり、このADRでは変更しない。
- repositoryに継続的にreviewできるqualified maintainerが加わった時点で、別PRにより承認1名と
  last push approvalを再有効化する。解除条件はGitHub上のaccount数ではなく、変更内容とsecurity
  boundaryを実際にreviewできることとする。

## Consequences

- solo maintainerでも、CIと監査証跡を維持したままGit-flowを完了できる。
- 独立した人間によるcode reviewは保証されない。この残余riskを、strict CI、formal staging、
  exact artifact promotion、post-deploy read-back、ADR、PR履歴で軽減する。
- required check名やreview policyがdriftすると、production controls verifierがcandidate開始前に
  fail closedする。
- 将来maintainerが増えた場合、この例外を恒久既定値として放置できない。
