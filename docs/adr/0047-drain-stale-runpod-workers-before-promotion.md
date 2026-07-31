# ADR 0047: RunPod promotion前に旧workerをdrainする

## Context

Pixel M4Aの補助data streamを受理する修正を含むcandidateをstaging endpointへ昇格し、
synthetic M4Aの実service acceptanceは成功した。しかし同じcandidate imageを実Pixel
M4Aへ使用した補助確認では、RunPodが修正前と同じ`INVALID_MEDIA`を返した。

固定image digestをlocalで実媒体へ適用すると受理し、live endpointのtemplateも同じ
candidate digestを参照していた。一方、`serverless get --include-workers`に残った
`EXITED` workerは前candidateのtemplateとimageを参照し、補助確認のjobを処理していた。
ADR 0026はterminal recordを非稼働としてtemplate切替を許可したが、RunPodはそのrecordを
再利用できるため、active判定だけではcandidateを実行したことを保証できない。

固定`runpodctl`の`serverless update --workers-max 0`は成功終了しても0を送信せず、
endpointの値は1のままだった。RunPod公式REST endpoint updateは`workersMax: 0`を受理し、
exact read-backではworker一覧が0件になった。1へ復旧するとcandidate template/imageを
参照するworkerだけが返った。

## Decision

- template切替前にactiveまたは未知状態のworkerがないことを従来どおり検証する。
- candidate templateが既に接続済みでも、terminal workerの`templateId`または
  `imageName`がcandidateと一致しなければpromotionを完了扱いにしない。
- promotionは次の順序に固定する。
  1. RunPod公式REST endpoint updateを1回だけ呼び、`workersMax: 0`にする。
  2. endpoint、template、workerをread-backし、`workersMin=0`、`workersMax=0`、
     worker 0件を確認する。
  3. project固定`runpodctl`でcandidate templateへ切り替える。
  4. `workersMax=0`のままcandidate templateをexact read-backする。
  5. 公式RESTで固定planの`workersMax`へ復旧する。
  6. endpoint設定に加え、全terminal workerのtemplateとimageがcandidateに一致することを
     exact read-backする。
- REST mutationはtimeout、応答喪失、非成功応答のいずれでも自動再試行しない。その直後の
  read-backだけを正とし、不一致なら直前templateとworker上限へrollbackする。
- `runpodctl`はtemplate作成、template切替、read-backの標準経路として維持する。REST例外は
  CLIが表現できないworker上限0への更新だけに限定し、host、method、body、timeoutを固定する。
- staging acceptanceでは実M4A lifecycleの前後にRunPod preflightを実行する。後段は実jobを
  処理したcandidate template/imageのterminal worker recordが1件以上あり、全件一致する
  ことを確認してからacceptance evidenceを発行する。
- production promotionも昇格処理内のdrainに加え、全resource deploy後に同じRunPod
  read-backを行う。
- worker ID、template ID、endpoint ID、image参照、provider応答、credentialをlogや
  acceptance artifactへ保存しない。

## Consequences

- terminal recordが旧imageのまま再利用され、synthetic fixtureだけで誤ってacceptanceが
  成功する経路を閉じる。
- template切替中はworker上限が0になり、新規jobは短時間queueで待つ。旧imageへ割り当てる
  より安全であり、復旧不能ならpromotionを失敗させる。
- promotionにはREST mutationが2回増えるが、いずれもexact read-backとrollbackを持ち、
  mutation retryは増やさない。
- RunPodがworker、0値、省略field、rolling releaseのschemaを変更した場合はfail closedとなり、
  API adapter、回帰テスト、このADRを更新する。
- ADR 0026の「terminal recordを残したままpromotion可能」という判断は本ADRで置き換える。
  terminal status分類自体はactive workerを拒否する前段検証として残る。

## Status

Accepted

## References

- [ADR 0026: RunPodの終了済みworker recordをactive workerと区別する](./0026-classify-runpod-terminal-worker-records.md)
- [ADR 0031: RunPod promotionではread commandだけを再試行する](./0031-retry-only-runpod-read-commands.md)
- [ADR 0032: RunPodの既定template portを自動で正規化する](./0032-automate-runpod-default-port-normalization.md)
- [RunPod REST API: Update an endpoint](https://docs.runpod.io/api-reference/endpoints/PATCH/endpoints/endpointId)
