import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../logger';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export function findJsonlFile(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const filePath = join(CLAUDE_PROJECTS_DIR, project, `${sessionId}.jsonl`);
      if (existsSync(filePath)) return filePath;
    }
  } catch { /* ignore */ }
  return null;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

function extractText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        parts.push(b['text']);
      } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
        parts.push(`[Tool: ${b['name']}]`);
      } else if (b['type'] === 'tool_result') {
        const resultContent = b['content'];
        if (typeof resultContent === 'string') {
          const truncated = resultContent.length > 200 ? resultContent.slice(0, 200) + '...' : resultContent;
          parts.push(`[Result: ${truncated}]`);
        }
      }
    }
  }
  return parts.join('\n');
}

export function getTranscript(sessionId: string): TranscriptMessage[] {
  const filePath = findJsonlFile(sessionId);
  if (!filePath) {
    logger.debug({ sessionId }, 'No JSONL transcript found');
    return [];
  }

  const messages: TranscriptMessage[] = [];
  try {
    const raw = readFileSync(filePath, { encoding: 'utf-8' });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const content = entry.message.content;
          const text = typeof content === 'string' ? content : extractText(content);
          if (text.trim()) messages.push({ role: 'user', text: text.trim() });
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text.trim()) messages.push({ role: 'assistant', text: text.trim() });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'Failed to read transcript');
  }
  return messages;
}

const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_DIM = '\x1b[2m';
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';

export function formatTranscriptForTerminal(messages: TranscriptMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  lines.push(`${ANSI_DIM}${'─'.repeat(60)}${ANSI_RESET}`);
  lines.push(`${ANSI_DIM}  Conversation history (from Claude Code transcript)${ANSI_RESET}`);
  lines.push(`${ANSI_DIM}${'─'.repeat(60)}${ANSI_RESET}`);
  lines.push('');

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`${ANSI_BOLD}${ANSI_GREEN}> You${ANSI_RESET}`);
      lines.push(msg.text);
      lines.push('');
    } else {
      lines.push(`${ANSI_BOLD}${ANSI_CYAN}> Claude${ANSI_RESET}`);
      lines.push(msg.text);
      lines.push('');
    }
  }

  lines.push(`${ANSI_DIM}${'─'.repeat(60)}${ANSI_RESET}`);
  lines.push(`${ANSI_DIM}  End of history — live session below${ANSI_RESET}`);
  lines.push(`${ANSI_DIM}${'─'.repeat(60)}${ANSI_RESET}`);
  lines.push('');

  return lines.join('\r\n');
}
