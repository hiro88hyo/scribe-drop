# ADR 0037: browser navigation前にAccess sessionを確立する

## Context

staging acceptanceのservice token認証自体は成功し、Pages custom domainとAccess
application/policyのread-backも一致していた。一方、browser内の相対`/api/me`は404となり、
同じ時間帯のzone HTTP analyticsには`/api/me`が存在せず、application rootのAccess
redirectだけが記録されていた。Pages Functions invocationも記録されていなかった。

従来のPlaywright helperは、service token header付きの最初のapplication navigationを
browserに行わせ、最終page originを確認せずに成功応答とapplication cookieだけを検証して
いた。その後のreadinessは相対URLだったため、Access team domainにpageが残った場合でも
team domainの`/api/me`を問い合わせ、staging data planeの404と誤分類できた。

[ADR 0030](./0030-scope-access-service-credentials-to-app-origin.md)のexact-origin credential
制限と、Service Authの後続application requestへheaderを継続する要件は維持する必要がある。

## Decision

- browserを開く前に、BrowserContextとcookie jarを共有するAPI request clientでAccess
  sessionを確立する。
- request clientはredirectを自動追跡せず、各responseの`Location`を1 hopずつ解決する。
  redirect先はexact staging application originまたはexact Access team originだけを許可し、
  hop数に上限を設ける。
- `CF-Access-Client-Id`と`CF-Access-Client-Secret`はapplication originへのrequestだけへ
  付与する。Access team originを含むcross-origin redirectへ継承しない。
- terminal responseは2xxかつapplication originでなければ認証成功としない。
- application domainの`CF_Authorization` cookieについて、値を出力せずservice principal
  claimを検証した後にbrowserを開く。
- browser requestではADR 0030どおり、application originだけへservice token headerを
  継続する。redirectを自動継承せず、requestごとにoriginを再評価する。
- application navigation後は現在のpage originがexact staging originであることを必須と
  する。readiness URLは設定済みexact originとcandidate commitから絶対URLとして生成し、
  相対URLを使用しない。
- redirect URL、cookie、JWT、credential、response本文はtest logやartifactへ出力しない。

## Consequences

- Access team domainの成功画面や404をstaging applicationの成功・失敗として誤認しない。
- API request clientとbrowserがcookie jarを共有するPlaywrightの仕様へ依存するため、
  Playwright更新時はredirect、cookie反映、header scopeの回帰testを実行する。
- session確立中も後続browser requestでも、credentialの送信先はexact application originに
  限定される。
- data-plane readiness失敗時はmedia upload、Queue、RunPod GPU処理を開始しない。

## Status

Accepted

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Playwright API testing](https://playwright.dev/docs/api-testing)
