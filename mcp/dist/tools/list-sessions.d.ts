import { z } from 'zod';
import type { DashboardApiClient } from '../api-client.js';
/** Input schema for list_sessions tool. */
export declare const ListSessionsInputSchema: z.ZodObject<{
    origin: z.ZodOptional<z.ZodEnum<["dashboard", "external"]>>;
    active: z.ZodOptional<z.ZodEnum<["true", "false"]>>;
}, "strip", z.ZodTypeAny, {
    origin?: "dashboard" | "external" | undefined;
    active?: "true" | "false" | undefined;
}, {
    origin?: "dashboard" | "external" | undefined;
    active?: "true" | "false" | undefined;
}>;
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;
/**
 * List sessions with optional origin and active filters.
 * Returns Session[] from the dashboard API.
 */
export declare function listSessions(client: DashboardApiClient, input: ListSessionsInput): Promise<string>;
