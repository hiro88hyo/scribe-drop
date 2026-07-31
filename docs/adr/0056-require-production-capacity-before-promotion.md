# ADR 0056: production promotion前にRunPod capacityを完全一致させる

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0031、ADR 0049、ADR 0053、ADR 0054
- Refined by: ADR 0057

## Context

ADR 0054の修正を含むcandidateは、canonical staging endpointがすでに固定GPUとdata centerを
保持した状態でformal staging acceptanceを成功した。この経路はcandidate templateの切替と
実M4A lifecycleを検証したが、旧GPU・旧data centerから固定planへ移行するcapacity PATCHを
実行していない。

production endpointは旧capacityのままなのに、read-only preflightは
`capacity update pending`を成功として後続を許可した。production workflowはD1 migrationと
R2 policyの冪等適用後、RunPod endpointをdrainしてcapacity PATCHを1回送信した。
実装はPATCH応答を結果不明として扱えるようにしていた一方、直後のRESTとGraphQLの
read-backを1回だけ実行した。固定planへ一致しなかったため旧capacityへrollbackし、
旧Worker上限を復元して停止した。Orchestrator、Pages、candidate templateは変更していない。

RunPodの公式REST APIはendpoint PATCHで複数の`gpuTypeIds`と`dataCenterIds`を受理すると
記載し、この更新をrolling releaseとして説明する。一方、response schemaは
`dataCenterIds`を配列としながら例ではカンマ区切り文字列を示す。ADR 0049でも、HTTP 200と
OpenAPI enumだけでは実APIの保持結果を保証できないことを記録済みだった。stagingの
新規endpoint作成と実job成功を、既存production endpointのin-place capacity移行の証拠へ
拡張してはならなかった。

最初の事前移行実行はmutation前guardで停止した。jobは0、endpoint APIのWorker履歴は
`desiredStatus=EXITED`だった一方、health APIは設定済み5秒のidle timeoutを超えて
`ready=1`、`idle=1`を返し続けた。providerがterminal Worker履歴を保持することと、
health由来のactive状態が遅延または不整合になり得ることを別々に扱う必要がある。
terminal履歴の存在をdrain失敗とみなす一方、health未収束のままcapacityを更新する実装は、
どちらも安全な事前移行にならない。

terminal履歴を許容する修正後の事前移行では、Worker上限0のread-back後にhealthが
idle/readyからinitializingへ遷移した。capacity mutation前に停止してWorker上限を復元したが、
drain後のinitializingをbounded convergence待ちではなく即時失敗にしていたことが判明した。
drain後はjobだけを即時拒否し、idle/initializing/ready/runningのすべてを同じbounded
read-backで0へ収束させる必要がある。

## Decision

- productionのread-only promotion preflightはcapacity driftを「更新予定」として成功させない。
  GPU順序、data center集合、complianceが固定planへ完全一致しなければ、最初のremote
  mutationより前に失敗する。
- production candidate promotion本体にも同じguardを置く。preflightが迂回されても、
  capacity driftがあるendpointをdrain、PATCH、template切替しない。
- production capacity移行はcandidate promotionと分離した、明示承認付きの事前作業とする。
  対象endpointがjob、`RUNNING` Worker、`INITIALIZING` Workerを持たないこと、旧capacityを
  完全にread-backできること、固定planの両GPUが利用可能であることを先に確認する。
  `READY`かつ`IDLE`のWorkerはjobがない場合だけdrain対象にできる。
- Worker上限を0へ変更した後は、endpoint APIに残る`EXITED`、`TERMINATED`履歴を
  active Workerと数えない。ただし未知statusまたはnon-terminal Workerは拒否する。
  capacity mutationより前にhealthのqueue/in-progress jobと
  idle/initializing/ready/running Workerがすべて0へ収束したことを、最大6回、合計30秒の
  bounded read-backで確認する。収束しなければcapacityを変更せずWorker上限を復元して
  失敗する。
- capacityのprovider mutation境界は
  [ADR 0057](./0057-split-runpod-capacity-mutations.md)を正とする。GraphQLでdata centerを
  1回更新し、旧GPU保持を中間read-backしてから、RESTでGPUだけを1回更新する。各mutationを
  再送せず、完全一致しなければ同じ分割境界とbounded read-backで旧capacityへrollbackする。
- stagingでcapacityが一致済みだったという事実は、production capacity移行の成功証拠に
  しない。production実endpointの事前移行と独立read-backが成功するまでpromotion workflowを
  dispatchしない。
- capacity移行はlocal-onlyの`runpod:capacity:prepare:production`で行う。明示confirmationを
  必須とし、GitHub Actions内の実行を拒否する。endpoint healthのqueue/in-progress jobと
  running/initializing Workerが0であることを確認し、Worker上限を0へdrainする。drain後かつ
  capacity更新前にidle/initializing/ready/running Workerがすべて0であることを再確認して
  から更新し、最後に上限を復元する。更新後に新しいjobが
  queueへ入った場合は旧capacityへ
  rollbackしてから上限を復元する。rollback、秘密値を含まない固定エラー、単一mutation、
  bounded read-backを
  回帰testとCI構造検査で固定する。capacity更新とrollbackの両方が失敗した場合は状態不明の
  endpointでWorkerを起動せず、上限0の安全停止を維持する。Consoleだけの未記録変更を
  通常手順にしない。

## Consequences

- capacity不一致をD1、R2、RunPod、Cloudflareをまたぐ長いworkflowの途中で初めて検出せず、
  費用と待ち時間が発生する前に停止できる。
- providerの反映遅延を即時失敗と誤認しない一方、mutationの自動再送と無期限pollは行わない。
- providerがterminal Worker履歴を保持しても誤って失敗しない。逆にendpoint履歴がterminal
  でもhealthがactiveなら、capacity更新前にdrain収束を待って安全停止できる。
- capacity変更が必要なreleaseには事前作業が1段増える。通常のtemplate/imageだけのreleaseは
  endpoint capacityが固定planへ一致しているため追加作業を必要としない。
- 今回のcandidateとstaging acceptanceは、promotion制御のcommitを変更した時点でそのまま
  再利用できない。修正後のlocal gateと事前capacity移行を成功させてから、新しい同一commitの
  candidateとformal staging acceptanceを必要最小回数だけ実行する。
