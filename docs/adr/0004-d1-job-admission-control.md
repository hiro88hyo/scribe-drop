# ADR 0004: job admissionをD1の条件付きINSERTで原子的に制御する

- Status: Accepted
- Date: 2026-07-25

## Context

`POST /api/jobs`には、利用者ごとに次の制限がある。

- active jobは最大3件
- job作成はrolling 10分間に最大10件

制限の確認後に別statementでjobをINSERTすると、同時requestが同じ古いcountを読み、両方を許可するTOCTOU競合が発生する。

Cloudflare Workers Rate Limiting APIは利用者IDをkeyにできるが、periodは10秒または60秒だけである。counterはCloudflare locationごとに分離され、非同期更新されるeventually consistentかつpermissiveな仕組みであり、正確なaccounting用途ではない。この性質は10分rolling windowや全regionを通じた同時実行上限のauthoritativeな認可には合わない。

D1ではすべてのwriteがprimaryへ転送され、各databaseはqueryを一度に1件ずつ処理する。制限predicateとINSERTを同じSQL statementにすれば、競合requestをprimary上で順番に評価できる。

## Decision

### Authoritative gate

- Phase 2ではWorkers Rate Limiting bindingをjob admissionの正としない。D1に保存済みのjob rowをsource of truthとする。
- job ID、timestamp、request bodyをすべて検証・生成してから、repositoryが1つのparameterized `INSERT ... SELECT ... WHERE ... RETURNING`を実行する。
- 同じstatement内で、検証済みAccess `sub`について次を両方確認する。
  - `created_at > window_start`のjobが10件未満
  - active statusのjobが3件未満
- predicateを満たした場合だけjob rowを1件INSERTする。事前の`SELECT count(*)`だけで許可を確定しない。
- statementには`owner_sub`、cutoff、全row値をbound parameterとして渡し、日時やIDをSQL文字列へ連結しない。
- requestごとに注入clockから`now`を一度だけ取得し、`created_at`、`updated_at`、`window_start = now - 600 seconds`を同じ値から生成する。
- rolling windowは`(now - 600 seconds, now]`とする。ちょうど600秒前のjobはwindow外である。
- 制限値3、10、600秒はversion管理されたdomain定数とし、未検証の環境変数で変更しない。

概念上のSQLは次の形とする。実装では全columnを明示し、`?NNN`形式のbound parameterを使う。

```sql
INSERT INTO jobs (...)
SELECT ...
WHERE (
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = ?1
      AND created_at > ?2
) < 10
AND (
    SELECT COUNT(*)
    FROM jobs
    WHERE owner_sub = ?1
      AND status IN (
          'CREATED',
          'UPLOADING',
          'UPLOADED',
          'SUBMISSION_PENDING',
          'SUBMITTING',
          'RUNNING',
          'CANCEL_REQUESTED'
      )
) < 3
RETURNING ...;
```

### Count semantics

- creation rateは成功してD1へ保存されたjobだけを数える。schema不正、認証・CSRF拒否、D1へ保存されなかったrequestは数えない。
- creation rateにはterminal jobと論理削除済みjobも含める。削除や即時失敗で作成枠を回復させ、短時間のresource abuseへ利用できないようにする。
- active statusは`CREATED`、`UPLOADING`、`UPLOADED`、`SUBMISSION_PENDING`、`SUBMITTING`、`RUNNING`、`CANCEL_REQUESTED`とする。
- `COMPLETED`、`FAILED`、`CANCELLED`、`EXPIRED`、`SOURCE_MUTATED`はactiveに含めない。
- 論理削除されたjobでも、statusがactiveである間は同時実行枠を消費する。削除処理がterminal状態へ遷移して初めて枠を解放する。
- 利用者間のcounterは`owner_sub`で完全に分離し、email、IP address、client指定値をkeyに使わない。
- 将来のretry APIはcreation rateを消費しないが、新attemptをactiveにする前に同じ3件上限を原子的に確認する。

