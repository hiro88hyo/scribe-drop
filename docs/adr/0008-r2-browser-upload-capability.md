# ADR 0008: browser uploadをlocal-signing R2 capabilityへ限定する

- Status: Accepted
- Date: 2026-07-25

## Context

Phase 3では、browserが非公開R2 bucketへ直接multipart uploadできる15分の
Temporary Credentialsを発行する必要がある。credentialは単一bucket、単一object、
uploadに必要な操作だけへ限定し、親credentialをbrowserへ渡してはならない。

Cloudflareの2026-04-24時点の
[Temporary Credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
では、Temporary Credentials APIはbucket、objectまたはprefix、期限を限定できる。
ただしAPI発行で指定できる`object-read-write` scopeにはread、write、listが含まれ、
S3 action単位の制限はlocal signingだけが対応している。

同じ公式資料と
[認証例](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/)
は、親R2 secretでHS256 JWTを署名し、JWTのSHA-256 digestを一時secret、
`base64("jwt/" + JWT)`をsession tokenとして使う方式を定義している。

[S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)では
`If-None-Match`を`PutObject`のconditional operationとして記載しているが、
`CreateMultipartUpload`にはconditional operationがない。したがってmultipart開始時に
`If-None-Match: *`相当のcreate-only条件を強制できるという前提は置けない。

## Decision

- Web Worker内で親R2 access key IDとsecretを使い、Cloudflare公式形式のJWTをlocal
  signingする。Cloudflare REST APIへcredential発行requestは送らない。
- credentialのTTLは900秒とし、JWTの`sub`をCloudflare account ID、`iss`を親access
  key ID、`aud`をaccount固有R2 S3 hostとする。
- JWTは対象bucket、`objectPaths`のsource key 1件、次のactionだけに限定する。
  - `CreateMultipartUpload`
  - `UploadPart`
  - `CompleteMultipartUpload`
  - `AbortMultipartUpload`
- JWTに`actions`を指定するときは`scope`を併記しない。2026-07-25のstaging検証では、
  同じ親credential、bucket、object pathに対して`actions`単独と`scope`単独は
  `CreateMultipartUpload`と`AbortMultipartUpload`に成功した一方、
  公式例にある`actions`と`scope`の併記はR2から`400 InvalidArgument`で拒否された。
  最小権限を維持するため、広い`object-read-write` scopeではなくaction allowlistを正とする。
- `GetObject`、`HeadObject`、`ListObjects*`、`ListMultipartUploads`、`ListParts`、
  `PutObject`、`CopyObject`、`DeleteObject*`はbrowser credentialへ許可しない。
- source keyは
  `incoming/{owner_hash}/{job_id}/{upload_nonce}/source.{ext}`とする。
  `owner_hash`はserver secretをkeyとしたowner `sub`のHMAC-SHA-256先頭128 bitを
  lowercase hex化する。`upload_nonce`もCSPRNGの128 bitとする。
- D1 admission成功後にだけcredentialを生成し、`CREATED`から`UPLOADING`への
  compare-and-setと`upload_expires_at`保存が成功した場合だけcredentialを返す。
  credential生成に失敗したjobは`FAILED`へ遷移させ、active slotを解放する。
- credential、JWT、一時secret、session tokenはD1、log、IndexedDBへ保存しない。
- multipartのcreate-only条件は利用しない。代わりにsource keyの一意性、D1の
  `source_key` unique制約、exact-object capability、R2 eventとHEADで確定するETag、
  異なるETagを`SOURCE_MUTATED`にする状態遷移を組み合わせる。
- Phase 3のlocal testはJWT claim、署名、派生secret、D1の状態遷移を検証する。
  R2によるaction拒否、exact-object拒否、multipart abort、CORS、event messageは
  staging bucketを使う統合検証項目とし、確認前にproductionへdeployしない。

## Consequences

- browser credentialが漏えいしても、15分間、指定した1 objectのmultipart uploadと
  abort以外には利用できない。
- credential発行にCloudflare API tokenや外向きAPI callが不要になり、Workerには
  bucket限定の親S3 credentialだけを置ける。
- credential有効中の同じsource keyへのmultipart再完了をR2自体では拒否できない。
  ただし異なるETagは処理開始前後を問わずsource mutationとして検出し、処理結果を
  正常完了として公開しない。
- 1 partの`PutObject` fallbackは許可しないため、browser uploaderはファイルサイズに
  関係なく明示的にmultipart APIを使う必要がある。
- Cloudflareが将来Temporary Credentials APIのaction指定または
  `CreateMultipartUpload`のcreate-only条件を提供した場合は、このADRを再評価する。
