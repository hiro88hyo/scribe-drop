# ADR 0020: cache only public PWA shell assets

## Status

Accepted

## Context

ScribeDropをinstallable PWAにするにはservice workerが必要だが、アプリはAccessで保護され、
API response、job metadata、artifact、文字起こし本文を扱う。通常のcache-first app shell
実装はnavigation responseや認証redirectを保存し、共有端末、session失効後、offline時に
認証済みdataを露出する危険がある。一方でservice workerを登録するだけではoffline時の
挙動と更新境界が不明確になる。

## Decision

- service workerはproduction buildだけでsame-originの`/service-worker.js`を登録する。
- cache対象はhashed `/assets/`と、manifest、icon、offline document/style、logoの
  review済みpublic pathだけにする。
- `/api/*`、artifactを含むpath、cross-origin、non-GETはinterceptしない。
- navigationは常にnetworkへ送り、通信失敗時だけ固定`offline.html`を返す。HTML navigation
  responseはcacheしない。
- static responseもsame-origin、非redirect、`basic`、成功応答を確認してからcacheする。
  Access loginや別originへのredirectは保存しない。
- offline documentにinline script/style/event handlerを置かず、認証済みjob、録音、
  文字起こし本文を端末へcacheしていないことを明示する。
- unit security testと実service workerを使うPlaywrightでcache key/bodyを検査し、
  APIが返したprivate markerがCache Storageに存在しないことを確認する。

## Consequences

- installと静的assetの再利用は可能だが、offlineでjob履歴や成果物は閲覧できない。
- 初回install時にAccess sessionが切れている場合はworker installが失敗し、認証後の次回
  登録/updateで回復する。redirect responseをcacheするより安全な失敗を選ぶ。
- app更新時はcache nameを変更し、activateで旧ScribeDrop cacheを削除する必要がある。
- 将来offline dataを扱う場合は、暗号化だけに依存せず端末脅威、logout purge、key管理、
  retentionを別ADRで決定する。現在のcache allowlistを暗黙に広げない。
