import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ChannelType,
  Message,
} from 'discord.js';
import { config } from './config.js';
import { storage } from './storage.js';
import { generateResponse } from './services/grok.js';
import { searchMemories, saveMemory } from './services/memory.js';
import { initHolidays } from './services/holidays.js';
import { parseIntent, type IntentType, type ParsedIntent, type IntentParams } from './services/intent.js';
import {
  setDMCallback,
  startScheduledJobs,
  restoreActiveTask,
} from './services/scheduler.js';
import {
  taskCommands,
  remindCommands,
  registerTaskCommands,
  registerRemindCommands,
  executeNext,
  executeDone,
  executeSkip,
  executeStatus,
  executeBreak,
  executeDoneToday,
  executeHistory,
  executeRemindAdd,
  executeRemindList,
  executeRemindDelete,
} from './cogs/index.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// DM送信用コールバックを設定
async function sendDMToUser(content: string): Promise<void> {
  try {
    const user = await client.users.fetch(config.discord.userId);
    await user.send(content);
  } catch (error) {
    console.error('Error sending DM:', error);
  }
}

// スラッシュコマンドを登録
async function registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  const allCommands = [...taskCommands, ...remindCommands].map(cmd => cmd.toJSON());

  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: allCommands }
    );
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
}

// インテントの日本語表示
function getIntentLabel(intent: IntentType, params: IntentParams): string {
  const labels: Record<string, string> = {
    next: `タスク開始: ${params.taskName} (${params.minutes ?? 30}分)`,
    done: params.comment ? `タスク完了: ${params.comment}` : 'タスク完了',
    skip: 'タスクスキップ',
    status: '状況確認',
    break: `休憩: ${params.minutes ?? 10}分`,
    done_today: '本日終了',
    history: params.days ? `履歴確認: 過去${params.days}日` : '履歴確認: 今日',
    remind_add: 'リマインド追加',
    remind_list: 'リマインド一覧',
    remind_delete: `リマインド削除: ID ${params.remindId}`,
  };
  return labels[intent] ?? intent;
}

// 単一インテントを実行
async function executeSingleIntent(intent: IntentType, params: IntentParams): Promise<string | null> {
  switch (intent) {
    case 'next': {
      if (!params.taskName) return null;
      const result = await executeNext(params.taskName, params.minutes ?? 30);
      return result.response;
    }
    case 'done': {
      const result = await executeDone(params.comment);
      return result.response;
    }
    case 'skip': {
      const result = await executeSkip();
      return result.response;
    }
    case 'status': {
      const result = await executeStatus();
      return result.response;
    }
    case 'break': {
      const result = await executeBreak(params.minutes ?? 10);
      return result.response;
    }
    case 'done_today': {
      const result = await executeDoneToday();
      return result.response;
    }
    case 'history': {
      const result = await executeHistory(params.days ?? 0);
      return result.response;
    }
    case 'remind_add': {
      if (!params.remindText) return null;
      const result = await executeRemindAdd(params.remindText);
      return result.response;
    }
    case 'remind_list': {
      const result = await executeRemindList();
      return result.response;
    }
    case 'remind_delete': {
      if (!params.remindId) return null;
      const result = await executeRemindDelete(params.remindId);
      return result.response;
    }
    case 'chat':
    default:
      return null;
  }
}

interface ExecutedIntent {
  intent: IntentType;
  params: IntentParams;
  response: string;
}

// インテントに基づいてコマンドを実行（複数対応）
async function executeByIntent(message: Message): Promise<ExecutedIntent[] | null> {
  const parsedIntents = await parseIntent(message.content);
  console.log('Parsed intents:', parsedIntents);

  // chatのみの場合はnullを返す
  if (parsedIntents.length === 1 && parsedIntents[0].intent === 'chat') {
    return null;
  }

  const results: ExecutedIntent[] = [];

  for (const parsed of parsedIntents) {
    if (parsed.intent === 'chat') continue;

    const response = await executeSingleIntent(parsed.intent, parsed.params);
    if (response) {
      results.push({
        intent: parsed.intent,
        params: parsed.params,
        response,
      });
    }
  }

  return results.length > 0 ? results : null;
}

// 通常の会話処理
async function handleChat(message: Message): Promise<string> {
  storage.addMessage('user', message.content);

  const memories = await searchMemories(message.content);
  const recentMessages = storage.getRecentMessages().map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const context = `【状況】ご主人様からのメッセージ
${message.content}

自然に返答してください。`;

  const response = await generateResponse(context, recentMessages, memories);
  storage.addMessage('assistant', response);
  await saveMemory(`ご主人様: ${message.content}\nみう: ${response}`);

  return response;
}

// DM メッセージハンドラ
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;

  // スラッシュコマンドは別途処理されるので、通常のメッセージのみ
  if (message.content.startsWith('/')) return;

  console.log(`DM received: ${message.content}`);

  try {
    // まずインテント解析を試みる
    const commandResults = await executeByIntent(message);

    if (commandResults && commandResults.length > 0) {
      // コマンドとして処理された - infoラベル付きで返信
      const parts: string[] = [];

      for (const result of commandResults) {
        const label = getIntentLabel(result.intent, result.params);
        parts.push(`\`[${label}]\`\n${result.response}`);
      }

      await message.reply(parts.join('\n\n'));
    } else {
      // 通常の会話として処理
      const chatResponse = await handleChat(message);
      await message.reply(chatResponse);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await message.reply('ふえぇ…みう、ちょっと調子悪いみたいです…ごめんなさい…').catch(() => {});
  }
});

// Bot起動
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // スラッシュコマンド登録
  await registerSlashCommands();

  // コマンドハンドラを登録
  registerTaskCommands(client);
  registerRemindCommands(client);

  // DM送信コールバックを設定
  setDMCallback(sendDMToUser);

  // 祝日データを初期化
  await initHolidays();

  // 定期ジョブを開始
  startScheduledJobs();

  // アクティブタスクを復元
  await restoreActiveTask();

  console.log('Miu Bot is ready!');
});

// 起動
console.log('Starting Miu Bot...');
client.login(config.discord.token);
