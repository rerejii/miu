import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Client,
} from 'discord.js';
import { storage } from '../storage.js';
import { generateResponse } from '../services/grok.js';
import { searchMemories, saveMemory } from '../services/memory.js';
import { startTaskReminder, stopTaskReminder, startBreakTimer, startNoScheduleReminder, stopNoScheduleReminder } from '../services/scheduler.js';
import {
  getTaskStartContext,
  getTaskCompleteContext,
  getTaskSkipContext,
  getBreakStartContext,
  getStatusContext,
  getHistoryContext,
} from '../prompts/index.js';
import { getNextEvent, formatEventForDisplay, getMinutesUntilEvent, isCalendarConfigured, hasRemainingEventsToday, getFreeTimeMinutes, createTaskEvent, updateTaskEvent } from '../services/calendar.js';

function getJSTTime(): string {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// コマンド実行結果
export interface CommandResult {
  success: boolean;
  response: string;
}

export const commands = [
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('次のタスクを宣言')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('タスク名')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('minutes')
        .setDescription('予定時間（分）')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(120)),

  new SlashCommandBuilder()
    .setName('done')
    .setDescription('現在のタスクを完了')
    .addStringOption(option =>
      option.setName('comment')
        .setDescription('感想（任意）')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('現在のタスクをスキップ'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在のタスク状況を確認'),

  new SlashCommandBuilder()
    .setName('break')
    .setDescription('休憩を宣言')
    .addIntegerOption(option =>
      option.setName('minutes')
        .setDescription('休憩時間（分）')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(60)),

  new SlashCommandBuilder()
    .setName('done_today')
    .setDescription('今日の作業終了'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('タスク履歴を表示')
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('過去何日分（デフォルト: 今日のみ）')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(30)),
];

// ========== コアロジック（外部から呼び出し可能） ==========

export async function executeNext(taskName: string, minutes: number): Promise<CommandResult> {
  const currentTask = storage.getCurrentTask();
  if (currentTask) {
    return {
      success: false,
      response: `まだ「${currentTask.task_name}」が進行中です。終わったら「終わった」、スキップなら「やめる」と言ってください。`,
    };
  }

  // タスク開始時に予定未登録リマインダーを停止
  stopNoScheduleReminder();

  const task = storage.createTask(taskName, minutes);
  startTaskReminder(task.id);

  // カレンダーにタスクを登録
  if (isCalendarConfigured()) {
    const eventId = await createTaskEvent({
      taskName,
      durationMinutes: minutes,
      taskId: task.id,
    });
    if (eventId) {
      storage.setCalendarEventId(task.id, eventId);
    }
  }

  const todayCount = storage.getTodayCompletedCount();
  const memories = await searchMemories(taskName);

  const context = getTaskStartContext({
    taskName,
    duration: minutes,
    currentTime: getJSTTime(),
    todayCount,
    mem0Context: memories,
  });

  const response = await generateResponse(context);
  storage.addMessage('assistant', response);
  await saveMemory(`[タスク開始] ${taskName} (${minutes}分)`);

  return { success: true, response };
}

export async function executeDone(comment?: string): Promise<CommandResult> {
  const currentTask = storage.getCurrentTask();
  if (!currentTask) {
    return {
      success: false,
      response: '進行中のタスクがありません。',
    };
  }

  const elapsed = storage.getElapsedMinutes(currentTask);
  storage.completeTask(currentTask.id, comment);
  stopTaskReminder();

  // カレンダーのイベントを更新
  if (currentTask.calendar_event_id) {
    await updateTaskEvent({
      eventId: currentTask.calendar_event_id,
      taskName: currentTask.task_name,
      actualMinutes: elapsed,
      status: 'done',
    });
  }

  const memories = await searchMemories(currentTask.task_name);

  // カレンダー情報を取得
  let nextEventInfo = '';
  let noScheduleReminder = '';

  if (isCalendarConfigured()) {
    const nextEvent = await getNextEvent();
    if (nextEvent) {
      const minutesUntil = getMinutesUntilEvent(nextEvent);
      nextEventInfo = `\n- 次の予定: ${formatEventForDisplay(nextEvent)} (${minutesUntil}分後)`;
    } else {
      // 次の予定がない場合
      const hasEvents = await hasRemainingEventsToday();
      if (!hasEvents) {
        const freeMinutes = await getFreeTimeMinutes();
        if (freeMinutes > 30) {
          noScheduleReminder = `\n- 注意: 今日の残り時間に予定が入っていません（空き時間: 約${Math.floor(freeMinutes / 60)}時間${freeMinutes % 60}分）`;
        }
      }
    }
  }

  const context = getTaskCompleteContext({
    taskName: currentTask.task_name,
    duration: currentTask.duration_minutes,
    elapsed,
    comment,
    currentTime: getJSTTime(),
    mem0Context: memories,
    nextEvent: nextEventInfo || noScheduleReminder,
  });

  const response = await generateResponse(context);
  storage.addMessage('assistant', response);
  await saveMemory(`[タスク完了] ${currentTask.task_name} (予定${currentTask.duration_minutes}分→実際${elapsed}分)${comment ? ` 感想: ${comment}` : ''}`);

  // 次の予定がなければ、予定未登録リマインダーを開始
  if (noScheduleReminder) {
    startNoScheduleReminder();
  }

  return { success: true, response };
}

export async function executeSkip(): Promise<CommandResult> {
  const currentTask = storage.getCurrentTask();
  if (!currentTask) {
    return {
      success: false,
      response: '進行中のタスクがありません。',
    };
  }

  const elapsed = storage.getElapsedMinutes(currentTask);
  storage.skipTask(currentTask.id);
  stopTaskReminder();

  // カレンダーのイベントを更新
  if (currentTask.calendar_event_id) {
    await updateTaskEvent({
      eventId: currentTask.calendar_event_id,
      taskName: currentTask.task_name,
      actualMinutes: elapsed,
      status: 'skipped',
    });
  }

  const memories = await searchMemories(currentTask.task_name);

  const context = getTaskSkipContext({
    taskName: currentTask.task_name,
    duration: currentTask.duration_minutes,
    elapsed,
    currentTime: getJSTTime(),
    mem0Context: memories,
  });

  const response = await generateResponse(context);
  storage.addMessage('assistant', response);
  await saveMemory(`[タスクスキップ] ${currentTask.task_name}`);

  return { success: true, response };
}

export async function executeStatus(): Promise<CommandResult> {
  const currentTask = storage.getCurrentTask();
  if (!currentTask) {
    return {
      success: true,
      response: '進行中のタスクがありません。何か始めますか？',
    };
  }

  const elapsed = storage.getElapsedMinutes(currentTask);

  const context = getStatusContext({
    taskName: currentTask.task_name,
    duration: currentTask.duration_minutes,
    elapsed,
    currentTime: getJSTTime(),
  });

  const response = await generateResponse(context);
  return { success: true, response };
}

export async function executeBreak(minutes: number): Promise<CommandResult> {
  // 休憩中は予定未登録リマインダーを停止
  stopNoScheduleReminder();
  startBreakTimer(minutes);

  const context = getBreakStartContext(minutes, getJSTTime());
  const response = await generateResponse(context);
  storage.addMessage('assistant', response);

  return { success: true, response };
}

export async function executeDoneToday(): Promise<CommandResult> {
  const currentTask = storage.getCurrentTask();
  if (currentTask) {
    const elapsed = storage.getElapsedMinutes(currentTask);
    storage.skipTask(currentTask.id);
    stopTaskReminder();

    // カレンダーのイベントを更新
    if (currentTask.calendar_event_id) {
      await updateTaskEvent({
        eventId: currentTask.calendar_event_id,
        taskName: currentTask.task_name,
        actualMinutes: elapsed,
        status: 'skipped',
      });
    }
  }
  // 今日の作業終了なので予定未登録リマインダーも停止
  stopNoScheduleReminder();

  const todayTasks = storage.getTodayTasks();
  const completedCount = todayTasks.filter(t => t.status === 'done').length;

  const context = `【状況】ご主人様が今日の作業終了を宣言しました
- 今日の完了タスク数: ${completedCount}
- 現在時刻: ${getJSTTime()}

今日の頑張りを労い、ゆっくり休むよう促してください。`;

  const response = await generateResponse(context);
  storage.addMessage('assistant', response);
  await saveMemory(`[1日終了] 完了タスク数: ${completedCount}`);

  return { success: true, response };
}

export async function executeHistory(days: number = 0): Promise<CommandResult> {
  const tasks = days > 0
    ? storage.getTasksInDays(days)
    : storage.getTodayTasks();

  if (tasks.length === 0) {
    return {
      success: true,
      response: days > 0
        ? `過去${days}日間のタスク履歴がありません。`
        : '今日のタスク履歴がありません。',
    };
  }

  const taskList = tasks.map(t => ({
    name: t.task_name,
    duration: t.duration_minutes,
    elapsed: t.completed_at ? storage.getElapsedMinutes({ ...t, started_at: t.started_at }) : 0,
    status: t.status === 'done' ? '完了' : t.status === 'skipped' ? 'スキップ' : '進行中',
  }));

  const context = getHistoryContext(taskList);
  const response = await generateResponse(context);

  const historyText = tasks.map((t) => {
    const status = t.status === 'done' ? '✓' : t.status === 'skipped' ? '→' : '⏳';
    return `${status} ${t.task_name} (${t.duration_minutes}分)`;
  }).join('\n');

  return { success: true, response: `${response}\n\n**履歴:**\n${historyText}` };
}

// ========== スラッシュコマンドハンドラ ==========

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const commandName = interaction.commandName;

  try {
    await interaction.deferReply();
    let result: CommandResult;

    switch (commandName) {
      case 'next': {
        const taskName = interaction.options.getString('task', true);
        const minutes = interaction.options.getInteger('minutes', true);
        result = await executeNext(taskName, minutes);
        break;
      }
      case 'done': {
        const comment = interaction.options.getString('comment') ?? undefined;
        result = await executeDone(comment);
        break;
      }
      case 'skip':
        result = await executeSkip();
        break;
      case 'status':
        result = await executeStatus();
        break;
      case 'break': {
        const minutes = interaction.options.getInteger('minutes', true);
        result = await executeBreak(minutes);
        break;
      }
      case 'done_today':
        result = await executeDoneToday();
        break;
      case 'history': {
        const days = interaction.options.getInteger('days') ?? 0;
        result = await executeHistory(days);
        break;
      }
      default:
        result = { success: false, response: '不明なコマンドです。' };
    }

    await interaction.editReply(result.response);
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('すみません、エラーが発生しました...');
    } else {
      await interaction.editReply('すみません、エラーが発生しました...');
    }
  }
}

export function registerCommands(client: Client): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (['next', 'done', 'skip', 'status', 'break', 'done_today', 'history'].includes(interaction.commandName)) {
      await handleCommand(interaction);
    }
  });
}
