# ADR 0005: WebとAPIのresponse security policyを分離する

- Status: Accepted
- Date: 2026-07-25

## Context

ScribeDropはCloudflare PagesでReactの静的assetを配信し、Pages Functionsで`/api/*`を処理する。Pagesの`public/_headers`は静的assetには適用されるが、Pages Functionsが生成するresponseには適用されない。そのため、片方だけにsecurity headerを定義すると、画面またはAPIのどちらかが保護されない。

Web UIは外部script、外部font、広告、analyticsを必要としない。一方、Phase 3ではbrowserからR2 S3 endpointへ直接multipart uploadするため、CSPの`connect-src`にはenvironmentごとに異なるR2 account hostを許可する必要がある。

## Decision

### 静的Web asset

- `apps/web/public/_headers`を静的response headerのsource of truthとし、Vite buildで`dist/_headers`へそのままコピーする。
- CSPは`default-src 'none'`から開始し、必要なdirectiveだけを許可する。
  - `script-src 'self'`と`style-src 'self'`とし、`unsafe-inline`、`unsafe-eval`、外部CDNを許可しない。
  - `connect-src`は`'self'`と`https://*.r2.cloudflarestorage.com`だけを許可する。
  - `frame-ancestors 'none'`、`frame-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`とする。
  - font、image、manifest、workerは同一originだけを許可する。
- `X-Frame-Options: DENY`をCSPの旧browser向け多層防御として併用する。
- `Cross-Origin-Opener-Policy: same-origin`と`Cross-Origin-Resource-Policy: same-origin`を付ける。Cross-Origin Embedder Policyは、将来のdownloadやbrowser互換性へ影響するため現時点では有効化しない。
- `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、機能をallowlist化した`Permissions-Policy`を付ける。
- Pagesが静的assetへ既定で付ける`Access-Control-Allow-Origin: *`を削除する。
- hash付き`/assets/*`だけを1年間immutable cacheとし、`index.html`とmanifestは再検証させる。
- CSP report endpointはまだ設けない。違反reportにURLや利用者情報が混入し得るため、受信・保持・redaction方針を定義してから導入する。

### Pages Functions API

- `apps/web/functions/api/_middleware.ts`で全`/api/*`responseを包み、静的`_headers`へ依存しない。
- API responseは`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`と`default-src 'none'`のCSPを必ず持つ。
- downstream handlerが誤って付けたCORS response headerを共通境界で削除する。credential付きCORS、wildcard CORS、cross-origin preflightを提供しない。
- clientのrequest IDを信用せず、`crypto.randomUUID()`で生成したrequest IDをdata contextと`X-Request-ID`へ渡す。
- 未処理例外は安全な`500 INTERNAL_ERROR`へ正規化し、例外message、stack、token、URL、PIIをresponseまたはlogへ含めない。logは共通のallowlist serializerを使う。
- 未実装routeと未知routeは安全なJSON `404 NOT_FOUND`を返す。

### Test

- Pages FunctionsをWranglerで実際のWorkerへcompileし、Cloudflare Workers Vitest integrationとMiniflareで統合テストする。
- testでは静的`_headers`、Functions middleware、exception normalization、CORS header除去を検証する。
- `@cloudflare/vitest-pool-workers`が依存するMiniflareの公開型には、現在、単体では解決できないbundle内参照が含まれる。このため`skipLibCheck`はtest/config専用tsconfigだけで有効にする。clientとFunctionsの型検査は引き続き`skipLibCheck: false`で行う。

## Consequences

- XSSが成立しても任意の外部scriptを追加しにくく、clickjacking、MIME sniffing、referrer漏えいを多層で抑制できる。
- inline script、inline style、外部font、analyticsを追加する変更はCSPで停止する。必要性をreviewし、nonceまたはhashを優先してpolicyとtestを同じ変更で更新する。
- `*.r2.cloudflarestorage.com`はaccount単位より広い許可である。静的`_headers`をstagingとproductionで共有しつつ直接uploadするためのtrade-offとして受け入れ、temporary credentialをbucket・object・method・期限へ限定する。将来custom R2 domainまたはenvironment別header生成へ移行できればhostを狭める。
- manifestは用意するが、service workerはまだ登録しない。導入時はapp shellだけをcacheし、`/api/*`、job data、文字起こし本文をCache Storageへ保存しない。
- Viteの開発serverだけではPagesの`_headers`とFunctions middlewareを再現しない。security headerの正確な確認にはWorkers統合テストまたはWrangler Pages local serverを使う。

## References

- [Cloudflare Pages: Headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages: Middleware](https://developers.cloudflare.com/pages/functions/middleware/)
- [Cloudflare Workers: Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Vite: Building for Production](https://vite.dev/guide/build)
