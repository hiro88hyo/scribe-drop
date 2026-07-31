# ScribeDrop 開発標準

このファイルはリポジトリ全体に適用する。プロダクト要件は `docs/spec.md`、実装順序は `docs/implementation-plan.md` を正とする。設計上の矛盾や変更が必要な場合は、暗黙に回避せず `docs/adr/` に ADR を追加する。

## 1. 基本方針

- セキュリティ、所有権検証、冪等性、障害回復を機能追加より優先する。
- 一度に複数 Phase を混在させず、`docs/implementation-plan.md` の Phase 単位で作業する。
- 外部入力は、TypeScript では Zod、Python では Pydantic で境界上にて検証する。
- Cloudflare 固有コード、ドメインロジック、repository、外部 API client を分離する。
- 実装と同じ変更で、必要なテスト、migration、契約、運用文書も更新する。
- secret、token、署名付き URL、録音内容、文字起こし本文をリポジトリ、ログ、テスト結果へ残さない。

## 2. ツールチェーン

### Node.js / TypeScript

- Node.js と package manager の管理には Volta を使い、package manager は pnpm のみを使う。
- Volta の pnpm support を使うため、ローカル環境と CI で `VOLTA_FEATURE_PNPM=1` を設定する。
- root `package.json` の `volta.node`、`volta.pnpm`、`packageManager` に project version を固定し、pnpm の値を一致させる。Corepack、nvm、mise、asdf をこのリポジトリの version 解決に併用しない。
- `pnpm-lock.yaml` をコミットし、CI では `pnpm install --frozen-lockfile` を使う。
- dependency の install script は原則拒否し、必要な package だけを root `pnpm-workspace.yaml` の `allowBuilds` で review 後に許可する。
- TypeScript は全 workspace で strict mode を有効にする。
- `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables` を有効にする。
- formatter は Prettier、lint は ESLint を使う。生成物以外の lint 抑制には理由をコメントする。
- `any`、無根拠な型 assertion、non-null assertion を避ける。避けられない場合は局所化し、理由とテストを追加する。

### Python

- Python 3.12 を使う。
- Python の環境構築、依存追加、lock、コマンド実行、build はすべて uv を使う。
- `pip install`、Poetry、Pipenv、手動の `venv` 作成は使わない。
- 依存関係は `pyproject.toml` と `uv.lock` で管理し、両方をコミットする。
- ローカル実行は `uv run ...`、同期は `uv sync`、CI とコンテナ build は lock を固定して実行する。
- lint と format は Ruff、型検査は mypy strict、テストは pytest を使う。
- public 関数と外部境界には型 annotation を付ける。型検査の除外は対象を限定し、理由を記載する。

### バージョン固定

- Node.js と pnpm は Volta、Python と uv は project 設定および CI でバージョンを固定する。
- JavaScript と Python の直接依存は意図せず浮動しないよう lockfile で固定する。
- Docker base image、FFmpeg、faster-whisper、CTranslate2、model revision を固定する。
- dependency update は機能変更と分離し、test と security scan を通す。
- GitHub Actions は公式 release を確認して full commit SHA に固定し、対応する tag をコメントで残す。floating branch や major tag だけを使わない。

### Platform CLI

- Cloudflare のローカル開発、型生成、D1 migration、resource 操作、deploy には公式 CLI の Wrangler を使う。
- Wrangler は global install せず、root の devDependency にバージョンを固定し、`pnpm exec wrangler ...` または root script から実行する。未固定の `npx wrangler` は使わない。
- Cloudflare の構成は Wrangler 設定と migration を source of truth とし、dashboard だけの未記録変更を作らない。
- RunPod の Serverless endpoint、template、GPU、運用確認には公式 CLI の `runpodctl` を使う。
- `runpodctl` の対応バージョンを deployment 文書と CI で固定し、配布 binary の checksum を検証する。latest install script を無条件に CI で実行しない。
- Gitleaks は `tools/versions.json` に version と配布 binary の checksum を固定し、Git 履歴と作業ツリーの両方を検査する。
- CLI credential と API key はローカルの credential store または CI secret から渡し、リポジトリや shell script に書かない。
- staging と production を明示的に区別し、更新・削除・deploy 前に account、resource ID、environment を確認する。
- application runtime から Wrangler や `runpodctl` を subprocess として呼ばない。実行時の RunPod 連携は型付き HTTP client を使う。

### Staging promotion gate

