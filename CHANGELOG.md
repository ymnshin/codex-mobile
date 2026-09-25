# Changelog

## 2026-09-26 — 認証・キュー復旧

- Codex認証/利用枠をdequeue前に確認。認証切れ・上限到達でもdurable pendingを保持し、reset時刻や指数バックオフ+jitterで復旧を待つ。
- 10秒watchdogでidle+pendingを再確認。exact tracked turnのterminal snapshotで欠落した完了を補い、FIFOで1件ずつ処理。
- claim leaseと送信開始記録を追加。開始前と証明できるclaimだけ復旧し、曖昧な送信は隔離して後続を停止。blind retryなし。
- controller限定 `/codex status` 拡充、`/codex retry` 追加。不明な受付の撤回、5分通知cooldown、秘密を含まないエラー分類。
- 開始前にDesktop ownerを再取得し、再接続後の古いclient IDを再利用しない。
- `startupBackfill: 0` の定期探索がlive cursorを早送りして返答・完了を読み落とす不具合を修正。Desktop担当会話をobserver app-serverがresumeしない。
- 通常投稿の受付文を「現処理の完了後に順番に開始し返答する」意味へ明確化。

Windowsローカル検証が対象。内部IPCの将来互換性、OS自動再起動、マルチユーザー、macOS/Linuxは保証しない。MIT著作権は保持。
