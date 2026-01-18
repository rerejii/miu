import { storage } from '../storage.js';

const HOLIDAYS_API_URL = 'https://holidays-jp.github.io/api/v1/date.json';

let holidaysCache: Map<string, string> = new Map();
let lastFetched: Date | null = null;

export async function fetchHolidays(): Promise<void> {
  try {
    const response = await fetch(HOLIDAYS_API_URL);
    if (!response.ok) {
      console.error(`Holidays API error: ${response.status}`);
      return;
    }

    const data = (await response.json()) as Record<string, string>;
    holidaysCache = new Map(Object.entries(data));
    lastFetched = new Date();

    // SQLiteにもキャッシュを保存
    for (const [date, name] of holidaysCache) {
      storage.cacheHoliday(date, name);
    }

    console.log(`Fetched ${holidaysCache.size} holidays`);
  } catch (error) {
    console.error('Failed to fetch holidays:', error);
    // フォールバック: SQLiteキャッシュから読み込み
    const cached = storage.getCachedHolidays();
    if (cached.length > 0) {
      holidaysCache = new Map(cached.map(h => [h.date, h.name]));
      console.log(`Loaded ${holidaysCache.size} holidays from cache`);
    }
  }
}

export function isHoliday(date: Date = new Date()): boolean {
  const dateStr = formatDate(date);
  return holidaysCache.has(dateStr);
}

export function getHolidayName(date: Date = new Date()): string | undefined {
  const dateStr = formatDate(date);
  return holidaysCache.get(dateStr);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shouldRefreshHolidays(): boolean {
  if (!lastFetched) return true;

  const now = new Date();
  const lastFetchedDay = lastFetched.toDateString();
  const today = now.toDateString();

  return lastFetchedDay !== today;
}

export async function initHolidays(): Promise<void> {
  await fetchHolidays();
}
