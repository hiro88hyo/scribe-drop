# ADR 0079: controller Firestore databaseとTTL policyを固定する

## Context

Phase 14のcontroller storeはenvironment singleton、idempotency request、execution recordをnamed Firestore databaseへ保存する。
requestとexecutionだけが`ttlExpiresAt`を持ち、environment singletonはauthorizationとlifetime reservationのsource of truthとして
TTL削除しない。database location、mode、recovery、delete protection、TTL collection groupが未固定のままでは、別database接続、
意図しないdata residency、replay recordの早期消失、cleanup state喪失をlocal verifierが検出できない。

Firestore database read-backの`earliestVersionTime`は現在時刻に追随するoutput-only値であり、raw response全体の2回一致を要求すると
正常なresourceもdriftとして拒否し得る。一方、location、database mode、access mode、PITR、etag、TTL stateは安定している必要がある。

## Decision

- environmentごとに専用named databaseを使い、`(default)` databaseを許可しない。
- databaseは`asia-southeast1`、Firestore Native、Standard edition、pessimistic concurrency、App Engine integration disabled、
  Firestore API enabled、MongoDB compatible API disabled、Realtime Updates disabledへ固定する。
- delete protectionはstagingとproductionの両方で有効にする。削除時は別cleanup承認、active resource 0、etag read-back後にだけ解除する。
- staging dark deploymentはsynthetic dataだけを扱い、resourceを完全cleanupするためPITRを無効にする。productionは採用時のrecoveryを優先して
  PITRを有効にする。read-backでは対応するretention periodをstaging 3,600秒、production 604,800秒へ固定する。
- TTLは`scribe_drop_controller_requests`と`scribe_drop_controller_executions`の`ttlExpiresAt`だけにoffset 0で設定し、`ACTIVE`へ
  収束した場合だけ受ける。individual field GETに加え、Firestore Admin APIの`collectionGroups/-/fields`へserver-side
  `ttlConfig:*` filterと`pageSize=3`を指定してdatabase全体のTTL集合を読む。期待2件以外、重複、非empty
  `nextPageToken`、`CREATING`、`NEEDS_REPAIR`、別field、別collection group、index overrideを拒否する。
- read-only clientはFirestore Admin APIのexact database/field/list GETだけを使い、同じtokenとquota projectで2回取得する。
  responseはstrict parseし、安定性比較ではlist順序をresource nameで正規化し、databaseからは`earliestVersionTime`だけを除外する。
  他fieldの差分は拒否する。
- このADRではdatabase作成、TTL mutation、delete protection変更、credential使用、CI変更を行わない。

## Consequences

- synthetic stagingとproduction recoveryのretention差分が明示され、同じapplication artifactでenvironment別resource policyを検証できる。
- TTL削除は即時ではなく、期限後もしばらくdocumentが残り得る。authorization、replay、cleanupはTTL実行時刻に依存せず、document内の
  expiryとstrict schemaを引き続き検証する。
- Google-managed encryptionを使用し、CMEK付きdatabaseはread-backで拒否する。CMEK採用には別ADR、key rotation、availability、cleanup
  設計が必要である。
- 実resourceのread-backでAPIが新しいtop-level fieldを返した場合はfail closedとなる。schema更新は公式REST contract確認と回帰testを伴う。

## Status

Accepted
