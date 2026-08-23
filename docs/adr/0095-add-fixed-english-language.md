# ADR 0095: Add fixed English transcription language

## Context

利用者が英語音声と把握していても、公開language contractは`ja | auto`だけであり、冒頭の無音や固有名詞に対して
Whisperの自動判定を避けられない。faster-whisperは英語を`en`で指定し、米国、英国、インド、シンガポールなどの
accentごとのlanguage tokenを提供しない。

既存のCloud Run bounded manifest v2はrequested formatをattempt snapshotへ結び付けるが、requested/detected languageを
直接保持しない。またRunPod contract v1 snapshotはD1に存在してもwinning claimへ含まれず、workerが選択言語を実行へ
反映できない。

## Decision

- 公開language contractを`ja | en | auto`の完全一致へ拡張する。方言別tokenとpromptによる綴り誘導は追加しない。
- `ja`と`en`はすべてのinference windowへ明示し、native metadataが固定値と異なる場合はfail closedする。`auto`は最初の
  windowだけ自動判定し、検出値を後続windowへ固定する。
- RunPod contract v1 claimはD1のimmutable execution optionsを返し、legacy workerもlanguageとVADをnative adapterへ渡す。
  Cloud Run contract v2 claimは既存どおり同じsnapshotを返す。
- Cloud Run result manifestをschema v3へ更新し、`requestedLanguage`と`detectedLanguage`を必須にする。固定言語では両値の
  完全一致をschemaとOrchestrator finalizerの両方で検査する。execution contract versionは2のままとする。
- native quality gateは既存Japanese auto fixtureに加えて、固定された非機密English eSpeak fixtureをCUDA/float16で実行する。
- 新candidateのstaging acceptanceはUIで英語を選び、実R2成果物、manifest、通知、cleanupまで`en`を検証する。

## Consequences

- JSON列の既存schemaで値を保持できるためD1 migrationは不要である。
- manifest v3 producerとv3-only finalizerは同じcandidateでdeployする。更新前にactive provider executionをdrainし、旧v2
  producerとの混在を許可しない。
- dependency、runtime、contractが変わるため既存staging evidenceは無効となり、新candidate buildとstaging acceptanceが必要になる。
- accent別accuracy、米英綴り、prompt変更は保証せず、必要なら固定fixtureと事前閾値を持つ別Issueで扱う。

## Status

Accepted
