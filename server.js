// server.js
// TLDVのWebhookを受信し、議事録生成→Slack投稿を行うExpressサーバー

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { generateMinutes } = require("./claude");
const { postToSlack } = require("./slack");

// TLDV APIのベースURL
const TLDV_API_BASE = "https://pasta.tldv.io/v1alpha1";

const app = express();
const PORT = process.env.PORT || 3000;

// レート制限の設定
// 同一IPから短時間に大量リクエストが来た場合にブロックする
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分間のウィンドウ
  max: 30,                   // 15分間に最大30リクエストまで許可
  message: { error: "Too many requests. Please try again later." },
  standardHeaders: true,     // RateLimit-* ヘッダーを返す
  legacyHeaders: false,      // X-RateLimit-* ヘッダーは使わない
});

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
 * Webhookペイロードから直接ミーティングデータを抽出するフォールバック関数
 * TLDV_API_KEYが未設定の場合に使用する
 * @param {Object} payload - Webhookのリクエストボディ
 * @returns {Object} 正規化されたミーティングデータ
 */
function extractMeetingDataFromPayload(payload) {
  const meeting = payload.meeting || payload.data?.meeting || payload || {};
  return {
    title: meeting.title || meeting.name || payload.title || "（タイトル不明）",
    start_time: meeting.start_time || meeting.startTime || meeting.happenedAt || new Date().toISOString(),
    participants: (() => {
      const raw = meeting.participants || meeting.invitees || meeting.attendees || payload.participants || [];
      if (Array.isArray(raw)) return raw.map((p) => typeof p === "string" ? p : p.name || p.email || String(p));
      if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
      return [];
    })(),
    transcript: meeting.transcript || meeting.transcription || payload.transcript || "",
    summary: meeting.summary || payload.summary || "",
  };
}

/**
 * WebhookペイロードからミーティングIDを抽出する関数
 * @param {Object} payload - Webhookのリクエストボディ
 * @returns {string|null} ミーティングID
 */
function extractMeetingId(payload) {
  return (
    payload.id ||
    payload.meeting?.id ||
    payload.data?.meeting?.id ||
    payload.meetingId ||
    null
  );
}

/**
 * TLDV APIからミーティング情報とトランスクリプトを取得する関数
 * トランスクリプトが準備できるまでポーリングする
 * @param {string} meetingId - TLDVのミーティングID
 * @param {number} maxRetries - 最大リトライ回数（デフォルト10回）
 * @param {number} intervalMs - リトライ間隔ミリ秒（デフォルト30秒）
 * @returns {Object} 正規化されたミーティングデータ
 */
async function fetchMeetingDataWithRetry(meetingId, maxRetries = 10, intervalMs = 30000) {
  const apiKey = process.env.TLDV_ACCESS_KEY;
  if (!apiKey) {
    throw new Error("TLDV_ACCESS_KEYが設定されていません");
  }

  const headers = { "x-api-key": apiKey };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[TLDV API] トランスクリプト確認中... (試行 ${attempt}/${maxRetries})`);

    try {
      // ミーティング情報とトランスクリプトを並列で取得
      const [meetingRes, transcriptRes] = await Promise.all([
        axios.get(`${TLDV_API_BASE}/meetings/${meetingId}/`, { headers }),
        axios.get(`${TLDV_API_BASE}/meetings/${meetingId}/transcript/`, { headers }).catch(() => null),
      ]);

      const meeting = meetingRes.data;
      const transcriptData = transcriptRes?.data?.data;

      // トランスクリプトが存在して内容があれば処理する
      if (transcriptData && transcriptData.length > 0) {
        console.log(`[TLDV API] トランスクリプト準備完了（${transcriptData.length}件の発言）`);

        // トランスクリプトを「話者：発言内容」形式のテキストに変換
        const transcript = transcriptData
          .map((t) => `${t.speaker}：${t.text}`)
          .join("\n");

        // 参加者リストを構築（inviteesから取得）
        const participants = (meeting.invitees || []).map(
          (p) => p.name || p.email || String(p)
        );
        if (meeting.organizer?.name && !participants.includes(meeting.organizer.name)) {
          participants.unshift(meeting.organizer.name);
        }

        return {
          title: meeting.name || "（タイトル不明）",
          start_time: meeting.happenedAt || new Date().toISOString(),
          participants,
          transcript,
          summary: "",
        };
      }

      // トランスクリプト未準備の場合
      console.log(`[TLDV API] トランスクリプト未準備。${intervalMs / 1000}秒後に再試行します...`);
    } catch (error) {
      console.error(`[TLDV API] エラー (試行 ${attempt}):`, error.message);
    }

    // 最後の試行でなければ待機
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`トランスクリプトが${maxRetries}回試行後も準備できませんでした`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /webhook — メインのWebhookエンドポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/webhook", webhookLimiter, async (req, res) => {
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
    // WebhookペイロードからミーティングIDを取得
    const meetingId = extractMeetingId(req.body);

    let meetingData;
    if (meetingId && process.env.TLDV_ACCESS_KEY) {
      // TLDV APIを使い、トランスクリプト準備完了を確認してからデータ取得
      console.log("[Webhook] ミーティングID:", meetingId);
      console.log("[Webhook] TLDV APIでトランスクリプト準備完了を確認します...");
      meetingData = await fetchMeetingDataWithRetry(meetingId);
    } else {
      // APIキー未設定またはIDなしの場合はWebhookペイロードから直接取得（フォールバック）
      console.warn("[Webhook] TLDV_ACCESS_KEYが未設定のため、Webhookペイロードから直接データを取得します");
      meetingData = extractMeetingDataFromPayload(req.body);
    }

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
