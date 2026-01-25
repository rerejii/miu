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
      scopes: ['https://www.googleapis.com/auth/calendar'],  // 読み書き両方
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

// 今日の残り時間に予定があるかチェック
export async function hasRemainingEventsToday(): Promise<boolean> {
  const events = await getUpcomingEvents(12); // 12時間先まで確認
  const now = getJSTDate();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  // 今日中に始まる予定があるか
  return events.some(event => event.start <= endOfDay);
}

// 空き時間を取得（次の予定までの分数、予定がなければ就寝時間(22時)までの分数）
export async function getFreeTimeMinutes(): Promise<number> {
  const now = getJSTDate();
  const nextEvent = await getNextEvent();

  if (nextEvent) {
    return getMinutesUntilEvent(nextEvent);
  }

  // 予定がなければ22時までの時間を返す
  const bedtime = new Date(now);
  bedtime.setHours(22, 0, 0, 0);

  if (now >= bedtime) {
    return 0; // 既に22時過ぎ
  }

  return Math.floor((bedtime.getTime() - now.getTime()) / (1000 * 60));
}

// タスクをカレンダーに作成
export interface CreateTaskEventParams {
  taskName: string;
  durationMinutes: number;
  taskId: number;
}

export async function createTaskEvent(params: CreateTaskEventParams): Promise<string | null> {
  const client = getCalendarClient();
  if (!client) return null;

  try {
    const now = getJSTDate();
    const endTime = new Date(now.getTime() + params.durationMinutes * 60 * 1000);

    const response = await client.events.insert({
      calendarId: config.googleCalendar.calendarId,
      requestBody: {
        summary: `[タスク] ${params.taskName}`,
        description: `miu-bot タスクID: ${params.taskId}`,
        start: {
          dateTime: now.toISOString(),
          timeZone: 'Asia/Tokyo',
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'Asia/Tokyo',
        },
        colorId: '9', // 青紫色
      },
    });

    console.log(`Calendar event created: ${response.data.id}`);
    return response.data.id ?? null;
  } catch (error) {
    console.error('Failed to create calendar event:', error);
    return null;
  }
}

// カレンダーのタスクイベントを更新（完了/スキップ時）
export interface UpdateTaskEventParams {
  eventId: string;
  taskName: string;
  actualMinutes: number;
  status: 'done' | 'skipped';
}

export async function updateTaskEvent(params: UpdateTaskEventParams): Promise<boolean> {
  const client = getCalendarClient();
  if (!client) return false;

  try {
    // 現在のイベントを取得
    const event = await client.events.get({
      calendarId: config.googleCalendar.calendarId,
      eventId: params.eventId,
    });

    if (!event.data.start?.dateTime) return false;

    const startTime = new Date(event.data.start.dateTime);
    const actualEndTime = new Date(startTime.getTime() + params.actualMinutes * 60 * 1000);

    const statusEmoji = params.status === 'done' ? '✓' : '→';
    const statusText = params.status === 'done' ? '完了' : 'スキップ';

    await client.events.update({
      calendarId: config.googleCalendar.calendarId,
      eventId: params.eventId,
      requestBody: {
        ...event.data,
        summary: `${statusEmoji} ${params.taskName}`,
        description: `${event.data.description}\n${statusText}: ${params.actualMinutes}分`,
        end: {
          dateTime: actualEndTime.toISOString(),
          timeZone: 'Asia/Tokyo',
        },
        colorId: params.status === 'done' ? '10' : '8', // 完了=緑, スキップ=グレー
      },
    });

    console.log(`Calendar event updated: ${params.eventId}`);
    return true;
  } catch (error) {
    console.error('Failed to update calendar event:', error);
    return false;
  }
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
