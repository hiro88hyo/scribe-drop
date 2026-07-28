# ADR 0039: browser-scoped requestでAccess handshakeを行う

## Context

[ADR 0037](./0037-bootstrap-access-before-browser-navigation.md)は、browser navigation前に
BrowserContextのAPI request clientでAccess sessionを確立することを定めた。しかし実際の
staging acceptanceでは、service token headerを持つAPI requestがapplication originから
Access team loginへredirectされ、team originの2xxで終了した。credential、cookie、URL
queryを記録せずに設けたorigin検査がこれを検出し、media upload前に停止した。

同じservice tokenとPolicyを使う直前のbrowser-scoped handshakeは、application domainの
`CF_Authorization` cookieを発行し、そのservice principal claim検証まで成功していた。
CloudflareのService Token仕様も、保護対象applicationへの初回requestにclient headerを
付けてapplication-scoped cookieを得る経路を定めている。したがって今回の失敗はPolicyや
tokenではなく、動作確認済みのbrowser requestからAPI request clientへtransportを変更した
ことによる回帰である。

一方、従来のbrowser実装には最終page originを検査せず、相対`/api/me`を送る欠陥があった。
browser handshakeへ戻すだけではAccess team originの404をstaging APIの応答と誤認し得る。

## Decision

- Access handshakeはPlaywrightのbrowser page navigationで行い、API request clientによる
  事前redirect追跡は使用しない。
- navigation前にBrowserContext routeを登録する。request URLがexact staging application
  originの場合だけ`CF-Access-Client-Id`と`CF-Access-Client-Secret`を付与する。
- application requestは`route.fetch`のredirect自動追跡を0にし、responseをbrowserへ返す。
  browserが次のhopをrequestした時点でoriginを再評価するため、Access team originやその他の
  cross-origin requestへcredentialを継承しない。
- non-application requestからcredential headerを除去する。redirect先を問わずcredentialを
  application origin外へ送らない。
- navigationのterminal responseが2xxであり、最終page originがexact staging originである
  ことを確認した後に、application domainの`CF_Authorization` cookieとservice principal
  claimを検証する。
- readinessは設定済みexact originとcandidate commitから生成した絶対URLへ送り、
  API固有security headerを持つ応答だけをdata planeの応答として扱う。
- origin不一致、cookie不在、claim不一致、readiness不一致はmedia upload前にfail closedと
  する。credential、cookie、JWT、redirect query、response本文をlogへ出力しない。

この決定はADR 0037のAPI request bootstrapを置き換える。ADR 0030のexact-origin
credential制限と、ADR 0037で追加した最終origin・絶対readiness URL検証は維持する。

## Consequences

- stagingで実績のあるbrowser transportを使いながら、Access team loginや外部redirectを
  application成功として扱わない。
- redirect先へcredentialを自動継承せず、hopごとにrouteがoriginを再評価する。
- browser engineまたはPlaywright route semanticsを更新する場合は、exact-origin header
  scope、redirect非継承、最終origin、cookie claimの回帰testを必須とする。
- data-plane readinessが成功するまでR2 upload、Queue、RunPod GPU処理を開始しない。

## Status

Accepted

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [ADR 0037: browser navigation前にAccess sessionを確立する](./0037-bootstrap-access-before-browser-navigation.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Playwright Route](https://playwright.dev/docs/api/class-route)
