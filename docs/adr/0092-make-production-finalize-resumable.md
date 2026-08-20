# ADR 0092: production finalizeを明示的な再開可能状態機械にする

- Status: Accepted
- Date: 2026-08-20
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0086、ADR 0089、ADR 0091

## Context

production finalizeはsmoke cleanup、admission pause、controller disable、operational authorization、admission activateを
順番に行う。run `32346058051`ではsmoke cleanupまで成功し、Orchestratorを`paused`へdeployした後、controller disableに必要な
source smoke epochがstepへ渡されず停止した。結果はadmission `paused`、authorization `smoke`という安全だが部分適用された状態に
なった。単一の`active/smoke`入口だけを許可するworkflowは、この状態から同じrunを安全に再開できない。

必須envの欠落だけを追加する修正では、未到達stepの完全性も、各remote mutation直後の失敗からの回復可能性も証明できない。
operational epochをfinalize run IDへ結び付ける設計も、retryごとにdesired stateを変えるためexact retryを妨げる。

## Decision

- finalizeの外形状態を`smoke-active`、`smoke-paused`、`disabled-paused`、`operational-paused`、
  `operational-active`の5状態に限定する。利用者はread-back済みの入口状態をworkflow inputへ明示する。
- 最初のmutation前に、Cloudflare admission、Firestore authorization、Cloud Run Job/Execution 0、production smokeのD1
  `provider_handle`と完全一致する`CLEANED` Firestore execution record、production smoke artifact/notificationを一度にread-backし、
  宣言状態との完全一致を要求する。cutover workflowの時刻窓は、その完了後に投入されるsmokeのidentityに使用しない。
- mutationをpause、disable、authorize、activateの4stepへ分離する。入口状態より前のstepはskipし、残るsuffixだけを実行する。
  controller Service更新とFirestore更新の間で停止した場合も、Firestore authorizationが示す前状態から同じapplyを冪等に再実行する。
- operational epochは`candidate commit + cutover run ID`へ固定し、finalize workflow run IDを使わない。authorization、上限、期限が
  既に完全一致する場合はexact retryとして扱う。
- final read-backは入口やskipにかかわらず、controller operational、admission active、environment parity、Access、secret名、
  candidate/staging identityを再検証する。release evidenceへ入口状態を記録する。
- state-machine unit testは全5入口からterminal stateへの収束と、4mutationの各直後に失敗を注入した全prefixからの再開を検証する。
  workflow contractは全stepの必須env、引数、条件、順序、stable epochを検査し、dispatch job自身がremote readより前に実行する。

## Consequences

- 部分適用後にadmissionを手動復元したり、workflowを最初から偶然通る状態へ戻したりせず、観測済み状態から前方へ収束できる。
- 未知のadmission/authorization組合せ、active provider resource、別cutoverのepoch、異なるbudget/expiryはmutation前に拒否される。
- workflow source、input contract、release evidence schemaの変更なので、既存staging evidenceは失効する。同一candidateのGPU-free
  staging evidenceを更新してからproduction finalizeを再開する。
- 現在の`smoke-paused`からの再開はGPU executionを追加せず、既存smokeのcleanup evidenceを再検証する。
