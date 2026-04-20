import { z } from 'zod';
import {
  GoalSchema,
  GoalStatusSchema,
  PlanJsonSchema,
  MessageSchema,
  ApprovalSchema,
  SessionSchema,
  HookEventSchema,
  ApprovalDecisionSchema,
} from './schemas';

// ── Server → Client Events (§6.1) ────────────────────────────────────────────

export const GoalCreatedEventSchema = z.object({
  type: z.literal('goal:created'),
  goal: GoalSchema,
});

export const GoalUpdatedEventSchema = z.object({
  type: z.literal('goal:updated'),
  goal: GoalSchema,
});

export const GoalStatusEventSchema = z.object({
  type: z.literal('goal:status'),
  id: z.string(),
  status: GoalStatusSchema,
  current_session_id: z.string().nullable(),
});

export const GoalPlanUpdatedEventSchema = z.object({
  type: z.literal('goal:plan-updated'),
  id: z.string(),
  plan_json: PlanJsonSchema,
});

export const MessageAddedEventSchema = z.object({
  type: z.literal('message:added'),
  goal_id: z.string().nullable(),
  session_id: z.string(),
  message: MessageSchema,
});

export const ApprovalPendingEventSchema = z.object({
  type: z.literal('approval:pending'),
  approval: ApprovalSchema,
  goal_id: z.string().nullable(),
});

export const ApprovalResolvedEventSchema = z.object({
  type: z.literal('approval:resolved'),
  id: z.string(),
  decision: ApprovalDecisionSchema,
});

export const SessionObservedEventSchema = z.object({
  type: z.literal('session:observed'),
  session: SessionSchema,
});

export const SessionEndedEventSchema = z.object({
  type: z.literal('session:ended'),
  id: z.string(),
});

export const HookEventEventSchema = z.object({
  type: z.literal('hook:event'),
  event: HookEventSchema,
});

export const SubprocessErrorEventSchema = z.object({
  type: z.literal('subprocess:error'),
  goal_id: z.string(),
  error: z.string(),
});

export const PingEventSchema = z.object({
  type: z.literal('ping'),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  GoalCreatedEventSchema,
  GoalUpdatedEventSchema,
  GoalStatusEventSchema,
  GoalPlanUpdatedEventSchema,
  MessageAddedEventSchema,
  ApprovalPendingEventSchema,
  ApprovalResolvedEventSchema,
  SessionObservedEventSchema,
  SessionEndedEventSchema,
  HookEventEventSchema,
  SubprocessErrorEventSchema,
  PingEventSchema,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ── Client → Server Messages (§6.2) ──────────────────────────────────────────

export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  goals: z.union([z.array(z.string()), z.literal('all')]),
});

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
});

export const ClientPingMessageSchema = z.object({
  type: z.literal('ping'),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  ClientPingMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
