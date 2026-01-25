import { config } from '../config.js';

export type IntentType =
  | 'next'      // タスク開始
  | 'done'      // タスク完了
  | 'skip'      // タスクスキップ
  | 'extend'    // タスク延長
  | 'status'    // 状況確認
  | 'break'     // 休憩
  | 'done_today' // 今日の作業終了
  | 'history'   // 履歴確認
  | 'remind_add' // リマインド追加
  | 'remind_list' // リマインド一覧
  | 'remind_delete' // リマインド削除
  | 'reset'     // タスクリセット
  | 'chat';     // 通常の会話

export interface IntentParams {
  taskName?: string;
  minutes?: number;
  comment?: string;
  days?: number;
  remindText?: string;
  remindId?: number;
}

export interface ParsedIntent {
  intent: IntentType;
  params: IntentParams;
  confidence: number;
}

export interface ParsedIntents {
  intents: ParsedIntent[];
}

const INTENT_PARSE_PROMPT = `あなたはユーザーの発言から意図を解析するアシスタントです。
以下のコマンドに該当するか判定し、JSONで返してください。
**1つのメッセージに複数の意図が含まれる場合は、すべて配列で返してください。**

【コマンド一覧】
- next: タスクを開始する（例: 「レポート作成30分でやる」「次は会議資料を1時間で」）
- done: タスクを完了する（例: 「終わった」「できた」「完了」）
- skip: タスクをスキップする（例: 「やめる」「スキップ」「後でやる」）
- extend: タスクを延長する（例: 「30分延長」「あと1時間」「延長で」「もう少しやる」）
- status: 現在の状況確認（例: 「今どんな状況？」「進捗は？」）
- break: 休憩する（例: 「休憩」「ちょっと休む」「10分休憩」）
- done_today: 今日の作業終了（例: 「今日は終わり」「もう寝る」「作業終了」）
- history: 履歴確認（例: 「今日何やった？」「履歴見せて」「過去3日分」）
- remind_add: リマインド追加（例: 「毎朝9時に薬飲んだか確認して」）
- remind_list: リマインド一覧（例: 「リマインド一覧」「登録済みのリマインド」）
- remind_delete: リマインド削除（例: 「リマインド3番消して」）
- reset: 現在のタスクを強制リセット（例: 「リセット」「タスクをリセット」）
- chat: 上記に該当しない通常の会話

【出力形式】JSONのみを出力してください
{
  "intents": [
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
  ]
}

【注意】
- 「運動終わったよ！次は30分でお買い物するよ」→ done + next の2つを返す
- 時間の指定がない場合、nextはminutes: 30、breakはminutes: 10をデフォルトとする
- 「1時間」は60分、「30分」は30に変換
- confidenceが0.5未満のintentは含めない
- 曖昧な場合は無理に判定せずchatとする
- 複数の意図がある場合は実行順序通りに配列に入れる（done→nextの順など）

ユーザーの発言: {user_message}`;

interface GrokResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function parseIntent(userMessage: string): Promise<ParsedIntent[]> {
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
        max_tokens: 300,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error(`Intent parse API error: ${response.status}`);
      return [{ intent: 'chat', params: {}, confidence: 0 }];
    }

    const data = (await response.json()) as GrokResponse;
    const content = data.choices[0]?.message?.content?.trim() ?? '';

    // JSONをパース
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ParsedIntents;

      // 確信度が低いものを除外
      const validIntents = parsed.intents.filter(i => i.confidence >= 0.5);

      if (validIntents.length > 0) {
        return validIntents;
      }
    }
  } catch (error) {
    console.error('Intent parse error:', error);
  }

  return [{ intent: 'chat', params: {}, confidence: 0 }];
}
