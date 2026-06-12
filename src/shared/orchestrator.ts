import { z } from 'zod';

export const OrchestratorRoleSchema = z.enum(['owner', 'orchestrator', 'system']);
export const OrchestratorChannelSchema = z.enum(['app', 'discord', 'internal']);
export const TriggerKindSchema = z.enum([
  'owner_message',
  'approval',
  'session_ended',
  'scheduled',
  'heartbeat',
]);
export const OrchestratorStatusSchema = z.enum(['idle', 'waking', 'active', 'cooling']);

export type OrchestratorRole = z.infer<typeof OrchestratorRoleSchema>;
export type OrchestratorChannel = z.infer<typeof OrchestratorChannelSchema>;
export type TriggerKind = z.infer<typeof TriggerKindSchema>;
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

export const OrchestratorMessageSchema = z.object({
  id: z.string(),
  role: OrchestratorRoleSchema,
  channel: OrchestratorChannelSchema,
  content: z.string(),
  tool_calls_json: z.string().nullable(),
  trigger_kind: TriggerKindSchema.nullable(),
  created_at: z.number(),
});
export type OrchestratorMessage = z.infer<typeof OrchestratorMessageSchema>;

export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean(),
  persona_name: z.string().min(1),
  model: z.string().min(1),
  idle_timeout_ms: z.number().int().min(10),
  max_concurrent_children: z.number().int().min(0),
  max_depth: z.number().int().min(0),
  /** The single paired Discord user id the inbound lock checks against (5F faces). */
  discord_owner_id: z.string().nullable().default(null),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false,
  persona_name: 'Hawat',
  model: 'haiku',
  idle_timeout_ms: 600_000,
  max_concurrent_children: 3,
  max_depth: 2,
  discord_owner_id: null,
};

export const OrchestratorStateRecordSchema = z.object({
  status: OrchestratorStatusSchema,
  last_wake_at: z.number().nullable(),
  last_active_at: z.number().nullable(),
  config: OrchestratorConfigSchema,
});
export type OrchestratorStateRecord = z.infer<typeof OrchestratorStateRecordSchema>;

/** A trigger that can wake the orchestrator. Validated where it crosses the API boundary. */
export interface OrchestratorTrigger {
  kind: TriggerKind;
  text?: string;
  channel?: OrchestratorChannel;
  approvalId?: string;
  goalId?: string;
  sessionId?: string;
  taskId?: string;
}

// ── API request bodies ───────────────────────────────────────────────────────
export const PostOwnerMessageSchema = z.object({
  text: z.string().min(1),
  channel: OrchestratorChannelSchema.optional(),
});
export type PostOwnerMessage = z.infer<typeof PostOwnerMessageSchema>;

export const UpdateOrchestratorConfigSchema = OrchestratorConfigSchema.partial();
export type UpdateOrchestratorConfig = z.infer<typeof UpdateOrchestratorConfigSchema>;