### Result classification

- `RETURNING`が1 rowなら作成成功とする。`success: true`だけでなく、返却row数が正確に1であることを確認する。
- 0 rowならadmission拒否である。`withSession("first-primary")`内の後続diagnostic queryで最新countを読み、次の優先順で安全なerrorへ分類する。
  1. active countが3件以上なら`409 TOO_MANY_ACTIVE_JOBS`
  2. rolling countが10件以上なら`429 RATE_LIMITED`
  3. 競合終了やwindow境界移動で両方を下回っていても、安全側の`429 RATE_LIMITED`
- `RATE_LIMITED`では最古のwindow内jobから再試行可能時刻を計算し、1～600秒の整数`Retry-After`を返す。計算できない場合は60秒とする。
- `TOO_MANY_ACTIVE_JOBS`の解消時刻は予測できないため`Retry-After`を返さない。
- 制限拒否はjob row、event、upload credentialなどの副作用を作らない。R2 temporary credential発行はPhase 3で、D1 job作成成功後にだけ行う。

diagnostic queryは利用者向けerror分類のためであり、許可判断には使わない。診断中に別jobがterminal化しても、拒否済みrequestをその場で再INSERTしない。clientが新しいrequestとして再試行する。

### Failure mode

- D1 timeout、overload、binding error、予期しないrow countではfail closedとし、jobを作成しない。
- D1依存障害は安全な`500 INTERNAL_ERROR`へ正規化する。database error本文、SQL、bound value、owner `sub`をresponseやlogへ含めない。
- D1 SDKやapplication層で自動的にcreate request全体をretryしない。結果不明時に別job IDで再送すると重複作成になるためである。
- clientによる明示的な再送は新しい作成試行として扱い、成功済みrowがある場合はrate windowへ含まれる。
- 将来、Cloudflare WAFまたはRate Limiting APIを粗いrequest flood対策として追加しても、D1 gateを省略しない。補助limiter障害はD1の正確性へ影響させない。

### Indexとmigration

- 既存の`idx_jobs_owner_created`をrolling window queryに使う。
- Phase 2実装ではforward-only migration `0002_job_admission_indexes.sql`を追加し、active count用に`jobs(owner_sub, status)` indexを作成する。
- 適用済み`0001_initial.sql`は変更しない。
- migration検証へquery plan、limit境界、並行作成時に1件だけ成功するケースを追加する。

## Required tests

- 0～9件のwindow内jobでは作成でき、10件あると11件目を拒否する。
- 最古jobがちょうど600秒前なら新規作成でき、1ミリ秒でもwindow内なら拒否する。
- terminal、論理削除済みjobもrolling countへ含める。
- active jobが2件のときは作成でき、3件のときは拒否する。
- active jobをterminalへ遷移すると同時実行枠が1件解放される。
- 論理削除だけではactive枠が解放されない。
- owner Aのjobはowner Bのlimitへ影響しない。
- active 2件から2 requestを同時実行しても、作成成功は1件だけである。
- rate残り1件から2 requestを同時実行しても、作成成功は1件だけである。
- D1 error、timeout、予期しないrow countではjobや後続副作用が作られない。
- rejected responseに`sub`、email、SQL、title、filename、内部errorが含まれない。

## Consequences

- 正確性はD1 primaryのwrite serializationと単一SQL statementに集約される。
- 追加のcounter tableや定期cleanupを必要とせず、監査対象のjob rowとrate判定が一致する。
- rolling windowごとにindex範囲を読むため、job履歴が増えても全table scanを避けられる。
- D1が利用できない間はjob作成も停止するが、制限を迂回して高コスト処理を開始するより安全である。
- Rate Limiting APIだけで全regionの正確な10分limitを保証できないという制約を受け入れ、edge flood対策とapplication admissionを分離する。

## References

- [Cloudflare Workers: Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare D1: Global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare D1: Limits and concurrency](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1: Prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
