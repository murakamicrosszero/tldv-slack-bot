# TLDV Slack Bot

TLDVのミーティング録画完了時に自動でトランスクリプトをClaude APIに渡して議事録を生成し、Slackの指定チャンネルに投稿する自動化システムです。

---

## セットアップ手順

### 1. リポジトリをクローン

```bash
git clone https://github.com/your-username/tldv-slack-bot.git
cd tldv-slack-bot
```

### 2. 依存パッケージをインストール

```bash
npm install
```

### 3. 環境変数を設定

`.env.example` をコピーして `.env` ファイルを作成し、各値を設定します。

```bash
cp .env.example .env
```

`.env` ファイルを開いて以下の3つの値を設定してください：

| 変数名 | 説明 | 取得場所 |
|--------|------|---------|
| `TLDV_WEBHOOK_SECRET` | TLDVのWebhookシークレット | TLDV設定 → Integrations → Webhooks |
| `ANTHROPIC_API_KEY` | Anthropic APIキー | https://console.anthropic.com |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL | Slack App設定 → Incoming Webhooks |

### 4. ローカルで起動確認

```bash
node server.js
```

以下のログが表示されれば起動成功です：

```
[Server] TLDV Slack Bot が起動しました (ポート: 3000)
[Server] Webhookエンドポイント: POST /webhook
[Server] ヘルスチェック: GET /health
```

ヘルスチェックで動作確認：

```bash
curl http://localhost:3000/health
```

---

## Railwayへのデプロイ手順

### ステップ1: GitHubリポジトリを作成してPush

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/your-username/tldv-slack-bot.git
git push -u origin main
```

### ステップ2: Railwayにログイン

[railway.app](https://railway.app) にアクセスして、「Login with GitHub」でログインします。

### ステップ3: プロジェクトを作成

1. ダッシュボードで **「New Project」** をクリック
2. **「Deploy from GitHub repo」** を選択
3. リポジトリ一覧から `tldv-slack-bot` を選択
4. デプロイが自動で開始されます

### ステップ4: 環境変数を設定

1. プロジェクトの **「Variables」** タブを開く
2. 以下の3つの環境変数を追加：
   - `TLDV_WEBHOOK_SECRET` ← TLDVのWebhookシークレット
   - `ANTHROPIC_API_KEY` ← AnthropicのAPIキー
   - `SLACK_WEBHOOK_URL` ← SlackのIncoming Webhook URL
3. 変数を保存すると自動で再デプロイが始まります

### ステップ5: デプロイURLを確認

1. **「Settings」** タブの **「Domains」** セクションを確認
2. Railway が自動生成したURLをコピー（例：`https://tldv-slack-bot-production.up.railway.app`）
3. このURLを次のTLDV設定で使用します

---

## TLDVへのWebhook登録手順

### ステップ1: TLDV設定を開く

TLDVにログインし、**Settings（設定）** → **Integrations（統合）** → **Webhooks** を開きます。

### ステップ2: Webhookを追加

1. **「Add Webhook」** をクリック
2. **Webhook URL** に以下を入力：
   ```
   https://{RailwayのURL}/webhook
   ```
   例：`https://tldv-slack-bot-production.up.railway.app/webhook`
3. **Event（イベント）** で **`meeting.completed`** を選択
4. **「Save」** をクリック

### ステップ3: Webhook Secretを設定

1. Webhookの設定画面に表示される **Webhook Secret** をコピー
2. Railway の **Variables** タブで `TLDV_WEBHOOK_SECRET` にペースト
3. 変数保存後、Railwayが自動で再デプロイします

---

## 動作確認方法

TLDVでテスト用のミーティングを録画し、録画が完了すると自動的に以下の流れが実行されます：

1. TLDVがWebhookを送信
2. サーバーが署名を検証してトランスクリプトを受信
3. Claude APIが日本語の議事録を生成
4. Slackの指定チャンネルに議事録が投稿される

Railway のログ（**「Deployments」** → **「View Logs」**）で処理の進捗を確認できます。

---

## ファイル構成

```
tldv-slack-bot/
├── server.js          Expressサーバー・Webhookエンドポイント・署名検証
├── claude.js          Claude APIで議事録を生成するロジック
├── slack.js           Block Kit形式でSlackに投稿するロジック
├── .env.example       環境変数のテンプレート
├── package.json       依存関係・起動スクリプト
└── README.md          本ファイル
```

## 技術スタック

- **ランタイム**: Node.js 18+
- **フレームワーク**: Express.js
- **AIモデル**: Claude Sonnet 4.5（Anthropic）
- **HTTPクライアント**: axios（Slack投稿用）
- **セキュリティ**: crypto（HMAC-SHA256署名検証）
- **デプロイ**: Railway
