# ADR 0046: staging browserで二重Access認証をcontext終了まで継続する

## Context

staging Webはcustom hostname側とPages Preview側の二重Access境界を持つ。
[ADR 0041](./0041-authenticate-both-staging-access-layers.md)は、外側用の標準2 headerと
内側用のJSON `Authorization`をexact application originへ継続することを定めた。

しかしbrowser handshake後にrouteを解除し、`CF_Authorization` cookieだけへ切り替える
実装が混入した。headerを継続するread-only verifierはrootと`GET /api/me`で200となる一方、
同じcredentialを使うPlaywrightは`GET /api/me`のAccess redirectをbrowser fetch失敗として
観測した。この差はmedia upload前のreadinessで停止したが、local unit testとCI構造検査が
routeの継続要件を保証していなかった。

## Decision

- PlaywrightのAccess routeはbrowser context作成後にexact application originだけへ登録し、
  context終了まで維持する。
- `CF_Authorization` cookie取得後も、標準2 headerと内側用JSON `Authorization`を同一origin
  requestへ継続する。handshake後に`unrouteAll`でcookie-onlyへ切り替えない。
- callback内でもrequest originを再検証し、redirectは自動追跡しない。R2、Access team
  domain、download先など別originのrequestはroute対象にしない。
- route errorはcredentialを含み得るため、raw errorをlogまたは再throwしない。
- lifecycle cleanup完了後にrouteの新規callback受付を止め、進行中callbackを待ってから
  browser contextを閉じる。contextを先に閉じてcallbackを失敗させない。
- regression testはcookieを含む後続requestにも3 headerが付くことを検証する。
- regression testとCI構造検査はhandshake直後のroute解除と、route drain前のcontext closeを
  拒否する。

## Consequences

- read-only verifierとbrowser acceptanceが同じ二重Access transportを使う。
- credential-bearing callbackはbrowser contextの寿命だけ残るが、exact-origin登録、
  callback内origin検証、redirect非追跡により別originへcredentialを送らない。
- contextを閉じないtestはcredential routeも残すため、全staging testは`finally`でcontextを
  閉じる。
- Access構成を単一境界へ変更する場合も、cookie-onlyへ暗黙に戻さず別ADRと実環境回帰試験を
  必須とする。

## Status

Accepted

## References

- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [ADR 0040: staging service authをremote mutation前に検証する](./0040-verify-staging-service-auth-before-mutation.md)
- [ADR 0041: stagingの二重Access層を個別に認証する](./0041-authenticate-both-staging-access-layers.md)
