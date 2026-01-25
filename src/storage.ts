import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway Volumes使用時は /app/data、ローカルは ./data
const DATA_DIR = process.env['RAILWAY_VOLUME_MOUNT_PATH'] || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'miu.db');

// データディレクトリがなければ作成
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 環境変数 RESET_DB=true でDBをリセット
if (process.env['RESET_DB'] === 'true' && fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Database reset completed:', DB_PATH);
}

export interface Task {
  id: number;
  task_name: string;
  duration_minutes: number;
  started_at: string;
  completed_at: string | null;
  status: 'working' | 'done' | 'skipped';
  comment: string | null;
  calendar_event_id: string | null;
  created_at: string;
}

export interface Reminder {
  id: number;
  task_id: number;
  remind_count: number;
  sent_at: string;
}

export interface CustomRemind {
  id: number;
  time: string;
  days: string;
  include_holidays: boolean;
  message: string;
  enabled: boolean;
  created_at: string;
}

export interface HolidayCache {
  date: string;
  name: string;
}

export interface RecentMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

// JST時刻をISO形式で取得
function getJSTISOString(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T');
}

class Storage {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        started_at DATETIME NOT NULL,
        completed_at DATETIME,
        status TEXT NOT NULL DEFAULT 'working',
        comment TEXT,
        calendar_event_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        remind_count INTEGER NOT NULL,
        sent_at DATETIME NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS custom_reminds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL,
        days TEXT NOT NULL,
        include_holidays BOOLEAN NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS holidays_cache (
        date TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS recent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // マイグレーション: calendar_event_id カラムを追加
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT');
    } catch {
      // カラムが既に存在する場合は無視
    }
  }

  // Tasks
  createTask(taskName: string, durationMinutes: number): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (task_name, duration_minutes, started_at, status)
      VALUES (?, ?, ?, 'working')
    `);
    const result = stmt.run(taskName, durationMinutes, getJSTISOString());
    return this.getTask(result.lastInsertRowid as number)!;
  }

  getTask(id: number): Task | undefined {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    return stmt.get(id) as Task | undefined;
  }

  getCurrentTask(): Task | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'working' ORDER BY started_at DESC LIMIT 1
    `);
    return stmt.get() as Task | undefined;
  }

  completeTask(id: number, comment?: string): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'done', completed_at = ?, comment = ?
      WHERE id = ?
    `);
    stmt.run(getJSTISOString(), comment ?? null, id);
  }

  skipTask(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET status = 'skipped', completed_at = ?
      WHERE id = ?
    `);
    stmt.run(getJSTISOString(), id);
  }

  extendTask(id: number, additionalMinutes: number): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET duration_minutes = duration_minutes + ?
      WHERE id = ?
    `);
    stmt.run(additionalMinutes, id);
  }

  resetCurrentTask(): Task | undefined {
    const currentTask = this.getCurrentTask();
    if (currentTask) {
      this.skipTask(currentTask.id);
      return currentTask;
    }
    return undefined;
  }

  setCalendarEventId(id: number, eventId: string): void {
    const stmt = this.db.prepare(`
      UPDATE tasks SET calendar_event_id = ?
      WHERE id = ?
    `);
    stmt.run(eventId, id);
  }

  getTodayTasks(): Task[] {
    const today = getJSTISOString().split('T')[0]; // YYYY-MM-DD
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE date(started_at) = ?
      ORDER BY started_at ASC
    `);
    return stmt.all(today) as Task[];
  }

  getTasksInDays(days: number): Task[] {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - days);
    const startDate = pastDate.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T');
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE started_at >= ?
      ORDER BY started_at DESC
    `);
    return stmt.all(startDate) as Task[];
  }

  getTodayCompletedCount(): number {
    const today = getJSTISOString().split('T')[0]; // YYYY-MM-DD
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE date(started_at) = ? AND status = 'done'
    `);
    const result = stmt.get(today) as { count: number };
    return result.count;
  }

  // Reminders
  addReminder(taskId: number): number {
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM reminders WHERE task_id = ?
    `);
    const countResult = countStmt.get(taskId) as { count: number };
    const remindCount = countResult.count + 1;

    const stmt = this.db.prepare(`
      INSERT INTO reminders (task_id, remind_count, sent_at)
      VALUES (?, ?, datetime('now', 'localtime'))
    `);
    stmt.run(taskId, remindCount);
    return remindCount;
  }

  getRemindCount(taskId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM reminders WHERE task_id = ?
    `);
    const result = stmt.get(taskId) as { count: number };
    return result.count;
  }

  // Custom Reminds
  createCustomRemind(time: string, days: string[], includeHolidays: boolean, message: string): CustomRemind {
    const stmt = this.db.prepare(`
      INSERT INTO custom_reminds (time, days, include_holidays, message)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(time, JSON.stringify(days), includeHolidays ? 1 : 0, message);
    return this.getCustomRemind(result.lastInsertRowid as number)!;
  }

  getCustomRemind(id: number): CustomRemind | undefined {
    const stmt = this.db.prepare('SELECT * FROM custom_reminds WHERE id = ?');
    const row = stmt.get(id) as CustomRemind | undefined;
    if (row) {
      row.include_holidays = Boolean(row.include_holidays);
      row.enabled = Boolean(row.enabled);
    }
    return row;
  }

  getAllCustomReminds(): CustomRemind[] {
    const stmt = this.db.prepare('SELECT * FROM custom_reminds WHERE enabled = 1');
    const rows = stmt.all() as CustomRemind[];
    return rows.map(row => ({
      ...row,
      include_holidays: Boolean(row.include_holidays),
      enabled: Boolean(row.enabled),
    }));
  }

  deleteCustomRemind(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM custom_reminds WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Holidays Cache
  cacheHoliday(date: string, name: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO holidays_cache (date, name, fetched_at)
      VALUES (?, ?, datetime('now', 'localtime'))
    `);
    stmt.run(date, name);
  }

  getCachedHolidays(): HolidayCache[] {
    const stmt = this.db.prepare('SELECT date, name FROM holidays_cache');
    return stmt.all() as HolidayCache[];
  }

  // Recent Messages
  addMessage(role: 'user' | 'assistant', content: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO recent_messages (role, content)
      VALUES (?, ?)
    `);
    stmt.run(role, content);

    // Keep only last 10 messages
    this.db.exec(`
      DELETE FROM recent_messages
      WHERE id NOT IN (
        SELECT id FROM recent_messages ORDER BY created_at DESC LIMIT 10
      )
    `);
  }

  getRecentMessages(): RecentMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM recent_messages ORDER BY created_at ASC
    `);
    return stmt.all() as RecentMessage[];
  }

  clearMessages(): void {
    this.db.exec('DELETE FROM recent_messages');
  }

  // Utility
  getElapsedMinutes(task: Task): number {
    // started_atはJST時刻のISO形式（例: 2024-01-01T12:00:00）
    // そのままDateにパースするとローカル時刻として解釈される
    const started = new Date(task.started_at);
    // 現在のJST時刻を取得
    const nowJST = new Date(getJSTISOString());
    return Math.floor((nowJST.getTime() - started.getTime()) / (1000 * 60));
  }
}

export const storage = new Storage();
