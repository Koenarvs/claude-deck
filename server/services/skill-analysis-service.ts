import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { broadcast } from '../ws';
import logger from '../logger';
import type { SkillExecution } from './skill-execution-service';

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillSuggestion {
  id: string;
  skill_name: string;
  skill_path: string | null;
  execution_id: string | null;
  suggestion_type: 'description' | 'instruction' | 'parameter' | 'structure';
  title: string;
  description: string | null;
  diff_content: string;
  status: 'pending' | 'applied' | 'dismissed';
  created_at: number;
  applied_at: number | null;
  content_hash: string | null;
}

interface SuggestionRow {
  id: string;
  skill_name: string;
  skill_path: string | null;
  execution_id: string | null;
  suggestion_type: string;
  title: string;
  description: string | null;
  diff_content: string;
  status: string;
  created_at: number;
  applied_at: number | null;
  content_hash: string | null;
}

function rowToSuggestion(row: SuggestionRow): SkillSuggestion {
  return {
    ...row,
    suggestion_type: row.suggestion_type as SkillSuggestion['suggestion_type'],
    status: row.status as SkillSuggestion['status'],
  };
}

// ── Analysis Prompt ─────────────────────────────────────────────────────────

function buildAnalysisPrompt(skillContent: string, skillName: string, executions: SkillExecution[]): string {
  const executionSummaries = executions.map((e) => {
    return `- Execution ${e.id.slice(0, 8)}: outcome=${e.outcome}, duration=${e.duration_s?.toFixed(1) ?? '?'}s, cost=$${e.estimated_cost_usd?.toFixed(4) ?? '?'}, tools=${e.tool_call_count}, errors=${e.tool_error_count}, rating=${e.user_rating ?? 'unrated'}${e.user_notes ? `, notes="${e.user_notes}"` : ''}`;
  }).join('\n');

  return `You are a skill improvement analyst for Claude Code. Analyze the following skill definition and its execution history, then suggest specific improvements.

## Current SKILL.md Content

\`\`\`markdown
${skillContent}
\`\`\`

## Execution History (${executions.length} runs)

${executionSummaries || 'No executions recorded yet.'}

## Task

Analyze the skill and suggest improvements. For each suggestion, provide:
1. A category: one of "description", "instruction", "parameter", or "structure"
2. A short title (under 80 chars)
3. A description explaining why this improvement would help
4. A unified diff showing the exact changes to the SKILL.md file

Output your suggestions as a JSON array. Each element must have:
- "suggestion_type": one of "description", "instruction", "parameter", "structure"
- "title": string
- "description": string
- "diff_content": string (valid unified diff with --- and +++ headers, @@ hunk markers)

The diff must be against the exact content shown above. Use "--- a/SKILL.md" and "+++ b/SKILL.md" as file headers.

Respond with ONLY a JSON array of suggestions. No other text. If no improvements are needed, respond with an empty array [].

Example format:
[
  {
    "suggestion_type": "instruction",
    "title": "Add error handling guidance",
    "description": "The skill lacks error handling instructions, leading to failures when...",
    "diff_content": "--- a/SKILL.md\\n+++ b/SKILL.md\\n@@ -5,3 +5,5 @@\\n # Skill Name\\n \\n Follow these steps:\\n+\\n+## Error Handling\\n+Handle errors by..."
  }
]`;
}

// ── Content Hash ─────────────────────────────────────────────────────────────

function computeContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createSkillAnalysisService(db: Database.Database) {
  const insertSuggestionStmt = db.prepare<[string, string, string | null, string | null, string, string, string | null, string, string, number, string | null]>(
    `INSERT INTO skill_suggestions (id, skill_name, skill_path, execution_id, suggestion_type, title, description, diff_content, status, created_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );

  const getSuggestionsStmt = db.prepare<[string], SuggestionRow>(
    `SELECT * FROM skill_suggestions WHERE skill_name = ? AND status = 'pending' ORDER BY created_at DESC`,
  );

  const getSuggestionByIdStmt = db.prepare<[string], SuggestionRow>(
    `SELECT * FROM skill_suggestions WHERE id = ?`,
  );

  const updateStatusStmt = db.prepare<[string, number | null, string]>(
    `UPDATE skill_suggestions SET status = ?, applied_at = ? WHERE id = ?`,
  );

  async function analyzeSkill(
    skillName: string,
    skillPath: string | null,
    executions: SkillExecution[],
  ): Promise<SkillSuggestion[]> {
    if (!skillPath) {
      logger.warn({ skillName }, 'Cannot analyze skill without path');
      return [];
    }

    let skillContent: string;
    try {
      skillContent = readFileSync(skillPath, 'utf-8');
    } catch (err) {
      logger.error({ err, skillPath }, 'Failed to read SKILL.md for analysis');
      return [];
    }

    const contentHash = computeContentHash(skillContent);
    const prompt = buildAnalysisPrompt(skillContent, skillName, executions);

    let rawOutput: string;
    try {
      const { stdout } = await execFileAsync('claude', ['--print', '-'], {
        input: prompt,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      rawOutput = stdout.trim();
    } catch (err) {
      logger.error({ err, skillName }, 'Claude CLI analysis failed');
      throw new Error('Analysis failed — Claude CLI returned an error');
    }

    // Parse JSON array from response (handle markdown code fences)
    let jsonStr = rawOutput;
    const fenceMatch = rawOutput.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1];
    }

    let parsed: Array<{
      suggestion_type: string;
      title: string;
      description: string;
      diff_content: string;
    }>;
    try {
      parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');
    } catch (err) {
      logger.error({ err, rawOutput: rawOutput.slice(0, 500) }, 'Failed to parse analysis response');
      throw new Error('Analysis failed — could not parse Claude response as JSON');
    }

    const validTypes = new Set(['description', 'instruction', 'parameter', 'structure']);
    const suggestions: SkillSuggestion[] = [];
    const now = Date.now();

    for (const item of parsed) {
      const type = validTypes.has(item.suggestion_type) ? item.suggestion_type : 'instruction';
      if (!item.title || !item.diff_content) continue;

      const id = uuidv4();
      const executionId = executions.length > 0 ? executions[0].id : null;

      insertSuggestionStmt.run(
        id,
        skillName,
        skillPath,
        executionId,
        type,
        item.title,
        item.description ?? null,
        item.diff_content,
        'pending',
        now,
        contentHash,
      );

      const row = getSuggestionByIdStmt.get(id);
      if (row) suggestions.push(rowToSuggestion(row));
    }

    broadcast({ type: 'skill:suggestions-generated', skill_name: skillName, count: suggestions.length });
    logger.info({ skillName, suggestionCount: suggestions.length }, 'Skill analysis completed');

    return suggestions;
  }

  function getSuggestions(skillName: string): SkillSuggestion[] {
    return getSuggestionsStmt.all(skillName).map(rowToSuggestion);
  }

  function getSuggestion(id: string): SkillSuggestion | null {
    const row = getSuggestionByIdStmt.get(id);
    return row ? rowToSuggestion(row) : null;
  }

  function dismissSuggestion(id: string): SkillSuggestion | null {
    const row = getSuggestionByIdStmt.get(id);
    if (!row) return null;

    updateStatusStmt.run('dismissed', null, id);
    const updated = getSuggestionByIdStmt.get(id);
    return updated ? rowToSuggestion(updated) : null;
  }

  function markApplied(id: string): void {
    updateStatusStmt.run('applied', Date.now(), id);
  }

  return {
    analyzeSkill,
    getSuggestions,
    getSuggestion,
    dismissSuggestion,
    markApplied,
    computeContentHash,
  };
}

export type SkillAnalysisService = ReturnType<typeof createSkillAnalysisService>;
