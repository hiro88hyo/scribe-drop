# Phase 5 staging deployment record

## 状態

Phase 5のstaging end-to-end checkpointを完了した。Access保護済みWebの実browser
uploadからR2 Event Notification、Queue、RunPod、manifest/artifact、5分Cronによる
finalize、Discord通知まで成功した。production environmentへのdeploymentは実施していない。

実account、origin、endpoint、template、registry auth、image参照、credential、job ID、
録音内容、文字起こし本文はこの記録を含む追跡対象へ保存しない。非secret IDを含むplanと
stateはgit ignoredのdirectoryだけに保持する。

## Source

- Branch: `bugfix/bind-worker-global-fetch`
- Orchestrator redirect修正: `ea26bf3`
- RunPod media修正: `eb7c815`
- Wrangler: `4.114.0`
- runpodctl: `2.7.2`
- Deployment time: 2026-07-26 UTC

staging D1にはforward-only migration `0005_reconciliation_completion.sql`をapplication
より先に適用した。OrchestratorとWebのdeployment ID、version ID、URLは追跡対象へ保存せず、
各platformのdeployment historyを正とする。

## 修正と検証

- Cloudflare Workers runtimeが`redirect: "error"`をrequest構築時に拒否することを
  Workerdで再現した。[ADR 0016](../adr/0016-use-manual-redirects-in-workers.md)に従い、
  RunPodとDiscordの外向きrequestを`manual`へ変更し、3xxを自動追従しない。
- 固定FFmpeg 6.1.1の実JSONが空の`programs`を含むことを同一imageで再現した。
  [ADR 0017](../adr/0017-validate-pinned-ffprobe-output.md)に従い、空配列だけをstrict schemaで
  受理し、production media probeを実行するoffline container checkを追加した。
- 修正版imageはnon-root、networkなし、read-only root filesystemのcontainer check、
  Ruff、mypy strict、pytest、secret scan、SBOM、High/Critical vulnerability scanを通した。
  GitHub CIは4 jobすべて成功した。
- fixed digestから新しいServerless template revisionを作成し、portなし、30 GiB
  container disk、volumeなし、固定environmentとprivate registry credentialを検証した。
- endpoint切替前に既存workerと全jobの状態を確認した。切替後も旧imageのOutdated workerが
  requestを処理できることを検出し、active jobがない状態で対象workerだけをterminateした。
- registry credential rotation後、失効credentialで失敗したUnhealthy workerもterminateし、
  新workerのtemplate、image、registry credentialが追跡外plan/stateと一致してから
  end-to-end smokeを再開した。

## End-to-end結果

- 実browser multipart uploadを受理し、R2 Event NotificationとQueue consumerがgeneration 1
  attemptを一意に作成した。
- RunPod submissionはacceptedとなり、新workerがclaimとheartbeatに成功した。
- production media probe、GPU推論、artifact PUT、manifest-lastを通り、RunPod terminalは
  `COMPLETED`、worker outputは`completed`、`manifestWritten`はtrueとなった。
- reconciliationはterminalをD1へ先行保存し、complete manifestと全artifactのkey/sizeを
  検証してjobとattemptを一度だけ`COMPLETED`へ遷移させた。
- D1にはMarkdown、JSON、SRTが各1件だけ保存され、notification outboxは`SENT`となった。
  Discordで通知の受信も確認した。
- 認証済みbrowserから所有者限定artifact APIを呼び、5分のGET capabilityで文字起こし
  artifactを実際に取得できることを確認した。署名URLと本文は記録していない。詳細画面の
  download操作は実装計画どおりPhase 7で追加する。
- submission acceptedからRunPod terminalまで約85秒、Discord送信まで約87秒だった。
  完了は次の5分Cronで回収した。
- application log、RunPod output、CI artifact、追跡対象文書にtoken、署名URL、録音内容、
  文字起こし本文を残していない。

## CLI補償と最終状態

固定`runpodctl`はServerless templateへ追加された既定portを空へ更新できず、
`serverless update --workers-min 0`も成功終了しながら値を変更しなかった。
[ADR 0012](../adr/0012-runpodctl-staging-verification-boundary.md)に従い、Consoleでは既定portの
削除とactive workerを0へ戻す操作だけを行い、直後にCLIで全項目を再取得した。

Consoleでendpointを保存した際にtemplateのregistry credentialが以前の値へ戻ったため、
追跡外planのcredential IDをCLIで再適用した。最終的にactive workers 0、max workers 1、
GPU 1、Network Volumeなし、永続volumeなし、FlashBoot無効、portなし、新imageと新registry
credentialを標準deploy verifierで確認した。

新revisionのpull、end-to-end smoke、active worker 0への復元後、旧templateのregistry
credential参照も新credentialへrotationした。image、environment、ports、disk、volumeが
変わっていないことと旧credentialの参照が0件であることを確認してから、旧RunPod
credentialを削除した。旧GitHub PATは利用者がGitHub上で失効させる。credential原文は
CLI引数、log、ticketへ出さない。
