import { config } from '../config.js';
import { SYSTEM_PROMPT, CRON_PARSE_PROMPT } from '../prompts/index.js';

function getJSTTime(): string {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GrokResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function generateResponse(
  context: string,
  recentMessages: ChatMessage[] = [],
  memories: string = ''
): Promise<string> {
  const currentTime = getJSTTime();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + `\n\n現在時刻（日本時間）: ${currentTime}` },
  ];

  if (memories) {
    messages.push({
      role: 'system',
      content: `ユーザーに関する記憶:\n${memories}`,
    });
  }

  messages.push(...recentMessages);
  messages.push({ role: 'user', content: context });

  const response = await fetch(`${config.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: config.grok.model,
      messages,
      max_tokens: 300,
      temperature: 0.8,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grok API error: ${response.status}`);
  }

  const data = (await response.json()) as GrokResponse;
  return data.choices[0]?.message?.content?.trim() ?? '';
}

export interface ParsedReminder {
  time: string;
  days: string[];
  include_holidays: boolean;
  message: string;
}

export async function parseCronFromNaturalLanguage(userInput: string): Promise<ParsedReminder | null> {
  const prompt = CRON_PARSE_PROMPT.replace('{user_input}', userInput);

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
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    console.error(`Grok API error: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as GrokResponse;
  const content = data.choices[0]?.message?.content?.trim() ?? '';

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as ParsedReminder;
    }
  } catch (e) {
    console.error('Failed to parse reminder JSON:', e);
  }

  return null;
}

export async function generateConfirmationMessage(reminder: ParsedReminder): Promise<string> {
  const daysJp: Record<string, string> = {
    mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日'
  };
  const daysStr = reminder.days.map(d => daysJp[d] ?? d).join('・');
  const holidayStr = reminder.include_holidays ? '（祝日含む）' : '（祝日除く）';

  const context = `【状況】ご主人様がリマインドを登録しました
- 時刻: ${reminder.time}
- 曜日: ${daysStr}${holidayStr}
- メッセージ: 「${reminder.message}」

登録完了を伝える短いメッセージを返してください。`;

  return generateResponse(context);
}
