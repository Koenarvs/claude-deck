export type BrainStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; summary: string };

export interface BrainInvocationInput {
  prompt: string;
  model: string;
  mcpConfigJson: string; // serialized { mcpServers: {...} }
  permissionMode: 'autonomous' | 'supervised';
}

export interface BrainInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BrainProvider {
  buildInvocation(input: BrainInvocationInput): BrainInvocation;
  parseLine(line: string): BrainStreamEvent[];
}

/** Parses one stream-json line from `claude -p --output-format stream-json`. */
export function parseStreamLine(line: string): BrainStreamEvent[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const o = obj as { type?: string; message?: { content?: Array<Record<string, unknown>> } };
  if (o.type !== 'assistant' || !o.message?.content) return [];
  const events: BrainStreamEvent[] = [];
  for (const block of o.message.content) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      events.push({ kind: 'text', text: block['text'] });
    } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      events.push({
        kind: 'tool',
        tool: block['name'],
        summary: JSON.stringify(block['input'] ?? {}).slice(0, 200),
      });
    }
  }
  return events;
}

const MEMORY_RE = /<memory-update>\s*([\s\S]*?)\s*<\/memory-update>/;

/** Extracts the delimited memory block from the brain's full text output, or null. */
export function extractMemoryUpdate(fullText: string): string | null {
  const m = MEMORY_RE.exec(fullText);
  return m ? m[1]!.trim() : null;
}

/**
 * Claude Code headless brain provider. Builds `claude -p` print-mode args.
 * The binary is resolved by the caller (via the agent-adapter registry in production)
 * and passed in, keeping this module provider-agnostic.
 */
export class ClaudeBrainProvider implements BrainProvider {
  private readonly binary: string;
  constructor(binary: string) {
    this.binary = binary;
  }

  buildInvocation(input: BrainInvocationInput): BrainInvocation {
    return {
      command: this.binary,
      args: [
        '-p',
        input.prompt,
        '--model',
        input.model,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        input.permissionMode === 'autonomous' ? 'bypassPermissions' : 'default',
        '--mcp-config',
        input.mcpConfigJson,
      ],
      env: {},
    };
  }

  parseLine(line: string): BrainStreamEvent[] {
    return parseStreamLine(line);
  }
}