- runtime、依存、deployment設定、migration、外部service連携へ影響する変更は、同じrelease candidateがstaging acceptanceを通過するまでproductionへdeployしない。
- release candidateは`release/<version>`の単一commitから一度だけbuildし、production用に再buildしない。
- stagingとproductionはresourceとsecretを分離するが、application artifact、RunPod image digest、migration集合は同一candidateを使用する。
- production deployは任意のbranch、commit、image、local buildを入力に取らず、成功したstaging evidenceに紐付くcandidateだけを昇格する。
- code、dependency、migration、deployment設定を変更した時点で既存のstaging evidenceを無効とし、candidateのbuildとstaging acceptanceをやり直す。
- mock E2Eやunit testは実service staging acceptanceの代替にしない。変更経路を固定dummy dataで実R2、Queue、RunPod、成果物downloadまで検証する。
- OSやbrowser固有のfile picker、PWA、offline動作を変更した場合は、対象実機のstaging smokeも必須とする。
- deploy前後に実resourceをread-backし、許可したenvironment固有値以外の構成差分を拒否する。
- staging自動E2EのAccess service principalはADR 0024の完全一致値だけを許可し、credentialをstaging GitHub Environmentに限定する。productionではservice principal設定を拒否する。
- promotion workflowとparity verifierが未実装または失敗している間はproduction deployを行わない。
- 緊急時のgate省略は[ADR 0023](docs/adr/0023-promote-only-staging-verified-artifacts.md)のbreak-glass条件に限定し、明示承認と監査記録なしに実行しない。

## 3. Git-flow

### 長期ブランチ

- `main`: production に出せる release だけを置く。直接開発しない。
- `develop`: 次回 release の統合先。直接コミットせず PR で統合する。

### 作業ブランチ

- `feature/<short-name>`: `develop` から作成し、`develop` へ戻す。
- `release/<version>`: `develop` から作成し、release 修正だけを行う。`main` と `develop` の両方へ merge する。
- `hotfix/<version-or-short-name>`: `main` から作成し、`main` と `develop` の両方へ merge する。
- 必要に応じて `bugfix/<short-name>` と `docs/<short-name>` を `develop` から作成できる。

リポジトリ初期化時だけ、文書と基盤となる最初のコミットを `main` に作成し、そこから `develop` を作成する。それ以降は上記の Git-flow に従う。

### コミットと merge

- Conventional Commits を使う。例: `feat(orchestrator): enforce atomic RunPod claims`。
- 1コミットは1つの論理変更に限定し、生成物や無関係な整形を混在させない。
- `docs/implementation-plan.md` の Phase をまたぐ差分を同じ feature branch に入れない。
- feature branch は CI と review 後に `--no-ff` merge し、Phase の境界を履歴に残す。
- release は SemVer を使い、`main` の release commit に `vX.Y.Z` tag を付ける。
- `main` と `develop` への force-push、共有済み commit の書き換えは禁止する。
- secret や大容量生成物を誤ってコミットした場合は、通常の revert だけで済ませず漏えい対応を行う。

### PR

- PR は目的、設計上の判断、変更範囲、検証コマンド、残課題、関連 Phase/ADR を記載する。
- DB migration、API contract、状態遷移、権限、ログ項目の変更は明示する。
- CI が成功し、未解決の security/authorization 指摘がないことを merge 条件とする。
- review 中の追加修正でも、無関係な変更を同じ PR に含めない。

## 4. アーキテクチャと依存方向

- `packages/contracts` は HTTP、Queue、RunPod、manifest の schema と公開型を管理する。
- `packages/domain` は状態遷移、エラー分類、値オブジェクトなど純粋なロジックを管理し、Cloudflare、AWS SDK、Hono、React に依存しない。
- `packages/observability` はallowlist方式の構造化ログ型とserializerを管理し、任意messageや任意metadataを受け付けない。
- `packages/test-support` は fake、fixture、固定 clock、固定 ID generator を管理し、本番コードから import しない。
- `apps/web` と `apps/orchestrator` は domain が定義する port を adapter で実装する。
- repository だけが D1 の SQL と永続化上の状態遷移を扱う。
- RunPod、R2、Discord、時刻、乱数、ID 発行は interface 越しに利用する。
- 循環依存と app 間の直接 import を禁止する。共有が必要なものは責務を確認して package へ移す。
- transport の request/response 型を domain entity と同一視しない。

## 5. API とデータ

- API、Queue、Webhook、Cron、環境変数、外部 API 応答を信頼せず、利用前に schema 検証する。
- API error は安定した machine-readable code と安全な利用者向け message を返し、内部例外を露出しない。
- ユーザー向け query は repository の SQL 自体に `owner_sub` 条件を含める。
- 状態変更 API は Access JWT、CSRF、Origin、Content-Type、所有権を検証する。
- 日時は UTC の ISO 8601、ID は ULID、byte size は整数で扱う。
- SQL は parameterized query を使う。ユーザー入力を SQL 文字列へ連結しない。
- 状態更新は期待 status、version、active attempt を条件にした compare-and-set とする。
- migration は forward-only とし、適用済みファイルを書き換えない。修正は新しい migration で行う。
- 破壊的 migration は複数 release に分割し、rollback 可能性を文書化する。
- D1、R2、Queue の命名と binding は local、staging、production で分離する。

