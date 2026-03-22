// slack.js
// Slack Block Kit形式でミーティング議事録を投稿するモジュール

const axios = require("axios");

/**
 * アクションアイテムをSlack表示用の文字列に変換する
 * @param {Object[]} actionItems - アクションアイテムの配列
 * @returns {string} フォーマットされた文字列
 */
function formatActionItems(actionItems) {
  if (!Array.isArray(actionItems) || actionItems.length === 0) {
    return "（なし）";
  }
  return actionItems
    .map((item) => {
      const task = item.task || "（タスク不明）";
      const owner = item.owner || "未定";
      const due = item.due || "未定";
      return `• ${task}｜${owner}｜${due}`;
    })
    .join("\n");
}

/**
 * 議題サマリーをSlack表示用の文字列に変換する
 * @param {Object[]} agendaSummary - 議題サマリーの配列
 * @returns {string} フォーマットされた文字列
 */
function formatAgendaSummary(agendaSummary) {
  if (!Array.isArray(agendaSummary) || agendaSummary.length === 0) {
    return "（なし）";
  }
  return agendaSummary
    .map((item) => {
      const topic = item.topic || "（議題不明）";
      const summary = item.summary || "";
      return `*${topic}*\n${summary}`;
    })
    .join("\n\n");
}

/**
 * 決定事項をSlack表示用の文字列に変換する
 * @param {string[]} decisions - 決定事項の配列
 * @returns {string} フォーマットされた文字列
 */
function formatDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return "（なし）";
  }
  return decisions.map((d) => `• ${d}`).join("\n");
}

/**
 * ミーティングデータと生成コンテンツをSlackに投稿する
 * @param {Object} meetingData - ミーティング情報オブジェクト
 * @param {string} meetingData.title - 会議タイトル
 * @param {string} meetingData.start_time - 開始日時
 * @param {string[]} meetingData.participants - 参加者リスト
 * @param {Object} generatedContent - Claudeが生成したコンテンツ
 * @param {Object} generatedContent.minutes - 議事録オブジェクト
 * @param {Object} generatedContent.email_summary - メールサマリーオブジェクト
 */
async function postToSlack(meetingData, generatedContent) {
  const { title, start_time } = meetingData;
  const { minutes, email_summary } = generatedContent;

  // 参加者リストの整形
  const participantsStr = Array.isArray(minutes.participants)
    ? minutes.participants.join("、")
    : minutes.participants || "不明";

  // 各セクションのフォーマット
  const agendaText = formatAgendaSummary(minutes.agenda_summary);
  const decisionsText = formatDecisions(minutes.decisions);
  const actionItemsText = formatActionItems(minutes.action_items);

  // Block Kitを使ったSlackメッセージの構築
  const blocks = [
    // ヘッダーセクション
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":memo: 議事録が自動生成されました",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title || "（タイトル不明）"}* ／ ${start_time || "（日時不明）"}`,
      },
    },
    {
      type: "divider",
    },

    // ■ 議事録セクション
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "─────────────────────\n■ 議事録\n─────────────────────",
      },
    },

    // 参加者
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*参加者*\n${participantsStr}`,
      },
    },

    // 議題サマリー
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*議題サマリー*\n${agendaText}`,
      },
    },

    // 決定事項
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*決定事項*\n${decisionsText}`,
      },
    },

    // アクションアイテム
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*アクションアイテム*\n${actionItemsText}`,
      },
    },

    {
      type: "divider",
    },

    // ■ クライアント向けメールサマリーセクション
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "─────────────────────\n■ クライアント向けメールサマリー\n─────────────────────",
      },
    },

    // 件名
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*件名*：${email_summary.subject || "（件名なし）"}`,
      },
    },

    // メール本文
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Slackのテキスト上限3000文字に対応するため必要に応じて切り詰め
        text: (email_summary.body || "（本文なし）").substring(0, 2900),
      },
    },
  ];

  console.log("[Slack] メッセージ投稿中...");

  // Slack Incoming Webhook URLにPOSTリクエスト
  await axios.post(
    process.env.SLACK_WEBHOOK_URL,
    {
      blocks,
      // フォールバックテキスト（通知に表示される）
      text: `議事録が生成されました: ${title || "ミーティング"} (${start_time || ""})`,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000, // 10秒タイムアウト
    }
  );

  console.log("[Slack] 投稿完了");
}

module.exports = { postToSlack };
