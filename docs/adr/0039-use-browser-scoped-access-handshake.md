# ADR 0039: browser-scoped requestでAccess handshakeを行う

## Supersession

後続調査で、custom hostnameの外側Accessに加えてPages Preview Accessの内側applicationが
同じrequestを評価していることを確認した。下記Erratumがcookie bootstrapと解釈したredirect
は、実際には外側Accessの認証成功後に内側Accessが生成したlogin redirectだった。
したがって二段階navigationとcookie-only再入場では解決せず、このDecisionは
[ADR 0041](./0041-authenticate-both-staging-access-layers.md)で置き換える。exact-originへの
credential制限、redirect先での再評価、最終origin検証は維持する。

## Erratum

後続のAccess authentication log調査で、browser-scoped requestとAPI request clientの
どちらもService Tokenを提示し、認証に成功していたことを確認した。失敗に見えた302は
credential拒否ではなく、application domainの`CF_Authorization` cookieを発行した後の
Access team login redirectだった。原因はtransport自体ではなく、このcookie bootstrapを
拒否として扱うか、team originをapplication成功として扱う不完全なredirect状態機械に
あった。

下記Decisionの一段階navigationは、二段階handshakeへ置き換える。最初のapplication
navigationで期待するservice principal cookieが発行されたことを確認し、team originの
contentをapplicationとして使わず、exact application originを明示的に再要求する。その
terminal responseが2xxかつexact application originである場合だけ成功とする。
exact-origin credential制限、最終origin検証、絶対readiness URLは維持する。独立した
fail-fast verifierも同じ状態遷移を
[ADR 0040](./0040-verify-staging-service-auth-before-mutation.md)で共有する。

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
- 最初のnavigation後、terminal originがexact application originまたは設定済みAccess
  team originであり、application domainの`CF_Authorization` cookieとservice principal
  claimが一致することを確認する。cookie確認後にexact application originを明示的に
  再要求し、そのterminal responseが2xxかつexact application originであることを確認する。
- readinessは設定済みexact originとcandidate commitから生成した絶対URLへ送り、
  API固有security headerを持つ応答だけをdata planeの応答として扱う。
- origin不一致、cookie不在、claim不一致、readiness不一致はmedia upload前にfail closedと
  する。credential、cookie、JWT、redirect query、response本文をlogへ出力しない。

この決定はADR 0037のAPI request bootstrapを置き換える。ADR 0030のexact-origin
credential制限と、ADR 0037で追加した最終origin・絶対readiness URL検証は維持する。

## Consequences

- cookie bootstrapで到達したAccess team loginをapplication成功として使わず、検証済み
  cookieを持ってexact application originへ戻る。
- redirect先へcredentialを自動継承せず、hopごとにrouteがoriginを再評価する。
- browser engineまたはPlaywright route semanticsを更新する場合は、exact-origin header
  scope、redirect非継承、最終origin、cookie claimの回帰testを必須とする。
- data-plane readinessが成功するまでR2 upload、Queue、RunPod GPU処理を開始しない。

## Status

Superseded by [ADR 0041](./0041-authenticate-both-staging-access-layers.md).

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [ADR 0037: browser navigation前にAccess sessionを確立する](./0037-bootstrap-access-before-browser-navigation.md)
- [ADR 0040: staging service authをremote mutation前に検証する](./0040-verify-staging-service-auth-before-mutation.md)
- [ADR 0041: stagingの二重Access層を個別に認証する](./0041-authenticate-both-staging-access-layers.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Playwright Route](https://playwright.dev/docs/api/class-route)
