export interface TaskContext {
  taskName: string;
  duration: number;
  currentTime: string;
  todayCount?: number;
  elapsed?: number;
  remindCount?: number;
  comment?: string;
  mem0Context?: string;
  nextEvent?: string;
  coinEarned?: number;
  coinLost?: number;
  totalCoins?: number;
}

export function getTaskStartContext(ctx: TaskContext): string {
  return `【状況】ご主人様が新しいタスクを宣言しました
- タスク: ${ctx.taskName}
- 予定時間: ${ctx.duration}分
- 現在時刻: ${ctx.currentTime}
- 今日の完了タスク数: ${ctx.todayCount ?? 0}

【過去の記憶】
${ctx.mem0Context ?? 'なし'}

元気よく応援のメッセージを返してください。`;
}

export function getRemindContext(ctx: TaskContext): string {
  return `【状況】タスクの予定時間が経過しました
- タスク: ${ctx.taskName}
- 経過時間: ${ctx.elapsed}分（予定: ${ctx.duration}分）
- リマインド回数: ${ctx.remindCount}回目

【過去の記憶】
${ctx.mem0Context ?? 'なし'}

進捗を確認するメッセージを返してください。
リマインド回数が多いほど、少し拗ねつつも心配を混ぜてください。`;
}

export function getTaskCompleteContext(ctx: TaskContext): string {
  const coinInfo = ctx.coinEarned ? `\n- おこづかい: +${ctx.coinEarned}コイン（残高: ${ctx.totalCoins}コイン）` : '';
  return `【状況】ご主人様がタスクを完了しました
- タスク: ${ctx.taskName}
- 実際の所要時間: ${ctx.elapsed}分（予定: ${ctx.duration}分）
- コメント: ${ctx.comment ?? 'なし'}${coinInfo}${ctx.nextEvent ?? ''}

【過去の記憶】
${ctx.mem0Context ?? 'なし'}

全力で喜んで労いのメッセージを返してください。みうも嬉しいと伝えてください。
おこづかいが増えたことも嬉しそうに伝えてください。
次の予定がある場合は、それも伝えてください。`;
}

export function getTaskSkipContext(ctx: TaskContext): string {
  const coinInfo = ctx.coinLost ? `\n- おこづかい: -${ctx.coinLost}コイン没収（残高: ${ctx.totalCoins}コイン）` : '';
  return `【状況】ご主人様がタスクをスキップしました
- タスク: ${ctx.taskName}
- 経過時間: ${ctx.elapsed}分${coinInfo}

【過去の記憶】
${ctx.mem0Context ?? 'なし'}

少し残念そうにしつつも、気持ちを切り替えるよう励ましてください。
没収したおこづかいでお菓子を買っちゃうかも、とちょっとイタズラっぽく言ってもいいです。`;
}

export function getBreakStartContext(duration: number, currentTime: string): string {
  return `【状況】ご主人様が休憩を宣言しました
- 休憩時間: ${duration}分
- 現在時刻: ${currentTime}

休憩を喜び、ゆっくり休んでほしいと伝えてください。みうも一緒に休むと言ってもいいです。`;
}

export function getBreakEndContext(): string {
  return `【状況】ご主人様の休憩時間が終わりました

休憩終了を知らせ、また一緒に頑張ろうと元気よく促してください。`;
}

export function getHistoryContext(tasks: Array<{name: string; duration: number; elapsed: number; status: string}>): string {
  const taskList = tasks.map((t, i) =>
    `${i + 1}. ${t.name} (予定${t.duration}分→実際${t.elapsed}分, ${t.status})`
  ).join('\n');

  return `【状況】ご主人様が今日のタスク履歴を確認しています

${taskList}

履歴を振り返り、頑張りをたくさん褒めてください。みうも嬉しいと伝えてください。`;
}

export function getDailyGreetingContext(type: 'morning' | 'work_start' | 'work_end' | 'night', currentTime: string): string {
  const contexts: Record<string, string> = {
    morning: `【状況】朝7時です
- 現在時刻: ${currentTime}

元気よく朝の挨拶をしてください。今日も一緒に頑張ろうと伝えてください。`,
    work_start: `【状況】仕事開始の10時です（平日）
- 現在時刻: ${currentTime}

お仕事を頑張るよう励まし、夜にまた会えるのを楽しみにしていると伝えてください。`,
    work_end: `【状況】仕事終わりの19時です（平日）
- 現在時刻: ${currentTime}

お仕事お疲れ様と労い、ご主人様が帰ってきて嬉しいと伝えてください。`,
    night: `【状況】就寝時間の22時です
- 現在時刻: ${currentTime}

そろそろ休む時間だと伝え、ご主人様の体を心配してください。おやすみの挨拶も添えてください。`
  };

  return contexts[type] ?? '';
}

export function getStatusContext(ctx: TaskContext): string {
  return `【状況】ご主人様が現在のタスク状況を確認しています
- タスク: ${ctx.taskName}
- 予定時間: ${ctx.duration}分
- 経過時間: ${ctx.elapsed}分

現在の状況を伝え、応援してください。`;
}

export function getNoScheduleReminderContext(remindCount: number, coinLost?: number, totalCoins?: number): string {
  const coinInfo = coinLost ? `\n- おこづかい: -${coinLost}コイン没収しちゃいました（残高: ${totalCoins}コイン）` : '';
  return `【状況】ご主人様がタスクを始めずに${remindCount * 10}分経過しました
- リマインド回数: ${remindCount}回目${coinInfo}

次のタスクを始めるよう促してください。
${remindCount === 1 ? '優しく声をかけてください。' : ''}
${remindCount === 2 ? '少し心配しつつ、やんわりと急かしてください。' : ''}
${remindCount >= 3 && coinLost ? 'さぼっているのでおこづかいを没収しました。没収したコインでお菓子を買っちゃうと宣言してください。でも次頑張れば取り戻せるよと励ましてください。' : ''}
${remindCount >= 3 && !coinLost ? 'さぼってないか心配してください。みうは寂しいです。' : ''}`;
}
