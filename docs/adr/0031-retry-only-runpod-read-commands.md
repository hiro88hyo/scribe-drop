# ADR 0031: RunPod promotionではread commandだけを再試行する

## Context

release candidateのstaging promotionで、事前には取得できていた固定templateに対する
`runpodctl template list`が、GitHub runner上で約30秒後に正常な配列ではない応答を返した。
promotionは安全に停止したが、同じcandidateの再実行を人手で繰り返す必要が生じた。

RunPodのread APIはtimeout、一時的なprovider error、eventual consistencyで失敗し得る。
一方、template作成やendpoint更新の応答を失った場合は、操作が適用済みか未適用か不明で
ある。同じmutationを無条件に再送するとduplicate resourceや意図しない再更新を起こす。

## Decision

- promotionで使用する`user`、`template list`、`template get`、`serverless get`だけを
  read-only commandとして分類する。
- read-only commandが非zero終了、invalid JSON、期待するtop-level shape以外、または
  provider error envelopeを返した場合、最大3回まで再試行する。
- retry間隔は1秒、2秒の指数backoffに0〜250msのjitterを加える。各CLI invocationの
  60秒timeoutと合わせて回数・時間に上限を持たせる。
- retry logにはcommand種別とattemptだけを出し、API応答、resource ID、credential、
  image、originを出さない。
- `template create`、`serverless update`などmutationは自動再試行しない。失敗または応答
  不明時は既存の一意resource照合・read-back・rollback経路へ渡す。
- top-level shapeが正しい応答はretry wrapperで受理し、その後の固定plan検証を緩めない。
  port、image、environment、worker状態などの不一致は一時障害としてretryしない。
- stagingとproductionのpromotionは同じretry wrapperを使用し、CI構成検査でwrapperの
  bypassを拒否する。

## Consequences

- 短時間のRunPod read障害でpromotion全体を手動再実行する頻度を下げられる。
- 認証不良など恒久的なread障害でも最大3回分の遅延が発生するが、上限は固定される。
- mutationの結果不明をretryで隠さず、duplicateや競合を増やさない。
- provider応答形式が変わった場合は3回後にfail closedとなり、schemaとCLI versionを
  見直す。

## Status

Accepted

## References

- [ADR 0012: runpodctl staging検証境界](./0012-runpodctl-staging-verification-boundary.md)
- [ADR 0023: Promote only staging-verified artifacts](./0023-promote-only-staging-verified-artifacts.md)
- [ADR 0026: RunPodのterminal worker recordを状態で分類する](./0026-classify-runpod-terminal-worker-records.md)
