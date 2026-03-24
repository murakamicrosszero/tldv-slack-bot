// claude.js
// Claude APIを使用して議事録とメールサマリーを生成するモジュール

const Anthropic = require("@anthropic-ai/sdk");

// Anthropicクライアントの初期化（ANTHROPIC_API_KEY環境変数を自動参照）
const anthropic = new Anthropic();

/**
 * ミーティングデータを受け取り、議事録とメールサマリーをJSON形式で生成する
 * @param {Object} meetingData - ミーティング情報オブジェクト
 * @param {string} meetingData.title - 会議タイトル
 * @param {string} meetingData.start_time - 開始日時
 * @param {string[]} meetingData.participants - 参加者リスト
 * @param {string} meetingData.transcript - フルトランスクリプト
 * @param {string} meetingData.summary - TLDVの自動生成サマリー
 * @returns {Object} 議事録とメールサマリーを含むJSONオブジェクト
 */
async function generateMinutes(meetingData) {
  const { title, start_time, participants, transcript, summary } = meetingData;

  // 参加者リストをカンマ区切りの文字列に変換
  const participantsStr = Array.isArray(participants)
    ? participants.join(", ")
    : participants || "不明";

  // ユーザープロンプトの構築
  const userPrompt = `## ミーティング情報
- タイトル：${title}
- 日時：${start_time}
- 参加者：${participantsStr}

## TLDVの自動サマリー（参考情報）
${summary || "（サマリーなし）"}

## フルトランスクリプト
${transcript || "（トランスクリプトなし）"}

---

以下のJSON形式で出力してください。他のテキストは一切含めないこと。

{
  "minutes": {
    "title": "議事録タイトル",
    "date": "日付",
    "participants": ["参加者1", "参加者2"],
    "agenda_summary": [
      {
        "topic": "議題名",
        "summary": "議題の内容サマリー"
      }
    ],
    "decisions": ["決定事項1", "決定事項2"],
    "action_items": [
      {
        "task": "タスク内容",
        "owner": "担当者名（不明な場合は「未定」）",
        "due": "期限（言及があれば。なければ「未定」）"
      }
    ]
  },
  "email_summary": {
    "subject": "件名（例：【議事録】{会議タイトル} {日付}）",
    "body": "メール本文全体（社外向け丁寧なビジネス文体。要点を3〜5点の箇条書きで含める）"
  }
}`;

  console.log("[Claude] 議事録生成リクエスト送信中...");

  // Claude APIへのリクエスト
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: `あなたはプロのミーティングファシリテーターです。
提供されたミーティングのトランスクリプトと情報をもとに、
日本語で議事録とクライアント向けメールサマリーを作成してください。
必ず指定されたJSONフォーマットで返してください。

【重要】会社名の表記ルール:
- 「クロスゼロ」「クロステラ」「cross zero」「x-z」などの表記はすべて「CROSS ZERO」に統一すること
- メールドメイン @x-z.jp は株式会社CROSS ZEROのドメインです
- 参加者の所属会社として「CROSS ZERO」が正式名称です`,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  // レスポンスからテキストブロックを取得
  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error("Claude APIからテキストレスポンスが返されませんでした");
  }

  const rawText = textBlock.text.trim();
  console.log("[Claude] レスポンス受信完了。JSONパース中...");

  // JSONの抽出（コードブロックで囲まれている場合にも対応）
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
    rawText.match(/(\{[\s\S]*\})/);

  const jsonStr = jsonMatch ? jsonMatch[1] : rawText;

  // JSONパース
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error("[Claude] JSONパースエラー:", parseError.message);
    console.error("[Claude] 受信テキスト:", rawText.substring(0, 500));
    throw new Error(`議事録JSONのパースに失敗しました: ${parseError.message}`);
  }

  console.log("[Claude] 議事録生成完了");
  return parsed;
}

module.exports = { generateMinutes };
