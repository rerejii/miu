import { google, calendar_v3 } from 'googleapis';
import { config } from '../config.js';

// Google Calendar API クライアント
let calendarClient: calendar_v3.Calendar | null = null;

// 認証とクライアント初期化
function getCalendarClient(): calendar_v3.Calendar | null {
  if (!config.googleCalendar.calendarId || !config.googleCalendar.privateKey) {
    return null;
  }

  if (calendarClient) {
    return calendarClient;
  }

  try {
    const auth = new google.auth.JWT({
      email: config.googleCalendar.serviceAccountEmail,
      key: config.googleCalendar.privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    calendarClient = google.calendar({ version: 'v3', auth });
    return calendarClient;
  } catch (error) {
    console.error('Failed to initialize Google Calendar client:', error);
    return null;
  }
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
}

// JST時刻を取得
function getJSTDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

// 今日の予定を取得
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const client = getCalendarClient();
  if (!client) return [];

  try {
    const now = getJSTDate();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await client.events.list({
      calendarId: config.googleCalendar.calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'Asia/Tokyo',
    });

    return (response.data.items ?? []).map(parseEvent).filter((e): e is CalendarEvent => e !== null);
  } catch (error) {
    console.error('Failed to fetch today events:', error);
    return [];
  }
}

// 次の予定を取得（指定時間以降）
export async function getUpcomingEvents(hours: number = 3): Promise<CalendarEvent[]> {
  const client = getCalendarClient();
  if (!client) return [];

  try {
    const now = getJSTDate();
    const future = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const response = await client.events.list({
      calendarId: config.googleCalendar.calendarId,
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'Asia/Tokyo',
      maxResults: 5,
    });

    return (response.data.items ?? []).map(parseEvent).filter((e): e is CalendarEvent => e !== null);
  } catch (error) {
    console.error('Failed to fetch upcoming events:', error);
    return [];
  }
}

// 直近の予定を1件取得
export async function getNextEvent(): Promise<CalendarEvent | null> {
  const events = await getUpcomingEvents(24);
  return events.length > 0 ? events[0] : null;
}

// APIレスポンスをCalendarEventに変換
function parseEvent(event: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!event.id || !event.summary) return null;

  const startTime = event.start?.dateTime ?? event.start?.date;
  const endTime = event.end?.dateTime ?? event.end?.date;

  if (!startTime || !endTime) return null;

  return {
    id: event.id,
    title: event.summary,
    start: new Date(startTime),
    end: new Date(endTime),
    location: event.location ?? undefined,
    description: event.description ?? undefined,
  };
}

// 予定を日本語フォーマットで表示
export function formatEventForDisplay(event: CalendarEvent): string {
  const startTime = event.start.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
  const endTime = event.end.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });

  let text = `${startTime}〜${endTime} ${event.title}`;
  if (event.location) {
    text += ` (${event.location})`;
  }
  return text;
}

// 次の予定までの時間を計算（分）
export function getMinutesUntilEvent(event: CalendarEvent): number {
  const now = getJSTDate();
  return Math.floor((event.start.getTime() - now.getTime()) / (1000 * 60));
}

// カレンダーが設定されているか確認
export function isCalendarConfigured(): boolean {
  return !!(
    config.googleCalendar.calendarId &&
    config.googleCalendar.serviceAccountEmail &&
    config.googleCalendar.privateKey
  );
}

// 初期化テスト
export async function testCalendarConnection(): Promise<boolean> {
  if (!isCalendarConfigured()) {
    console.log('Google Calendar is not configured');
    return false;
  }

  try {
    const events = await getTodayEvents();
    console.log(`Google Calendar connected. Today's events: ${events.length}`);
    return true;
  } catch (error) {
    console.error('Google Calendar connection failed:', error);
    return false;
  }
}
