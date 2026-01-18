import { isHoliday } from './holidays.js';

export type TimeSlot = 'morning' | 'work' | 'evening' | 'night' | 'sleep';

interface NotificationWindow {
  allowed: boolean;
  slot: TimeSlot;
}

function getJSTDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

export function isWeekend(date: Date = getJSTDate()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function isWorkday(date: Date = getJSTDate()): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

export function getTimeSlot(date: Date = getJSTDate()): TimeSlot {
  const hour = date.getHours();

  if (hour >= 22 || hour < 7) {
    return 'sleep';
  }
  if (hour >= 7 && hour < 10) {
    return 'morning';
  }
  if (hour >= 10 && hour < 19) {
    return 'work';
  }
  if (hour >= 19 && hour < 22) {
    return 'evening';
  }
  return 'sleep';
}

export function checkNotificationWindow(date: Date = getJSTDate()): NotificationWindow {
  const slot = getTimeSlot(date);
  const workday = isWorkday(date);

  // 睡眠時間は常に通知OFF
  if (slot === 'sleep') {
    return { allowed: false, slot };
  }

  // 平日の仕事時間は通知OFF
  if (workday && slot === 'work') {
    return { allowed: false, slot };
  }

  // その他は通知ON
  return { allowed: true, slot };
}

export function getDayOfWeek(date: Date = getJSTDate()): string {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[date.getDay()]!;
}

export function isDeepNight(date: Date = getJSTDate()): boolean {
  const hour = date.getHours();
  return hour >= 22 || hour < 5;
}
