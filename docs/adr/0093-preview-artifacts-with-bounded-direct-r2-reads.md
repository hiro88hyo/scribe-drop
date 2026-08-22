# ADR 0093: 成果物を上限付きのR2直接readでプレビューする

- Status: Accepted
- Date: 2026-08-22
- Target release: `0.3.0`
- Relates to: ADR 0005、ADR 0023

## Context

成果物画面はowner検証後に5分間のexact-object GET capabilityを発行し、browser downloadだけを
提供している。利用者が内容を確認するたびにfileを保存して別applicationで開く必要がある。
一方、成果物本文をPages Functions経由でproxyすると、最大128 MiBの機微な文字起こし本文を扱う
新しいserver-side data path、timeout、memory、logging、cache境界が増える。署名URLを永続化したり、
本文をservice workerやbrowser storageへ残したりする設計も許容できない。

R2 CORSへGETを追加することはbrowserからのcross-origin readを可能にするsecurity controlの変更である。
ただしCORS自体はobjectへの権限を付与しないため、owner検証済みAPIが発行する短命な単一object GET
capabilityと組み合わせて初めてreadできる。

## Decision

- browserは利用者がプレビューボタンを押した時だけ既存artifact APIから新しい5分capabilityを取得し、
  `https://<32-hex-account>.r2.cloudflarestorage.com`のexact host patternだけへGETする。
- R2 CORSはenvironmentごとの単一exact Web originに対して、既存`POST`、`PUT`、`DELETE`に`GET`だけを
  追加する。wildcard origin/header、credentialed CORS、`HEAD`、bucket listingは許可しない。
- preview対象はD1のartifact sizeが5 MiB以下のMarkdown、JSON、SRTだけとする。responseの
  `Cache-Control: no-store`、`Content-Type`、`Content-Length`、streaming byte countを期待値と完全一致させ、5 MiBを
  超える前にstreamをcancelする。UTF-8はfatal decodeし、不正encodingを表示しない。
- artifact uploadはR2が正式に対応するsystem metadataとして`Cache-Control: no-store`を保存し、GET capabilityへ
  S3互換表にないresponse overrideを追加しない。browser fetchも`cache: no-store`、`credentials: omit`、
  `redirect: error`、`referrerPolicy: no-referrer`を指定する。
- modalはraw textだけをReact text nodeとして表示し、Markdown/HTMLをrenderしない。native `dialog`で
  focus containment、Escape、初期focus、triggerへのfocus復帰を提供する。
- modalを閉じた時、別request開始時、component unmount時はfetchをabortし、本文stateを破棄する。
  本文と署名URLをCache API、service worker、IndexedDB、localStorage、sessionStorage、DOM attribute、
  log、error、clipboard以外へ保存しない。clipboardへの書込みは明示操作時の本文だけとする。
- 5 MiB超、期限切れ、削除競合、CORS/network failure、encoding/size不一致でも既存download操作は維持する。
- staging acceptanceは実R2からのpreview、clipboard copy、同じbyte列のdownloadをSHA-256で照合する。
  CORS GETとWeb runtime変更を含むため既存staging evidenceは無効とし、新candidateで再検証する。
- staging E2Eは本文、署名URL、request IDを出力せず、capability、URL、fetch、HTTP、metadata、size、encodingの
  安全な失敗分類だけを出力する。分類不能な失敗も明示的に拒否する。

## Consequences

- Pages Functionsへartifact本文を通さず、既存のowner検証とexact-object capabilityを再利用できる。
- browser memoryとDOMにはmodalを開いている間だけ最大5 MiBの本文が存在する。大きい成果物は従来どおり
  downloadで確認する。
- staging/productionのR2 CORS policyは同じ変更を必要とする。environment parity verifierはGET不足、
  追加method/header、wildcard、max-age driftをremote mutation前に拒否する。
- search、syntax highlight、Markdown render、編集、部分copyはこのPhaseに含めない。
