import cron from 'node-cron';
import { storage } from '../storage.js';
import { generateResponse } from './grok.js';
import { searchMemories, saveMemory } from './memory.js';
import { checkNotificationWindow, isWorkday, getDayOfWeek, isHoliday } from './time_checker.js';
import { fetchHolidays, shouldRefreshHolidays } from './holidays.js';
import { getRemindContext, getDailyGreetingContext, getBreakEndContext } from '../prompts/index.js';
import { config } from '../config.js';

let sendDMCallback: ((content: string) => Promise<void>) | null = null;
let breakTimer: NodeJS.Timeout | null = null;
let taskReminderTimer: NodeJS.Timeout | null = null;
let firstReminderTimer: NodeJS.Timeout | null = null;

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
