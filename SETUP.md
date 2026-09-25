# 更新・復旧の手順

初回のBot・本人ID・会話allowlistは [README](README.md) を参照してください。

1. `/codex status` で保留と実行中の有無を確認します。保留は更新後も自動再開するので、古くなった指示は `/codex retract` で先に撤回してください。不明な送信はDesktop側で確認します。
2. **このbridgeだけ**を起動したターミナルで `Ctrl+C` して止めます。Codex Desktopや他の会話を終了させる必要はありません。
3. 停止中に `.env`・`bridge.config.json`・`data/` を非公開のローカル保管先へバックアップします。GitHubへ追加しません。
4. `git pull --ff-only`、`npm ci`、`npm run build`、`npm test` を実行します。ローカル変更と競合する場合は上書きせず差分を確認してください。
5. `allowedThreadIds`、`plainTextChannelIds`、本人IDを再確認し、`npm start` で1プロセスだけ起動します。新しいslash commandも起動時に登録されます。

DBにclaim lease・送信開始時点と待機状態が追加されます。更新前の `sending` は判別できないため `uncertain` として扱います。新形式で開始要求**前**と証明できる期限切れclaimのみ `pending` に戻します。開始要求後は、認証が復旧しても再送しません。旧版へ戻す場合は停止してバックアップしたDBも戻し、実行済み指示の再送に注意してください。

## 状態と制御

| 表示 | 意味・次の操作 |
| --- | --- |
| pending | SQLiteに保存済み。現turnの終了と認証・上限・接続の復旧後にFIFOで1件ずつ開始 |
| sending | 開始要求中。通常は30秒以内に結果が分かる。leaseは120秒 |
| uncertain | タイムアウト・切断などで結果不明。後続も止める。Desktopで確認して `/codex retract` |
| auth / usage | 投稿を失敗扱いせず保持。Desktopのサインイン復旧・利用上限リセットを待つ |
| connection / desktop | 接続の再確認待ち。Codexを同じPCで開いているか確認 |

`/codex retry` は次回の再確認を早めるだけで、送信済み・結果不明の投稿を再実行しません。`/codex retract` は不明な受付があれば先に1件、それ以外は最新の保留を撤回します。既に動いたCodexの操作は元に戻りません。操作は設定したcontrollerだけに許可されます。

認証はCodex管理のものを使い、Botトークンの再発行、Codex logout、認証情報の取り出し、使用枠の購入は行いません。API key/custom providerではCodexのChatGPT利用枠が存在しないことがあります。ChatGPT認証の利用枠を取得できない場合は、安全のため接続待ちとします。

監視周期10秒、失敗時は指数バックオフ＋jitter（約4秒〜6分）、利用枠が尽きている場合はreset時刻を待ちます。通知は会話ごとに5分以上間隔を空けます。現turnをsteer/interruptして割り込ませません。自動復旧は安全な保留だけが対象で、既存の `failed` / `sent` / `retracted` は再送しません。

`startupBackfill.maxCodexMessages: 0` は昔のCodex履歴の公開を防ぐ設定です。キュー復旧のために増やさないでください。`retention.maxTurnsPerThread: 0` はミラー済みの会話を残す設定です。通常の再探索はliveイベントの読み取り位置を飛ばしません。明示的なcleanは履歴を削除します。

## 検証

```powershell
npm run build
npm run check
npm test
node --test dist/test/queueRecovery.test.js dist/test/local-no-history.test.js
node --test scripts/token-entry.test.mjs
```

Desktop内部IPCは安定APIではありません。owner発見や認証probeだけでは実際のターン開始・返信ミラーまでは保証しないため、更新後の本人による短い投稿で確認してください。bridgeは投稿を勝手に生成して試しません。OS常駐・自動起動は含みません。
