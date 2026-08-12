# joba

乗馬クラブクレイン予約サイト（https://member.crane.jp/crane/）のレッスン空き状況を
定期的に監視し、指定したレッスンが「○（予約可）」になったらDiscordに通知するツールです。

## できること / できないこと

- ✅ レッスン検索結果を閲覧して空き状況（○/△/×）を確認
- ✅ 監視対象のレッスンが×または△→○になったらDiscordへ通知
- ❌ 予約ボタン・キャンセル待ちボタンは一切押しません（自動予約は行いません）
- ❌ キャンセル待ちの順番（何人目か）は検索結果からは分からないため取得しません

## セットアップ

1. GitHubリポジトリの `Settings > Secrets and variables > Actions` で以下のSecretsを登録してください。

   | Secret名 | 内容 |
   |---|---|
   | `CRANE_EMAIL` | crane.jp ログイン用メールアドレス |
   | `CRANE_PASSWORD` | crane.jp ログイン用パスワード |
   | `DISCORD_WEBHOOK_URL` | 通知したいDiscordチャンネルのWebhook URL |

2. 監視対象のレッスン名を変更したい場合は、リポジトリの `Settings > Secrets and variables > Actions > Variables` に
   `CRANE_TARGET_LESSONS` を追加し、カンマ区切りでレッスン名を指定してください（省略時は `ベーシック駈歩ＡＢ,ベーシック駈歩Ｂ`）。
   ワークフロー(`.github/workflows/crane-lesson-monitor.yml`)側で `vars.CRANE_TARGET_LESSONS` を
   `env` に追加すれば反映されます。

3. `.github/workflows/crane-lesson-monitor.yml` により、JST 6:00〜23:59の間5分おきに自動実行されます
   （0:00〜6:00はサイト側のメンテナンス時間帯のため対象外にしています）。
   `Actions` タブから手動実行（workflow_dispatch）も可能です。

## ローカルでの動作確認

```bash
npm install
npx playwright install --with-deps chromium
CRANE_EMAIL=xxx CRANE_PASSWORD=xxx DISCORD_WEBHOOK_URL=xxx npm run check
```

## 制限事項

- GitHub Actionsのスケジュール実行は数分単位で遅延することがあります。「瞬時に埋まる」レッスンの場合、
  通知が届く前に埋まってしまう可能性があります。
- クラブは会員アカウントのデフォルト設定（ログイン後に選択されているクラブ）がそのまま使われます。
