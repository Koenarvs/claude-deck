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

// ── Formatted conversation (on-demand JSONL → markdown) ─────────────────────

export interface FormattedConversation {
  content: string;
  totalLines: number;
  hasMore: boolean;
}

export function getFormattedConversation(
  goalId: string,
  options?: { tail?: number; offset?: number },
): FormattedConversation | null {
  const filePath = findJsonlFile(goalId);
  if (!filePath) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const chunks: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const md = formatConversationEntry(entry);
        if (md) chunks.push(md);
      } catch { /* skip malformed */ }
    }

    const allContent = chunks.join('');
    const allLines = allContent.split('\n');
    const totalLines = allLines.length;

    const tail = options?.tail ?? 0;
    const offset = options?.offset ?? 0;

    if (tail > 0) {
      const end = Math.max(0, totalLines - offset);
      const start = Math.max(0, end - tail);
      const sliced = allLines.slice(start, end).join('\n');
      return { content: sliced, totalLines, hasMore: start > 0 };
    }

    return { content: allContent, totalLines, hasMore: false };
  } catch (err) {
    logger.error({ err, goalId }, 'Failed to read formatted conversation');
    return null;
  }
}

function formatConversationEntry(entry: Record<string, unknown>): string | null {
  const type = entry.type as string;
  if (type !== 'user' && type !== 'assistant') return null;

  const timestamp = entry.timestamp as string | undefined;
  const timeStr = timestamp ? formatTime(timestamp) : '';
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const content = msg.content;

  if (type === 'user') {
    if (typeof content === 'string' && content.trim()) {
      return `### You — ${timeStr}\n\n${content.trim()}\n\n---\n\n`;
    }
    if (Array.isArray(content)) {
      return formatToolResults(content);
    }
    return null;
  }

  if (type === 'assistant' && Array.isArray(content)) {
    return formatAssistantBlocks(content, timeStr);
  }

  return null;
}

function formatAssistantBlocks(blocks: unknown[], timeStr: string): string | null {
  const parts: string[] = [];
  let hasTextHeader = false;

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const blockType = b.type as string;

    if (blockType === 'text' && typeof b.text === 'string' && b.text.trim()) {
      if (!hasTextHeader) {
        parts.push(`### Claude — ${timeStr}\n\n`);
        hasTextHeader = true;
      }
      parts.push(`${b.text.trim()}\n\n`);
    } else if (blockType === 'tool_use') {
      const toolName = b.name as string;
      const toolInput = (b.input as Record<string, unknown>) ?? {};
      const summary = summarizeToolInput(toolName, toolInput);
      const label = summary ? `\`${toolName}\` — ${summary}` : `\`${toolName}\``;
      parts.push(`> **Tool:** ${label}\n\n`);
    }
  }

  if (parts.length === 0) return null;
  parts.push('---\n\n');
  return parts.join('');
}

function formatToolResults(blocks: unknown[]): string | null {
  const parts: string[] = [];

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;

    const isError = b.is_error === true;
    const content = b.content;
    let summary: string;

    if (isError) {
      const text = typeof content === 'string' ? content : '';
      summary = 'Error: ' + (text.length > 100 ? text.slice(0, 97) + '...' : text);
    } else if (typeof content === 'string') {
      summary = content.length > 80 ? `${content.length} chars` : content;
    } else {
      summary = 'ok';
    }

    parts.push(`> **Result:** ${summary}\n\n`);
  }

  if (parts.length === 0) return null;
  parts.push('---\n\n');
  return parts.join('');
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const lastSegments = (p: string) => p.replace(/\\/g, '/').split('/').slice(-2).join('/');

  switch (name) {
    case 'Read':
      return lastSegments(String(input.file_path ?? ''));
    case 'Write':
    case 'Edit':
      return lastSegments(String(input.file_path ?? ''));
    case 'Bash': {
      const cmd = String(input.command ?? '');
      return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
    }
    case 'Grep': {
      const pattern = String(input.pattern ?? '');
      const grepPath = lastSegments(String(input.path ?? '.'));
      return `\`${pattern}\` in ${grepPath}`;
    }
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Agent':
      return String(input.description ?? '');
    default:
      return '';
  }
}

function formatTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ── Terminal transcript formatting ──────────────────────────────────────────

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
