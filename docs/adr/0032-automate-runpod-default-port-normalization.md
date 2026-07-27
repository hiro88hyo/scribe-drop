# ADR 0032: RunPodの既定template portを自動で正規化する

## Context

RunPodはportを指定せずにServerless templateを作成しても、`8888/http`と`22/tcp`を
追加する場合がある。固定している`runpodctl` 2.7.2は空のport集合へ更新できないため、
これまではcandidateごとにConsoleで二つのportを削除し、CLIで再検証していた。

この手順はsecurity上必要な「port公開なし」を満たすが、長時間のpromotionを人手で中断
し、設定ミスと再実行を増やす。RunPodの公式template update APIは`ports`を配列として
受け付ける。一方、mutationのtimeoutや応答喪失を無条件に再送すると、結果不明の操作を
重複させる。

## Decision

- candidate templateが固定planの全項目に一致し、portだけが
  `8888/http`と`22/tcp`の既知セットである場合に限り、自動正規化の対象とする。
- 正規化前に対象endpointを取得し、activeまたは不明なworkerがなく、candidate templateが
  endpointへ未接続であることを確認する。
- GitHub staging/production promotionから公式RunPod REST APIのtemplate updateを1回だけ
  呼び、`ports: []`を設定する。API keyはAuthorization headerだけで渡し、URL、引数、
  response、log、追跡対象fileへ出さない。redirectを拒否し、timeoutを固定する。
- updateは自動再試行しない。成功応答、timeout、応答喪失のいずれでも、その後に
  `runpodctl template get`を実行し、固定planとの完全一致を正とする。結果不明でも
  read-backが完全一致すれば適用済みとして続行し、一致しなければ停止する。
- 既知セット以外のport、ほかのtemplate差分、接続済みtemplate、activeまたは不明な
  workerは自動修正せずfail closedとする。
- templateの厳格照合が成功するまでendpointをcandidateへ切り替えない。
- stagingとproduction workflowは最初のD1、R2、RunPod、Cloudflare mutationより前に
  read-only RunPod preflightを実行する。既知portだけの差分は「正規化待ち」として識別し、
  mutationを行わずに安全条件を確認する。

## Consequences

- candidateごとのConsoleでのport削除は通常手順からなくなる。
- Platform CLIをresourceの作成、取得、endpoint更新の標準経路としつつ、CLIで表現できない
  空配列更新だけに、型とhostを固定した公式REST APIの例外が増える。
- providerが既定portまたはAPI contractを変更した場合は自動追従せず停止するため、
  allowlist、脅威分析、回帰テストを明示的に更新する必要がある。
- mutation自体をretryしないため重複更新を避けられるが、read-backも失敗した場合は
  promotionを再開する前にprovider状態を確認する必要がある。

## Status

Accepted

## References

- [ADR 0012: runpodctlの取得境界を補うstaging検証を固定する](./0012-runpodctl-staging-verification-boundary.md)
- [ADR 0031: RunPod promotionではread commandだけを再試行する](./0031-retry-only-runpod-read-commands.md)
- [RunPod template update API](https://docs.runpod.io/api-reference/templates/POST/templates/templateId/update)
