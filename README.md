# ScribeDrop

Cloudflareとzero-scale GPU runtimeを利用する、非公開の録音文字起こしWebアプリケーション。
productionではGoogle Cloud Run JobsのL4 GPUを使用し、RunPod Serverless経路はrollback互換のため保持している。

## Features

- Cloudflare AccessによるGoogleアカウント認証
- PC・スマートフォンからprivate R2へのmultipart upload
- QueueとOrchestratorによる非同期処理、進捗・処理時間の表示、キャンセルと削除
- faster-whisper `large-v3-turbo`によるCUDA/float16文字起こし
- Markdown、JSON、SRT成果物のdownload
- 5 MiB以下の成果物をbrowser内でraw text previewし、明示操作でclipboardへcopy
- 完了・失敗時のDiscord通知
- 冪等なsubmission、finalize、notification outbox、cleanupと、provider resourceの自動収束

previewはMarkdownをHTMLとしてrenderしない。owner検証後の短命GET capabilityだけを使用し、
`no-store`、redirect拒否、format別`Content-Type`、UTF-8、bounded streaming byte count、D1記録sizeとの
一致を検証する。本文や署名付きURLはlog、service worker、browser storageへ保存しない。previewが利用できない場合も
downloadは維持する。

## Architecture

```text
Browser
  -> Cloudflare Access
  -> Pages / Pages Functions
  -> private R2 multipart upload
  -> R2 Event Notification / Queue
  -> Orchestrator Worker / D1
  -> Cloud Run GPU Controller
  -> Cloud Run Jobs L4 / faster-whisper
  -> private R2 artifacts / Discord notification
```

Cloud Run実行は有限の件数・費用・期限を持つauthorizationで制限し、処理後はJob、Execution、一時storageを
残さない。stagingで受け入れた同一candidateだけをproductionへ昇格する。

## Development

Node.jsとpnpmはVoltaで固定し、Python 3.12環境と依存関係はuvで管理する。

```bash
export VOLTA_FEATURE_PNPM=1
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

環境構築と個別commandは[ローカル開発環境](docs/development.md)を参照する。credential、secret、実データは
repositoryやtest outputへ保存しない。

## Documents

- [設計・実装指示書](docs/spec.md)
- [RunPod追加security要件](docs/additional-spec.md)
- [実装計画](docs/implementation-plan.md)
- [ローカル開発環境](docs/development.md)
- [環境変数とbinding](docs/environment-variables.md)
- [Cloudflare Access](docs/cloudflare-access.md)
- [継続的インテグレーション](docs/continuous-integration.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [開発標準](AGENTS.md)
