# codex-mobile — DiscordからCodexと会話する

[NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile) をベースにした、**非公式・実験的な改善fork**です。OpenAIやDiscordの公式製品ではなく、上流作者による保証・推奨を示すものでもありません。

同じWindows PC上で動くCodexとDiscordをつなぎ、専用チャンネルから指示し、返答や対応可能な承認要求を受け取ります。このforkでは、明示的に許可した通常投稿、受付・実行中のリアクション、会話履歴の保持を追加しました。

> An unofficial Windows-first fork of codex-mobile: opt-in, single-controller Discord conversation input, source-linked status reactions, and configurable history retention. Codex and the bridge stay on your own running PC. See the [English setup guide](README.en.md).

## 誰向け？

- 自分のPC上のCodexを、スマートフォンのDiscordから確認・操作したい人
- 自分だけが操作できる専用チャンネルで、会話履歴も残したい人
- Bot・権限・ローカル設定を自分で管理できる人

PC、Codex Desktop、連携プロセスの起動が必要です。クラウド常駐サービスではありません。共有・公開サーバーでの運用、複数人による共同操作、企業向けの強固な権限管理には向きません。

## このforkの変更点

- **通常投稿はopt-in**：初期状態は従来の `/codex send`。設定した本人・サーバー・チャンネル・Codex会話に限り、新しい文字投稿を既存キューへ送れます。
- **正確な受付・実行表示**：元投稿に 📨（キューへ保存済み）、🤔（対応するターンの開始確認済み）。完了・中断後はBot自身の 🤔 だけを外し、📨 は残します。
- **重複実行を防止**：DiscordメッセージIDをSQLiteに保存し、重複配信や再起動時の二重受付を防ぎます。自分自身のBot投稿には反応しません。
- **会話履歴を保持**：`retention.maxTurnsPerThread: 0` で既にミラーした会話と今後の返答を自動削除しません。
- **過去履歴を取り込まない選択**：`startupBackfill.maxCodexMessages: 0` なら起動時の過去メッセージ・構造イベントを送らず、現在位置を確定できない場合も公開せずに止めます。
- **Desktop互換性**：開始要求のIPC v2形式に対応。送信失敗時に別の経路へ勝手に再送しません。明示的に許可した既存会話は、更新日時が古くても接続対象になります。
- **認証・利用上限からの復旧**：実行前にCodexの認証と利用枠を確認し、利用できない間も投稿をSQLiteへ保持します。復旧後に安全な保留分を自動再開します。
- **キュー監視**：10秒ごとに再確認し、開始結果が不明な投稿は自動再送せず隔離します。`/codex status`・`retry`・`retract` で確認・制御できます。
- **任意のローカルトークン入力画面**：チャットにトークンを貼らず、PC内の一時ページから `.env` へ保存できます。

プリセットの既定値は変えていません。通常投稿は無効、履歴保持は直近2ターンです。使う範囲と保存方針を設定してから起動してください。

## セットアップ

### 前提

- Windows、Node.js 24以上、Git
- このPCでサインイン・動作確認済みのCodex DesktopまたはCodex CLI
- 自分で管理する、閲覧者を限定したDiscordサーバーとBot

```powershell
git clone https://github.com/ymnshin/codex-mobile.git
cd codex-mobile
npm ci
npm run build
```

lockfileに固定した依存を新規導入します。install-scriptの承認を要求するnpm 12.1.0では、`package.json` の `allowScripts` が、SQLiteの `better-sqlite3@12.9.0` と開発用の `esbuild@0.27.7` だけを許可します。この承認方式でないnpmでは追加手順は不要です。依存更新時はスクリプトを再確認し、全パッケージの一括許可はしないでください。許可前に導入してnative依存が不足した場合は、対象を確認して `npm rebuild better-sqlite3 esbuild` で再構築できます。

### Botと接続情報

