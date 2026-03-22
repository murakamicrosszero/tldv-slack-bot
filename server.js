// server.js
// TLDVのWebhookを受信し、議事録生成→Slack投稿を行うExpressサーバー

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { generateMinutes } = require("./claude");
const { postToSlack } = require("./slack");

const app = express();
const PORT = process.env.PORT || 3000;

// リクエストボディをバッファとして保持（HMAC署名検証に生のバイト列が必要）
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * TLDVから送られるAPIキーを検証する関数
 * TLDVはリクエストヘッダー x-api-key にAPIキーを付与する
 * @param {string} apiKey - x-api-keyヘッダーの値
 * @returns {boolean} APIキーが正しければtrue
 */
function verifyApiKey(apiKey) {
  const expectedKey = process.env.TLDV_API_KEY;

  // APIキーが未設定の場合はスキップ（開発時のみ。本番では必ず設定すること）
  if (!expectedKey) {
    console.warn("[警告] TLDV_API_KEYが未設定です。認証をスキップします。");
    return true;
  }

  if (!apiKey) {
    console.error("[エラー] x-api-keyヘッダーが見つかりません");
    return false;
  }

  // タイミング攻撃を防ぐためtimingSafeEqualで比較
  try {
    return crypto.timingSafeEqual(
      Buffer.from(apiKey),
      Buffer.from(expectedKey)
    );
  } catch {
    return false;
  }
}

/**
 * TLDVのWebhookペイロードからミーティングデータを抽出する関数
 * ペイロード構造が異なる場合に備えてフォールバック処理を実装
 * @param {Object} payload - Webhookのリクエストボディ
 * @returns {Object} 正規化されたミーティングデータ
 */
function extractMeetingData(payload) {
  // TLDVのWebhookペイロード構造に合わせて柔軟に対応
  const meeting = payload.meeting || payload.data?.meeting || payload || {};

  return {
    // 会議タイトル（複数のパスを試みる）
    title:
      meeting.title ||
      meeting.name ||
      payload.title ||
      "（タイトル不明）",

    // 開始日時（ISO形式またはタイムスタンプ）
    start_time:
      meeting.start_time ||
      meeting.startTime ||
      meeting.started_at ||
      payload.start_time ||
      new Date().toISOString(),

    // 参加者リスト（配列または文字列）
    participants: (() => {
      const raw =
        meeting.participants ||
        meeting.attendees ||
        payload.participants ||
        [];
      if (Array.isArray(raw)) {
        // オブジェクト形式の場合は名前を抽出
        return raw.map((p) =>
          typeof p === "string" ? p : p.name || p.email || p.displayName || String(p)
        );
      }
      if (typeof raw === "string") {
        return raw.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return [];
    })(),

    // フルトランスクリプト（話者ラベル付き）
    transcript:
      meeting.transcript ||
      meeting.transcription ||
      meeting.full_transcript ||
      payload.transcript ||
      "",

    // TLDVの自動生成サマリー（参考情報として使用）
    summary:
      meeting.summary ||
      meeting.auto_summary ||
      payload.summary ||
      "",
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /webhook — メインのWebhookエンドポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/webhook", async (req, res) => {
  console.log("[Webhook] リクエスト受信:", new Date().toISOString());

  // ─── 1. APIキー認証 ───
  const apiKey = req.headers["x-api-key"];
  if (!verifyApiKey(apiKey)) {
    console.error("[Webhook] APIキー認証失敗 - 不正なリクエストです");
    return res.status(403).json({ error: "Invalid API key" });
  }
  console.log("[Webhook] APIキー認証OK");

  // ─── 2. TLDVには即座に200を返す ───
  // TLDVのリトライを防ぐため、処理完了を待たずにレスポンスを返す
  res.status(200).json({ received: true });

  // ─── 3. 非同期で議事録生成・Slack投稿を実行 ───
  try {
    // ペイロードからミーティングデータを抽出
    const meetingData = extractMeetingData(req.body);
    console.log("[Webhook] ミーティングタイトル:", meetingData.title);
    console.log("[Webhook] 参加者数:", meetingData.participants.length);

    // Claude APIで議事録を生成
    const generatedContent = await generateMinutes(meetingData);

    // Slackに投稿
    await postToSlack(meetingData, generatedContent);

    console.log("[Webhook] 処理完了");
  } catch (error) {
    // エラーが発生してもTLDVへのレスポンスは既に返済済みなので、ログのみ出力
    console.error("[Webhook] 処理中にエラーが発生しました:", error.message);
    console.error(error.stack);
  }
});

// ─── ヘルスチェックエンドポイント ───
// Railwayのデプロイ確認やUptimeモニタリングに使用
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ─── サーバー起動 ───
app.listen(PORT, () => {
  console.log(`[Server] TLDV Slack Bot が起動しました (ポート: ${PORT})`);
  console.log(`[Server] Webhookエンドポイント: POST /webhook`);
  console.log(`[Server] ヘルスチェック: GET /health`);
});
