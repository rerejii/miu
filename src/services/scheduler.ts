import cron from 'node-cron';
import { storage } from '../storage.js';
import { generateResponse } from './grok.js';
import { searchMemories, saveMemory } from './memory.js';
import { checkNotificationWindow, isWorkday, getDayOfWeek, isHoliday } from './time_checker.js';
import { fetchHolidays, shouldRefreshHolidays } from './holidays.js';
import { getRemindContext, getDailyGreetingContext, getBreakEndContext, getNoScheduleReminderContext } from '../prompts/index.js';
import { config } from '../config.js';
import { isCalendarConfigured, getNextEventToday, getFreeTimeMinutes } from './calendar.js';

let sendDMCallback: ((content: string) => Promise<void>) | null = null;
let breakTimer: NodeJS.Timeout | null = null;
let taskReminderTimer: NodeJS.Timeout | null = null;
let firstReminderTimer: NodeJS.Timeout | null = null;
let noScheduleReminderTimer: NodeJS.Timeout | null = null;
let noScheduleInitialTimer: NodeJS.Timeout | null = null;
let noScheduleRemindCount: number = 0;

export function setDMCallback(callback: (content: string) => Promise<void>): void {
  sendDMCallback = callback;
}

async function sendDM(content: string): Promise<void> {
  if (sendDMCallback) {
    await sendDMCallback(content);
  }
}