[English setup guideの画面付き手順](README.en.md#detailed-guide) に沿って、次を設定します。上流の `npm run init` ウィザードも利用できます。ウィザードと `npm run doctor` は権限確認のため一時カテゴリ・チャンネル・スレッド・投稿を作成し、削除します。

1. 専用サーバーを用意し、DiscordのDeveloper ModeでサーバーIDを取得。
2. [Developer Portal](https://discord.com/developers/applications) でアプリとBotを作成し、アプリIDを取得。
3. `bot` と `applications.commands` のスコープでBotを招待。必要な権限は英語ガイドを参照し、Administratorを一括付与する運用は避けます。
4. 操作する**自分のDiscordアカウントのユーザーID**を取得。アプリ所有者IDや表示名を代用しません。
5. `.env.example` を `.env` にコピーし、接続情報をローカルで記入します。

```dotenv
DISCORD_BOT_TOKEN=<ローカルで記入するBotトークン>
DISCORD_APPLICATION_ID=<アプリID>
DISCORD_GUILD_ID=<専用サーバーID>
DISCORD_CONTROLLER_USER_ID=<実際に投稿する本人のユーザーID>
CODEX_COMMAND=codex
CODEX_APP_SERVER_LISTEN_URL=stdio://
```

Desktop中心なら、ウィザード実行**前**に `.env` の `CODEX_APP_SERVER_LISTEN_URL=stdio://` を設定しておくと、グローバルのCodex CLIランチャーを書き換えません。従来のローカルWebSocket設定では、Windows CLIを `--remote` で接続するためランチャーを調整します。`stdio://` ではそのCLI remote機能は使えません。詳しくは[英語ガイド](README.en.md#commands)を参照してください。

トークンはDiscord、Codexの会話、Issue、スクリーンショットに貼らないでください。入力が難しい場合は `.env` を作成後に次を実行できます。

```powershell
node scripts/token-entry.mjs
```

表示された `http://127.0.0.1:.../` を**同じPC**のブラウザーで開いて入力します。保存先はこのリポジトリの `.env` のBotトークンだけで、他の設定を保持します。サービスは保存後または15分後に終了します。外部APIには送信せず、Botも起動しません。`.env` 自体は暗号化されないためPCのアカウント・ファイル権限で保護してください。

### 起動前に対象の会話を限定する

`bridge.config.json` を作成します。以下の `YOUR_CODEX_THREAD_ID` は実際のCodex会話IDへ置き換えてください。空の `allowedThreadIds` は全体の自動探索を許可するため、この例を意図なく空にしないでください。

```json
{
  "preset": "recommended",
  "discovery": { "allowedThreadIds": ["YOUR_CODEX_THREAD_ID"] },
  "messageWriteBacks": { "plainTextChannelIds": [] },
  "visibility": {
    "userMessages": true,
    "thinkingMessages": false,
    "finalMessages": true,
    "commands": false,
    "fileEdits": false
  },
  "startupBackfill": { "maxCodexMessages": 0 },
  "retention": { "maxTurnsPerThread": 0 }
}
```

会話IDはCodexの会話URLなどで確認できます。ローカルの `npm run inspect:codex` も利用できますが、出力には個人の会話情報が含まれ得るため公開しないでください。

### 開始・停止

```powershell
npm run doctor
npm start
```

作成された専用会話チャンネルで、設定した本人が `/codex send text:...` を使えます。停止は起動したターミナルで `Ctrl+C`。Windowsの自動起動やサービスは登録しません。設定変更後は停止して再起動します。同じ設定・データベースで二重起動しないでください。

## 通常投稿で会話する

最初に `/codex send` の送受信と、接続された会話を確認してください。その後、次の順序で有効化します。

1. Developer PortalのBot設定で **Message Content Intent** をONにします。通常投稿の本文を読むための権限で、スラッシュコマンドだけなら不要です。[Discord公式説明](https://docs.discord.com/developers/events/gateway#message-content-intent)
2. Botにそのチャンネルの **View Channel / Send Messages / Read Message History / Add Reactions** を許可します。リアクションはBot自身のものだけを更新します。[Discord公式説明](https://docs.discord.com/developers/resources/message#create-reaction)
3. Botが作成した**専用の通常テキストチャンネルID**を、既存の `messageWriteBacks` 内に追加して再起動します。以下はダミーIDです。

```json
"messageWriteBacks": {
  "plainTextChannelIds": ["1111111111111111111"]
}
```

`discovery.allowedThreadIds` に明示的に登録された会話との対応も必要です。一般チャンネルや他のタスクを勝手に対象にする設定ではありません。

- 本人の**新しい文字投稿**だけがキューに入り、今実行中のターンは中断しません。
- 他のユーザー、Bot、Webhook、システム投稿、DM、他サーバー、許可外チャンネル、子スレッド、編集、過去投稿は受け付けません。
- 添付・スタンプを含む投稿は転送せず、文字だけで送り直す案内を返します。ファイルを自動ダウンロードしません。
- 📨 は永続キューへの受付済み。🤔 はその投稿に対応するターンの開始が確認できた場合のみ付きます。表示はベストエフォートで、権限不足・削除済み投稿・API障害でも指示の処理を止めません。
- 完了時はBot自身の 🤔 を外します。起動前の投稿への反応をまとめて再生しません。開始・完了のイベントを失った場合やAPI失敗時、表示が残る場合があります。
- `/codex send` は引き続き使えます。認証・上限・開始前の接続不良では受付済み投稿を保持して自動再確認します。開始後のタイムアウトなど**実行結果が不明な場合は再送しません**。同じ内容を新しく投稿する前にPCで実行状況を確認してください。

無効化は `plainTextChannelIds` を空配列に戻して再起動します。

## 認証切れ・利用上限・メッセージ詰まり

`/codex status` は `pending`（保留）・`sending`（開始要求中）・`uncertain`（実行結果不明）の件数、待機理由、最後の失敗分類、次の再確認予定を表示します。操作できるのは設定した本人だけです。

- `auth`：Desktop側の認証復旧待ち。ChatGPT管理認証の更新はCodex自身に任せ、必要な再確認で `account/read(refreshToken: true)` を使用します。ログアウトやトークン再発行は行いません。
- `usage`：利用枠のリセット待ち。枠が回復すると順番に再開します。クレジット購入・リセット消費は行いません。
- `connection` / `desktop`：通信・利用状況・Desktop会話の接続先を再確認します。毎回の開始前に新しいDesktop ownerを取得し、更新後の古い接続先を使い続けません。
- `uncertain`：送信が実行されたか不明です。後続も止めて重複を防ぎます。PCで確認し、`/codex retract` で不明な受付を撤回します。既に実行された作業を取り消す操作ではありません。

`/codex retry` は待機条件を今すぐ再確認しますが、不明・送信済みの投稿は再送しません。通常の `/codex retract` は最新の保留を撤回し、不明な受付がある場合は先にその1件を取り除きます。再確認は指数バックオフ＋ランダムな待ち時間（通常約4秒〜6分）、待機通知は会話ごとに最大5分に1回です。

PCの停止・スリープ中には実行できません。OS自動再起動は追加していません。更新手順は [SETUP.md](SETUP.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## 履歴を残す設定と、過去履歴の公開は別

| 設定 | `0` の意味 | プリセット既定値 |
| --- | --- | --- |
| `retention.maxTurnsPerThread` | 既存・今後のミラー済み会話をターン数で自動削除しない | `2`：直近2ターンだけ残す |
| `startupBackfill.maxCodexMessages` | 起動時に過去のCodex履歴を取り込まない | `20` |

上の設定例は「昔の会話を新たに公開せず、これからの対話を残す」組み合わせです。無期限保持では保存量も増えます。既に削除されたDiscord投稿は復元しません。ステータスカード・承認カードは従来どおり更新・期限切れ処理を行います。

**履歴を残したい場合、停止のたびにcleanしないでください。** `npm run clean`、`/codex cleanid`、`/codex cleanall` は明示的な削除操作です。チャンネルの手動削除や複数会話運用時のチャンネル数上限などから保護するバックアップ機能ではありません。

## 安全性と確認範囲

- **自分専用の非公開サーバーを推奨。** 操作のallowlistは、チャンネルを閲覧できる人を制限しません。Discordへ送った本文はPCの外へ出ます。
- Codexの権限・承認を回避しません。設定した本人からの入力はCodexに作業を依頼できるため、そのDiscordアカウントとPCを保護してください。
- `.env`、実運用の `bridge.config.json`、SQLite、ログ、会話履歴、認証ファイルをGitへ追加しないでください。秘密のマスクはベストエフォートです。
- Windowsでのローカル動作とテストを確認した実験的実装です。macOSのDesktop連携・Linux・マルチユーザー運用は、このforkでは未検証です。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server) は公式の統合用インターフェースですが、**Desktop会話を操作する内部IPCとセッションログ形式は安定APIではありません**。Desktop更新で壊れる可能性があります。開始要求はv2形式を使用し、旧形式や別app-serverへの自動フォールバックはしません。
- 反応や返答の表示だけで、あらゆる承認経路の実機検証済みとは判断しないでください。重要な操作はPC側でも確認してください。

詳細は [SECURITY.md](SECURITY.md)。機密情報を含むログや脆弱性の詳細を公開Issueに貼らないでください。

## 開発・テスト

```powershell
npm ci
npm run build
npm run check
npm test
node --test scripts/token-entry.test.mjs
```

通常投稿の拒否条件とID重複、キュー・開始の分離、正しい元投稿だけへの反応、再起動、履歴保持、過去履歴非公開、IPCリクエスト形式を自動テストします。実際のDiscord送受信はBotと本人の入力による別の実機確認です。テストは本番トークンや実運用IDを使いません。

GitHub Actionsは上流同様に手動実行のみです。自動CIが通ったことを示すバッジや保証は付けていません。

復旧テストは `node --test dist/test/queueRecovery.test.js`。認証切れ→復旧、利用上限、通知抑制、欠落した完了イベント、再起動時のclaim lease、FIFO、曖昧な開始要求を自動再送しないことを検証します。`startupBackfill: 0` の再探索でもlive返答を読み飛ばさない回帰テストも含みます。

2026-09-26の復旧更新は、同じWindows/Node環境で build・typecheck・全474テスト（復旧11件を含む）が成功し、自然終了exit 0を確認しました。Discord/Codex認証とDesktop ownerの読み取りprobeも別途確認しています。新しい本人投稿によるターン開始・返答は運用時のE2E確認です。

公開準備時のローカル検証：Windows / Node.js 24.19.0 / npm 12.1.0の新規依存導入で、build・typecheck・全459テスト・トークン入力4テストが成功しました。`npm test` は集計後に終了まで少し待つ場合がありますが、強制終了せずexit 0を確認しています。ファイル別の `node --test --test-concurrency=4 "dist/test/*.test.js"` も全459件成功・自然終了を確認しました。これはその環境の検証結果で、他のPCや将来のDesktop版を保証しません。

## 出典・ライセンス

- 上流：[NathanZane/codex-mobile](https://github.com/NathanZane/codex-mobile)
- ベース：[`f79e6807ca0b9d6052afd24f822ee41b9a52e07d`](https://github.com/NathanZane/codex-mobile/commit/f79e6807ca0b9d6052afd24f822ee41b9a52e07d)（Initial public beta）
- このfork：[ymnshin/codex-mobile](https://github.com/ymnshin/codex-mobile)
- [MIT License](LICENSE) — 上流の著作権表示 `Copyright (c) 2026 Natale and contributors` を保持しています。上流のスクリーンショットも英語ガイドに残しています。

上流の公開betaは外部PRを受け付けていません。このforkは独立した改善版で、上流作者へのPRは行いません。fork固有の不具合は[このリポジトリのIssues](https://github.com/ymnshin/codex-mobile/issues)へ、再現手順と秘密を除いた情報だけを報告してください。
