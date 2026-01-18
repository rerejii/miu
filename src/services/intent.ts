import { config } from '../config.js';

export type IntentType =
  | 'next'      // タスク開始
  | 'done'      // タスク完了
  | 'skip'      // タスクスキップ
  | 'status'    // 状況確認
  | 'break'     // 休憩
  | 'done_today' // 今日の作業終了
  | 'history'   // 履歴確認
  | 'remind_add' // リマインド追加
  | 'remind_list' // リマインド一覧
  | 'remind_delete' // リマインド削除
  | 'chat';     // 通常の会話

export interface ParsedIntent {
  intent: IntentType;
  params: {
    taskName?: string;
    minutes?: number;
    comment?: string;
    days?: number;
    remindText?: string;
    remindId?: number;
  };
  confidence: number;
}

const INTENT_PARSE_PROMPT = `あなたはユーザーの発言から意図を解析するアシスタントです。
以下のコマンドのいずれかに該当するか判定し、JSONで返してください。

【コマンド一覧】
- next: タスクを開始する（例: 「レポート作成30分でやる」「次は会議資料を1時間で」）
- done: タスクを完了する（例: 「終わった」「できた」「完了」）
- skip: タスクをスキップする（例: 「やめる」「スキップ」「後でやる」）
- status: 現在の状況確認（例: 「今どんな状況？」「進捗は？」）
- break: 休憩する（例: 「休憩」「ちょっと休む」「10分休憩」）
- done_today: 今日の作業終了（例: 「今日は終わり」「もう寝る」「作業終了」）
- history: 履歴確認（例: 「今日何やった？」「履歴見せて」「過去3日分」）
- remind_add: リマインド追加（例: 「毎朝9時に薬飲んだか確認して」）
- remind_list: リマインド一覧（例: 「リマインド一覧」「登録済みのリマインド」）
- remind_delete: リマインド削除（例: 「リマインド3番消して」）
- chat: 上記に該当しない通常の会話

【出力形式】JSONのみを出力してください
{
  "intent": "コマンド名",
  "params": {
    "taskName": "タスク名（nextの場合）",
    "minutes": 数値（next/breakの場合、分単位）,
    "comment": "感想（doneの場合）",
    "days": 数値（historyの場合、日数）,
    "remindText": "リマインド内容（remind_addの場合）",
    "remindId": 数値（remind_deleteの場合）
  },
  "confidence": 0.0〜1.0（確信度）
}

【注意】
- 時間の指定がない場合、nextはminutes: 30、breakはminutes: 10をデフォルトとする
- 「1時間」は60分、「30分」は30に変換
- confidenceが0.5未満の場合はchatとして扱う
- 曖昧な場合は無理に判定せずchatとする

ユーザーの発言: {user_message}`;

interface GrokResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function parseIntent(userMessage: string): Promise<ParsedIntent> {
  const prompt = INTENT_PARSE_PROMPT.replace('{user_message}', userMessage);

  try {
    const response = await fetch(`${config.grok.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.grok.apiKey}`,
      },
      body: JSON.stringify({
        model: config.grok.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.2, // 低めで確実に
      }),
    });

    if (!response.ok) {
      console.error(`Intent parse API error: ${response.status}`);
      return { intent: 'chat', params: {}, confidence: 0 };
    }

    const data = (await response.json()) as GrokResponse;
    const content = data.choices[0]?.message?.content?.trim() ?? '';

    // JSONをパース
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ParsedIntent;

      // 確信度が低い場合はchatに
      if (parsed.confidence < 0.5) {
        return { intent: 'chat', params: {}, confidence: parsed.confidence };
      }

      return parsed;
    }
  } catch (error) {
    console.error('Intent parse error:', error);
  }

  return { intent: 'chat', params: {}, confidence: 0 };
}
