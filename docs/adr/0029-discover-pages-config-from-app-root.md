# ADR 0029: Pages設定をapp rootから検出してmutation前に検証する

## Context

Wranglerの`pages deploy`は`--config`をサポートしない。このためWebの環境別設定は
`apps/web/.wrangler/deploy/config.json`から同じdirectoryの追跡外Wrangler設定へredirect
し、Pages commandをapp rootで実行する設計だった。

staging/production promotion workflowだけが`--cwd apps/web/.wrangler/deploy`を指定して
いた。Wrangler 4.114.0はこの指定でuser configurationの`wrangler.toml`とdeploy
configurationの`config.json`を異なるbase pathとして検出し、どちらを使用するか曖昧な
ためdeployを拒否した。文書化したapp root基準とworkflowが一致していなかった。

この構成不良はPages deploy時に判明したため、それより前のD1、R2、RunPod、
Orchestrator更新は既に完了していた。remote mutationを始める前に安価なread-only検査で
config discovery、認証、Pages project参照を確認できる。

## Decision

- stagingとproductionの全Pages commandは`--cwd apps/web`を指定する。
- environment rendererは従来どおり
  `apps/web/.wrangler/deploy/config.json`と追跡外Wrangler設定を生成し、Wrangler自身の
  app-root discoveryを使用する。
- deploy directoryはcandidateから生成した絶対pathを指定し、configの
  `pages_build_output_dir`へcandidateを複製しない。
- D1、R2、RunPod、Orchestratorの最初のmutationより前に`pages deployment list --json`
  を同じapp root、明示project、production environmentで実行する。
- read-only preflightがconfig discovery、認証、project参照、応答取得のいずれかに失敗
  した場合はpromotionを停止する。deployment一覧のID、URL、metadataはlogへ出さず、
  runner一時fileへだけ保存する。
- CI構成検査はstaging/productionのpreflightとdeployがどちらもapp rootを使うこと、
  preflightがmigrationより前であること、deploy config directoryを`--cwd`にしないことを
  固定する。

## Consequences

- 追跡対象のplaceholder設定と追跡外の環境設定を同時に直接指定する曖昧さがなくなる。
- Pages設定またはcredentialの不良では、他resourceを変更する前にpromotionが停止する。
- read-only API callが1回増えるが、GPU起動やresource更新は行わない。
- CloudflareがPages config discoveryを変更した場合、preflightがfail closedとなり、
  renderer、workflow、このADRの見直しが必要になる。

## Status

Accepted

## References

- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
- [ADR 0028: RunPod image build前にapplication artifactを確定する](./0028-fail-fast-before-runpod-image-build.md)
