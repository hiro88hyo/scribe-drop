# ADR 0026: RunPodの終了済みworker recordをactive workerと区別する

## Context

release candidateをstaging endpointへ昇格する前に、`runpodctl serverless get
--include-workers`の`workers`を検証している。従来は配列が空の場合だけtemplate切替を
許可し、1件でもあればactive workerとの競合を避けるため停止していた。

stagingでworkerを終了し、Consoleに実workerが存在しない状態でも、RunPod REST APIは
終了済みworker recordを`workers`へ残した。recordの`desiredStatus`は`EXITED`であり、
固定planの`workersMin`は0だった。RunPodの公式REST schemaでは`desiredStatus`は現在の
期待状態であり、`RUNNING`、`EXITED`、`TERMINATED`のenumである。

配列の存在だけをactive判定にすると終了済み履歴によってpromotionを再開できない。
一方で全recordを無条件に無視すると、稼働中workerやprovider schema driftを見逃して
旧imageと新imageが混在し得る。

## Decision

- `workers`の各要素を外部入力として検証し、object以外を拒否する。
- `desiredStatus`が完全一致で`EXITED`または`TERMINATED`のrecordだけを非稼働として許可する。
- `RUNNING`、未知値、欠落値、型不一致はactiveまたは未認識workerとしてpromotionを拒否する。
- template切替前と切替後の両方で同じ検証を行う。切替後の検証に失敗した場合は既存の
  rollback経路を使用する。
- worker ID、machine ID、IP、image、environment、provider応答本文をlogへ出さない。
- RunPodが実稼働状態を表す別fieldまたは新しいlifecycle値を追加した場合、暗黙に許可せず
  contract、回帰テスト、このADRを更新する。

## Consequences

- RunPodが保持する終了済みworker履歴だけを理由にcandidate promotionが停止しなくなる。
- `RUNNING`のworker recordがある間は従来どおりfail closedとなる。
- providerが`desiredStatus`を省略する、または応答形式を変更するとpromotionは停止する。
- `active workers 0`はworker配列の長さではなく、許可されたterminal record以外が0件で
  あることとして検証する。

## Status

Accepted

## References

- [RunPod REST API: Find a Pod by ID](https://docs.runpod.io/api-reference/pods/GET/pods/podId)
- [ADR 0012: runpodctlの取得境界を補うstaging検証を固定する](./0012-runpodctl-staging-verification-boundary.md)
