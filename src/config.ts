import 'dotenv/config';

export const config = {
  discord: {
    token: process.env['DISCORD_TOKEN']!,
    userId: process.env['DISCORD_USER_ID']!,
  },
  grok: {
    apiKey: process.env['XAI_API_KEY']!,
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4-1-fast-reasoning',
  },
  mem0: {
    apiKey: process.env['MEM0_API_KEY']!,
    baseUrl: 'https://api.mem0.ai/v1',
  },
  timezone: process.env['TZ'] ?? 'Asia/Tokyo',
  reminderIntervalMinutes: 10,
};
