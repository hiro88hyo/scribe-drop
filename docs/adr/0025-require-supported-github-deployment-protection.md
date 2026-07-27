# ADR 0025: 対応planなしでdeployment protectionを迂回しない

## Context

ADR 0023は、private repositoryのstaging/production GitHub Environmentへcredentialを
分離し、productionにrequired reviewerとrelease branch制限を設定することを通常の
promotion条件としている。

現在のrepositoryではEnvironmentが未作成で、GitHub APIによるrulesetとbranch protectionの
取得はplan不足の403となる。GitHubの現行仕様では、private repositoryのEnvironment
secret、variable、deployment branchはPro以上、branch protectionもPro以上を必要とする。
required reviewerなどのdeployment protection ruleは、Free、Pro、Teamではpublic
repositoryだけで利用できる。

repository-level secretへproduction credentialを移すと、Environment境界と承認前の
secret非公開性を失う。workflow input、手動チェックボックス、長期tokenをartifactへ入れる
方法もrequired reviewerの代替にはならない。

## Decision

- credentialをrepository-level secretへ移さず、ADR 0023の境界を弱めない。
- credentialを持たないcandidate publication workflowは実行できる。
- staging/production promotionは、Environment secretとdeployment branch restrictionを
  利用でき、production required reviewerを強制できる状態になるまで実行しない。
- privateを維持する場合はGitHub Enterpriseの利用を必要条件とする。public repositoryへ
  変更する案は技術的な代替だが、可視性を変えるため明示的な所有者判断なしに行わない。
- `release/*`、`develop`、`main`へ必要なbranch protectionを設定し、そのread-backが成功
  するまでcandidateをproduction-readyと扱わない。

## Consequences

- 現在のplanでもimmutable candidateをbuild、scan、GHCRへ発行できる。
- staging/production credentialは未登録のままとなり、promotion workflowはfail closedに
  なる。
- GitHub planまたはrepository visibilityの判断がproduction readinessの外部blockerに
  なる。
- protectionが利用可能になった後、Environment、branch rule、secret/variable名を
  read-backし、値を表示せずに設定完了を確認する必要がある。

## References

- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

## Status

Accepted
