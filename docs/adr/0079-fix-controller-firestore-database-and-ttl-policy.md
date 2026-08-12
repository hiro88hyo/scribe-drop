# ADR 0079: controller Firestore databaseとTTL policyを固定する

## Context

Phase 14のcontroller storeはenvironment singleton、idempotency request、execution recordをnamed Firestore databaseへ保存する。
requestとexecutionだけが`ttlExpiresAt`を持ち、environment singletonはauthorizationとlifetime reservationのsource of truthとして
TTL削除しない。database location、mode、recovery、delete protection、TTL collection groupが未固定のままでは、別database接続、
意図しないdata residency、replay recordの早期消失、cleanup state喪失をlocal verifierが検出できない。

Firestore database read-backの`earliestVersionTime`は現在時刻に追随するoutput-only値であり、そのchecksumである`etag`もresource
mutationなしに変化する。raw response全体の2回一致を要求すると正常なresourceもdriftとして拒否し得る。一方、location、database
mode、access mode、PITR、TTL stateは安定している必要がある。

## Decision

- environmentごとに専用named databaseを使い、`(default)` databaseを許可しない。
- databaseは`asia-southeast1`、Firestore Native、Standard edition、pessimistic concurrency、App Engine integration disabled、
  Firestore API enabled、MongoDB compatible API disabled、Realtime Updates enabledへ固定する。Standard/Native databaseは
  Realtime Updatesを無効化できないため、実APIの固定値を採用する。Firestore/MongoDB access-modeは実APIが既定値fieldを
  省略した場合だけplanのenabled/disabledとして扱い、明示された矛盾値は拒否する。
- delete protectionはstagingとproductionの両方で有効にする。削除時は別cleanup承認、active resource 0、etag read-back後にだけ解除する。
- staging dark deploymentはsynthetic dataだけを扱い、resourceを完全cleanupするためPITRを無効にする。productionは採用時のrecoveryを優先して
  PITRを有効にする。read-backでは対応するretention periodをstaging 3,600秒、production 604,800秒へ固定する。
- TTLは`scribe_drop_controller_requests`と`scribe_drop_controller_executions`の`ttlExpiresAt`だけにoffset 0で設定し、`ACTIVE`へ
  収束した場合だけ受ける。individual field GETに加え、Firestore Admin APIの`collectionGroups/-/fields`へserver-side
  `ttlConfig:*` filterを指定してdatabase全体のTTL集合を読む。live RESTはこのmethodで`pageSize`を0以外受け付けないため
  queryには指定せず、strict response schemaを最大3件に制限する。期待2件以外、重複、非empty
  `nextPageToken`、`CREATING`、`NEEDS_REPAIR`、別field、別collection group、index overrideを拒否する。
- read-only clientはFirestore Admin APIのexact database/field/list GETだけを使い、同じtokenとquota projectで2回取得する。
  responseはstrict parseし、安定性比較ではlist順序をresource nameで正規化し、databaseからは`earliestVersionTime`と連動する
  `etag`だけを除外する。2回目のetagはbounded evidenceとして保持する。
  inherited indexの既定`apiScope: ANY_API`が省略された場合だけ既定値として扱い、明示された別scopeと他fieldの差分は拒否する。
- 2026-08-12のstaging作成preflightでStandard editionへ`--enable-firestore-data-access`を明示するとEnterprise専用として
  拒否され、flagなしで作成したStandard/Native databaseはRealtime Updates enabled、両access-mode field省略を返すことを
  authoritative read-backした。この実contractに合わせて上記planとverifierを更新する。production resourceとCIは変更しない。

## Consequences

- synthetic stagingとproduction recoveryのretention差分が明示され、同じapplication artifactでenvironment別resource policyを検証できる。
- TTL削除は即時ではなく、期限後もしばらくdocumentが残り得る。authorization、replay、cleanupはTTL実行時刻に依存せず、document内の
  expiryとstrict schemaを引き続き検証する。
- Google-managed encryptionを使用し、CMEK付きdatabaseはread-backで拒否する。CMEK採用には別ADR、key rotation、availability、cleanup
  設計が必要である。
- 実resourceのread-backでAPIが新しいtop-level fieldを返した場合はfail closedとなる。schema更新は公式REST contract確認と回帰testを伴う。

## Status

Accepted