## 6. エラー処理と冪等性

- HTTP timeout は失敗確定とみなさず、「結果不明」を表現して回復処理へ渡す。
- Queue、Webhook、Cron、upload-complete、claim、delete は複数回実行されても安全にする。
- broad catch で例外を握りつぶさない。retryable、permanent、conflict、cancelled を分類する。
- 外部 API retry は timeout、上限、指数 backoff、jitter を明示する。
- RunPod submission、winner claim、finalize、notification outbox は一意制約と条件付き更新で競合を制御する。
- manifest がない attempt、一部 artifact しかない attempt、loser、stale generation を完了扱いにしない。
- 補償処理と cleanup も冪等にする。

## 7. セキュリティ

- `.dev.vars`、`.env`、credential、実 ID はコミットしない。example ファイルには dummy 値だけを置く。
- Access JWT はすべての `/api/*` で再検証し、ユーザー識別には `sub` を使う。
- token 原文は一度だけ返し、D1 には cryptographic hash だけを保存する。
- presigned URL は object、method、有効期限を最小化し、ブラウザや RunPod に長期 R2 credential を渡さない。
- URL は HTTPS と host allowlist を検証し、原則 redirect を拒否する。
- ファイル種別、stream、duration、size は ffprobe と streaming byte count で再検証する。
- subprocess は引数配列で起動し、shell interpolation を使わない。
- 一時ファイルは `/tmp` の task 固有ディレクトリだけに作り、`finally` で削除する。
- application log は構造化 JSON とし、秘密値、URL query、本文、メールアドレス原文を含めない。
- security 制御を緩める変更には ADR、脅威分析、回帰テストを必須とする。

## 8. テスト標準

- 変更した振る舞いには同じ PR で自動テストを追加する。不具合修正では先に再現テストを追加する。
- unit test は外部サービス、ネットワーク、実時刻、非決定的乱数に依存させない。
- Cloudflare Workers は Vitest integration、Web の利用者フローは Playwright、Python は pytest を使う。
- 外部 API は port の fake または HTTP mock で差し替え、通常 CI から実サービスを呼ばない。
- 認証、CSRF、所有権、状態遷移、claim、finalize、outbox は全分岐をテストする。
- duplicate、out-of-order、timeout、partial failure、stale attempt、concurrent finalize を必須ケースとする。
- snapshot test だけで重要な振る舞いを保証しない。状態、応答、永続化、副作用を明示的に検証する。
- fixture に token、署名 URL、録音内容、実ユーザーデータを含めない。
- flaky test を単純に retry して隠さず、原因を修正する。

標準検証コマンドは、基盤実装後に root script として統一する。

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm d1:verify
pnpm ci:verify
pnpm test:e2e

uv sync --project apps/runpod-worker --frozen
uv run --directory apps/runpod-worker ruff check .
uv run --directory apps/runpod-worker ruff format --check .
uv run --directory apps/runpod-worker mypy --strict src tests
uv run --directory apps/runpod-worker pytest
```

## 9. 文書化と ADR

- architecture、deployment、Access、RunPod、operations、threat model は実装と同じ PR で更新する。
- ADR は `docs/adr/NNNN-short-title.md` とし、Context、Decision、Consequences、Status を含める。
- 外部サービスの制約、security trade-off、schema の設計書からの変更、Git 運用の例外は ADR に残す。
- 一時的な回避策には owner ではなく、除去条件、期限または追跡 issue を記載する。
- コードから明らかな処理をコメントで繰り返さず、理由、制約、危険な前提を記録する。

## 10. CI と Definition of Done

CI では最低限、次を実行する。

- lockfile を使った再現可能な install
- format check
- lint
- TypeScript と Python の型検査
- unit/integration test
- production build
- migration の新規 DB 適用テスト
- secret scan
- dependency と container vulnerability scan
- E2E（実行時間に応じて PR 必須 suite と nightly suite を分離可能）

作業完了とする前に、以下をすべて満たす。

- 対象 Phase の受け入れ条件を満たしている。
- 正常系だけでなく、認可、重複、競合、timeout、partial failure を検証している。
- lint、型検査、test、build が成功している。
- migration、contract、実装、文書が同期している。
- production対象の変更では、同一candidateのstaging acceptance evidenceとartifact digest照合が成功している。
- ログと成果物に機密情報が含まれないことを確認している。
- 未解決事項、手動設定、運用上の注意を明示している。
- 設計との差異が ADR に記録されている。

container scan は scan 対象の Dockerfile と固定 image が存在する Phase から必須とする。それ以前は secret scan と JavaScript/Python dependency audit を必須とし、空の container scan を成功扱いにしない。
