import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Client,
} from 'discord.js';
import { storage } from '../storage.js';
import { parseCronFromNaturalLanguage, generateConfirmationMessage } from '../services/grok.js';
import type { CommandResult } from './task.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('カスタムリマインドを管理')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('リマインドを追加（自然言語で入力）')
        .addStringOption(option =>
          option.setName('text')
            .setDescription('例: 平日の朝9時に薬飲んだか確認して')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('登録済みリマインド一覧'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('リマインドを削除')
        .addIntegerOption(option =>
          option.setName('id')
            .setDescription('削除するリマインドのID')
            .setRequired(true))),
];

// ========== コアロジック（外部から呼び出し可能） ==========

export async function executeRemindAdd(text: string): Promise<CommandResult> {
  const parsed = await parseCronFromNaturalLanguage(text);
  if (!parsed) {
    return {
      success: false,
      response: 'リマインドの解析に失敗しました。もう少し具体的に入力してください。',
    };
  }

  const remind = storage.createCustomRemind(
    parsed.time,
    parsed.days,
    parsed.include_holidays,
    parsed.message
  );

  const confirmation = await generateConfirmationMessage(parsed);
  return { success: true, response: `${confirmation}\n\n(ID: ${remind.id})` };
}

export async function executeRemindList(): Promise<CommandResult> {
  const reminds = storage.getAllCustomReminds();

  if (reminds.length === 0) {
    return { success: true, response: '登録されているリマインドはありません。' };
  }

  const daysJp: Record<string, string> = {
    mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日'
  };

  const list = reminds.map(r => {
    const days = (JSON.parse(r.days) as string[]).map(d => daysJp[d] ?? d).join('');
    const holiday = r.include_holidays ? '(祝日含む)' : '';
    return `**${r.id}.** ${r.time} [${days}]${holiday}\n   「${r.message}」`;
  }).join('\n\n');

  return { success: true, response: `**登録済みリマインド:**\n\n${list}` };
}

export async function executeRemindDelete(id: number): Promise<CommandResult> {
  const remind = storage.getCustomRemind(id);
  if (!remind) {
    return { success: false, response: `ID ${id} のリマインドは見つかりませんでした。` };
  }

  storage.deleteCustomRemind(id);
  return { success: true, response: `リマインド「${remind.message}」を削除しました。` };
}

// ========== スラッシュコマンドハンドラ ==========

export async function handleRemindCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  try {
    await interaction.deferReply();
    let result: CommandResult;

    switch (subcommand) {
      case 'add': {
        const text = interaction.options.getString('text', true);
        result = await executeRemindAdd(text);
        break;
      }
      case 'list':
        result = await executeRemindList();
        break;
      case 'delete': {
        const id = interaction.options.getInteger('id', true);
        result = await executeRemindDelete(id);
        break;
      }
      default:
        result = { success: false, response: '不明なコマンドです。' };
    }

    await interaction.editReply(result.response);
  } catch (error) {
    console.error(`Error handling remind command:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('すみません、エラーが発生しました...');
    } else {
      await interaction.editReply('すみません、エラーが発生しました...');
    }
  }
}

export function registerRemindCommands(client: Client): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'remind') return;
    await handleRemindCommand(interaction);
  });
}