function getJSTTime(): string {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// タスクリマインダーを開始
export function startTaskReminder(taskId: number): void {
  stopTaskReminder();

  const checkAndRemind = async () => {
    const task = storage.getTask(taskId);
    if (!task || task.status !== 'working') {
      stopTaskReminder();
      return;
    }

    const elapsed = storage.getElapsedMinutes(task);
    if (elapsed >= task.duration_minutes) {
      const remindCount = storage.addReminder(taskId);
      const memories = await searchMemories(task.task_name);

      const context = getRemindContext({
        taskName: task.task_name,
        duration: task.duration_minutes,
        elapsed,
        remindCount,
        currentTime: getJSTTime(),
        mem0Context: memories,
      });

      const response = await generateResponse(context);
      await sendDM(response);
      await saveMemory(`[リマインド${remindCount}回目] タスク「${task.task_name}」${elapsed}分経過`);
    }
  };

  // 最初のリマインドは予定時間後、以降は10分間隔
  const task = storage.getTask(taskId);
  if (task) {
    const elapsed = storage.getElapsedMinutes(task);
    const remaining = Math.max(1, task.duration_minutes - elapsed); // 最低1分待つ
    const firstDelay = remaining * 60 * 1000;

    console.log(`Task reminder scheduled: first in ${remaining} minutes`);

    firstReminderTimer = setTimeout(() => {
      checkAndRemind();
      taskReminderTimer = setInterval(checkAndRemind, config.reminderIntervalMinutes * 60 * 1000);
    }, firstDelay);
  }
}

export function stopTaskReminder(): void {
  if (firstReminderTimer) {
    clearTimeout(firstReminderTimer);
    firstReminderTimer = null;
  }
  if (taskReminderTimer) {
    clearInterval(taskReminderTimer);
    taskReminderTimer = null;
  }
}

// 休憩タイマー
export function startBreakTimer(durationMinutes: number): void {
  stopBreakTimer();

  breakTimer = setTimeout(async () => {
    const context = getBreakEndContext();
    const response = await generateResponse(context);
    await sendDM(response);
  }, durationMinutes * 60 * 1000);
}

export function stopBreakTimer(): void {
  if (breakTimer) {
    clearTimeout(breakTimer);
    breakTimer = null;
  }
}

// 予定未登録リマインダーを開始（タスク完了後、予定がないときに10分おきにリマインド）
export function startNoScheduleReminder(): void {
  stopNoScheduleReminder();

  if (!isCalendarConfigured()) {
    return;
  }

  noScheduleRemindCount = 0;

  const checkAndRemind = async () => {
    // 現在タスクが進行中なら停止
    const currentTask = storage.getCurrentTask();
    if (currentTask) {
      stopNoScheduleReminder();
      return;
    }

    // 今日の残り予定があるかチェック（明日の予定は関係なし）
    const nextEventToday = await getNextEventToday();
    if (nextEventToday) {
      console.log('Next event today found, stopping no-schedule reminder');
      stopNoScheduleReminder();
      return;
    }

    // 空き時間が30分以下なら停止（22時が近い）
    const freeMinutes = await getFreeTimeMinutes();
    if (freeMinutes <= 30) {
      console.log('Free time is less than 30 minutes, stopping no-schedule reminder');
      stopNoScheduleReminder();
      return;
    }

    // 通知可能時間帯かチェック
    const { allowed } = checkNotificationWindow();
    if (!allowed) {
      return;
    }

    noScheduleRemindCount++;
    console.log(`No-schedule reminder #${noScheduleRemindCount}`);

    const context = getNoScheduleReminderContext(freeMinutes, noScheduleRemindCount);
    const response = await generateResponse(context);
    await sendDM(response);
  };

  // 最初のリマインドは即座に（10秒後）、以降は10分間隔
  console.log('No-schedule reminder started: first reminder in 10 seconds, then every 10 minutes');
  noScheduleInitialTimer = setTimeout(() => {
    noScheduleInitialTimer = null;
    checkAndRemind();
    noScheduleReminderTimer = setInterval(checkAndRemind, config.reminderIntervalMinutes * 60 * 1000);
  }, 10 * 1000);  // 10秒後に最初のリマインド
}

export function stopNoScheduleReminder(): void {
  if (noScheduleInitialTimer) {
    clearTimeout(noScheduleInitialTimer);
    noScheduleInitialTimer = null;
  }
  if (noScheduleReminderTimer) {
    clearInterval(noScheduleReminderTimer);
    noScheduleReminderTimer = null;
  }
  noScheduleRemindCount = 0;
}

// 定期cron
export function startScheduledJobs(): void {
  // 毎日0:00に祝日リストを更新
  cron.schedule('0 0 * * *', async () => {
    console.log('Refreshing holidays...');
    await fetchHolidays();
  }, { timezone: 'Asia/Tokyo' });

  // 07:00 起床
  cron.schedule('0 7 * * *', async () => {
    const { allowed } = checkNotificationWindow();
    if (!allowed) return;

    const context = getDailyGreetingContext('morning', getJSTTime());
    const response = await generateResponse(context);
    await sendDM(response);
  }, { timezone: 'Asia/Tokyo' });

  // 10:00 出勤（平日のみ）
  cron.schedule('0 10 * * 1-5', async () => {
    if (!isWorkday()) return;

    const context = getDailyGreetingContext('work_start', getJSTTime());
    const response = await generateResponse(context);
    await sendDM(response);
  }, { timezone: 'Asia/Tokyo' });

  // 19:00 退勤（平日のみ）
  cron.schedule('0 19 * * 1-5', async () => {
    if (!isWorkday()) return;

    const context = getDailyGreetingContext('work_end', getJSTTime());
    const response = await generateResponse(context);
    await sendDM(response);
  }, { timezone: 'Asia/Tokyo' });

  // 22:00 就寝
  cron.schedule('0 22 * * *', async () => {
    const context = getDailyGreetingContext('night', getJSTTime());
    const response = await generateResponse(context);
    await sendDM(response);
  }, { timezone: 'Asia/Tokyo' });

  // 毎分: カスタムリマインドをチェック
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentDay = getDayOfWeek();
    const holiday = isHoliday();

    const reminds = storage.getAllCustomReminds();

    for (const remind of reminds) {
      if (remind.time !== currentTime) continue;

      const days = JSON.parse(remind.days) as string[];
      if (!days.includes(currentDay)) continue;

      if (holiday && !remind.include_holidays) continue;

      const { allowed } = checkNotificationWindow();
      if (!allowed) continue;

      await sendDM(remind.message);
    }
  }, { timezone: 'Asia/Tokyo' });

  console.log('Scheduled jobs started');
}

// Bot起動時にアクティブタスクを復元
export async function restoreActiveTask(): Promise<void> {
  const task = storage.getCurrentTask();
  if (task) {
    console.log(`Restoring active task: ${task.task_name}`);
    startTaskReminder(task.id);
  }
}
