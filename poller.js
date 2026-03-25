// poller.js
// TLDVのAPIを定期的にポーリングして新しいミーティングを検出し、議事録をSlackに投稿する

const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { generateMinutes } = require("./claude");
const { postToSlack } = require("./slack");

// TLDV APIのベースURL
const TLDV_API_BASE = "https://pasta.tldv.io/v1alpha1";

// 処理済みミーティングIDを記録するファイルパス
const PROCESSED_FILE = path.join(__dirname, "processed_meetings.json");

/**
 * 処理済みミーティングIDのセットを読み込む
 * @returns {Set<string>}
 */
function loadProcessedIds() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
      return new Set(data);
    }
  } catch (e) {
    console.error("[Poller] processed_meetings.json の読み込みエラー:", e.message);
  }
  return new Set();
}

/**
 * 処理済みミーティングIDをファイルに保存する
 * @param {Set<string>} ids
 */
function saveProcessedIds(ids) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...ids]), "utf8");
  } catch (e) {
    console.error("[Poller] processed_meetings.json の保存エラー:", e.message);
  }
}

/**
 * TLDV APIから最新のミーティング一覧を取得する
 * @returns {Array} ミーティングの配列
 */
async function fetchRecentMeetings() {
  const apiKey = process.env.TLDV_ACCESS_KEY;
  if (!apiKey) throw new Error("TLDV_ACCESS_KEYが未設定です");

  const res = await axios.get(`${TLDV_API_BASE}/meetings/?pageSize=20`, {
    headers: { "x-api-key": apiKey },
  });
  return res.data.results || [];
}

/**
 * 指定ミーティングのトランスクリプトを取得する
 * @param {string} meetingId
 * @returns {string|null} トランスクリプトテキスト、未準備の場合はnull
 */
async function fetchTranscript(meetingId) {
  const apiKey = process.env.TLDV_ACCESS_KEY;
  try {
    const res = await axios.get(
      `${TLDV_API_BASE}/meetings/${meetingId}/transcript/`,
      { headers: { "x-api-key": apiKey } }
    );
    const data = res.data?.data;
    if (!data || data.length === 0) return null;
    return data.map((t) => `${t.speaker}：${t.text}`).join("\n");
  } catch {
    return null;
  }
}

/**
 * 新しいミーティングを処理して議事録をSlackに投稿する
 */
async function pollAndProcess() {
  // JSTで現在時刻を確認（10:00〜19:00のみ実行）
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hour = nowJST.getUTCHours();
  if (hour < 10 || hour >= 19) {
    console.log(`[Poller] 対象時間外のためスキップ (JST ${hour}時)`);
    return;
  }

  console.log("[Poller] ポーリング開始...");

  const processedIds = loadProcessedIds();

  let meetings;
  try {
    meetings = await fetchRecentMeetings();
  } catch (e) {
    console.error("[Poller] ミーティング一覧取得エラー:", e.message);
    return;
  }

  // 未処理のミーティングだけを対象にする
  const newMeetings = meetings.filter((m) => !processedIds.has(m.id));
  console.log(`[Poller] 新規ミーティング: ${newMeetings.length}件`);

  for (const meeting of newMeetings) {
    console.log(`[Poller] 処理中: ${meeting.name} (${meeting.id})`);

    // トランスクリプトを取得（まだ準備できていない場合はスキップ）
    const transcript = await fetchTranscript(meeting.id);
    if (!transcript) {
      console.log(`[Poller] トランスクリプト未準備のためスキップ: ${meeting.name}`);
      continue;
    }

    // 参加者リストを構築
    const participants = (meeting.invitees || []).map(
      (p) => p.name || p.email || String(p)
    );
    if (
      meeting.organizer?.name &&
      !participants.includes(meeting.organizer.name)
    ) {
      participants.unshift(meeting.organizer.name);
    }

    const meetingData = {
      title: meeting.name || "（タイトル不明）",
      start_time: meeting.happenedAt || new Date().toISOString(),
      participants,
      transcript,
      summary: "",
    };

    try {
      // Claude APIで議事録を生成してSlackに投稿
      const generatedContent = await generateMinutes(meetingData);
      await postToSlack(meetingData, generatedContent);
      console.log(`[Poller] 投稿完了: ${meeting.name}`);

      // 処理済みとして記録
      processedIds.add(meeting.id);
      saveProcessedIds(processedIds);
    } catch (e) {
      console.error(`[Poller] 処理エラー (${meeting.name}):`, e.message);
    }
  }

  console.log("[Poller] ポーリング完了");
}

/**
 * ポーリングスケジューラーを起動する
 * 日本時間 9:00, 11:00, 13:00, 15:00, 17:00, 19:00 に実行（UTC: 0,2,4,6,8,10時）
 */
function startPoller() {
  console.log("[Poller] スケジューラー起動（JST 10:00〜19:00 / 30分おき）");

  // UTC 1〜10時 = JST 10〜19時（毎時0分・30分に実行）
  cron.schedule("0,30 1-10 * * *", async () => {
    await pollAndProcess();
  });
}

module.exports = { startPoller, pollAndProcess };
