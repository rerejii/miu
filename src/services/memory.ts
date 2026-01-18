import { config } from '../config.js';

interface Memory {
  id: string;
  memory: string;
  created_at: string;
}

export async function searchMemories(query: string, limit: number = 5): Promise<string> {
  try {
    const response = await fetch(`${config.mem0.baseUrl}/memories/search/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${config.mem0.apiKey}`,
      },
      body: JSON.stringify({
        query,
        user_id: config.discord.userId,
        limit,
      }),
    });

    if (!response.ok) {
      console.error(`Mem0 search error: ${response.status}`);
      return '';
    }

    const data = await response.json();

    if (Array.isArray(data)) {
      return data.map((m: { memory: string }) => m.memory).join('\n');
    }
    if (data.results && Array.isArray(data.results)) {
      return data.results.map((m: { memory: string }) => m.memory).join('\n');
    }
    return '';
  } catch (error) {
    console.error('Mem0 search error:', error);
    return '';
  }
}

export async function getRecentMemories(limit: number = 10): Promise<string> {
  try {
    const response = await fetch(
      `${config.mem0.baseUrl}/memories/?user_id=${config.discord.userId}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Token ${config.mem0.apiKey}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`Mem0 get error: ${response.status}`);
      return '';
    }

    const data = (await response.json()) as Memory[];
    return data.map((m) => m.memory).join('\n');
  } catch (error) {
    console.error('Mem0 get error:', error);
    return '';
  }
}

export async function saveMemory(content: string): Promise<void> {
  try {
    const response = await fetch(`${config.mem0.baseUrl}/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${config.mem0.apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content }],
        user_id: config.discord.userId,
      }),
    });

    if (!response.ok) {
      console.error(`Mem0 save error: ${response.status}`);
      return;
    }

    const data = await response.json();
    const count = data?.results?.length ?? (Array.isArray(data) ? data.length : 0);
    console.log('Memory saved:', count, 'entries');
  } catch (error) {
    console.error('Mem0 save error:', error);
  }
}
