# ADR 0084: staging fault acceptanceをjobと時刻で限定する

## Context

Phase 15では実service stagingで、通常成功系に加えてworker停止、heartbeat response loss、通知service一時障害を
検証する必要がある。外部resourceの削除や任意URLへの差し替えだけでこれらを再現すると、故障点が毎回変わり、
認証前の失敗と認証後のresponse lossを区別できない。Cloud Run cold start中の手動操作へ依存すると、対象外jobを
巻き込む危険もある。

[Phase 6 failure injection](../failure-injection.md)は通常CI専用で、本番codeへfault変数やendpointを追加しないと
定めている。一方、Phase 15の同一candidateを実serviceで検証するには、artifactを差し替えずstagingだけで
故障を有効化できる、より狭い例外が必要である。任意のerror、回数、URL、execution handleを受け付ける汎用harnessや
永続的なfault rowはrelease artifactの攻撃面を不必要に広げる。

## Decision

- Orchestratorへ公開管理endpointやD1 fault tableを追加しない。fault leaseは追跡外staging deployment configの
  `STAGING_ACCEPTANCE_FAULT`、`STAGING_ACCEPTANCE_FAULT_JOB_ID`、
  `STAGING_ACCEPTANCE_FAULT_ISSUED_AT`、`STAGING_ACCEPTANCE_FAULT_EXPIRES_AT`の完全な4件だけから読む。
- leaseは`APP_ENV=staging`、uppercase ULIDの単一job、UTCの発行・失効時刻、最大30分をすべて満たす場合だけ有効とする。
  4件がすべて未設定なら無効、部分設定、不正値、production/localでの設定はdeployment errorとしてfail closedにする。
- fault kindは次の固定3件だけを許可する。任意status、任意delay、任意dependency、titleやfilenameによるtriggerは許可しない。
  - `worker_disconnect_after_claim`: session認証とackのD1永続化後に応答を失わせる。exact retryも同じ結果となり、workerは
    terminalを確定できずnon-zeroで終了する。
  - `runtime_heartbeat_response_loss`: session認証とheartbeatのD1永続化後に応答を失わせる。exact retry後もworkerは停止し、
    terminal欠落と後続heartbeat欠落を通常reconciliationが失敗・cleanupへ収束させる。
  - `notification_unavailable`: 対象jobのoutbox deliveryだけをretryable `DISCORD_UNAVAILABLE`としてreleaseし、Discordへ
    requestを送らない。lease除去後は同じoutbox rowを通常retryで送る。
- runtime faultはexecution handleだけを信頼せず、D1のprovider execution、attempt、現在のactive jobをjoinしてleaseのjob IDと
  完全一致させる。session認証と通常のD1 effectが成功する前にfault responseへ置き換えない。認証失敗はfaultを有効にしても
  従来の拒否を返す。
- acceptance driverはupload-completeより前に得たjob IDへleaseを固定し、同じcandidate bundleを再buildせずstaging configだけを
  一時更新する。1 scenarioのterminal・cleanup evidenceを取得したら、次のjob作成前に4件をすべて除去し、active Worker 1 version、
  traffic 100%、通常binding、対象resource 0をread-backする。
- 4変数はsecretではないが、GitHub Environment、追跡対象Wrangler設定、production設定へ保存しない。production promotion parityは
  4件の不存在を必須とする。source-controlled config rendererとactive binding read-backはproductionへの入力・残存を拒否し、
  staging fault時だけ4件のexact値を追加照合する。CI workflow自体へfault入力を追加しない。
- 破損media、capacity rejection、cancel、controller outageはこのharnessで偽装せず、それぞれ実media validation、有限authorization、
  利用者cancel、実controller transport境界で検証する。

## Consequences

- 同一candidate artifactのまま、認証済みeffect後のresponse lossと通知retryを単一jobへ限定して再現できる。
- leaseの最大寿命後は自動的に通常動作へ戻るが、環境変数自体は自動削除されない。scenario後のconfig除去とread-backは正式な
  cleanup条件であり、省略できない。
- runtime heartbeat response lossはheartbeatを一件永続化してからworkerを停止する。これは通信断後の無heartbeatとterminal欠落を
  検証するもので、任意時間workerをhangさせる仕組みではない。
- source変更により`26a09dc`の成功系staging evidenceは次candidateのpromotionへ使用できない。新commitからbuild-onceし、Phase 14
  gateとPhase 15成功系を含むacceptanceをやり直す。

## Status

Accepted
