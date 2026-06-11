import type { RoutingRecommendation } from '../../src/shared/types';

export interface WindowUtilizationEntry {
  provider: string;
  /** 0–100 estimate of the provider's rolling-window quota used. */
  utilizationPct: number;
}

export interface RecommendRouteInput {
  requestedModel: string;
  windowUtilization: WindowUtilizationEntry[];
  enabledProviders: string[];
  /** Utilization ≥ this is "hot". */
  hotThresholdPct: number;
  /** When true, the recommendation is marked applied (caller switches model). */
  autoRoute: boolean;
  /** Maps a model id to its provider id (Phase 0A registry in production). */
  providerForModel: (model: string) => string;
  /** Returns the cheapest/coolest model id for a provider (registry in production). */
  coolestModelForProvider: (provider: string) => string;
}

/**
 * Recommends routing a job to a cooler provider when the requested provider's seat
 * window is hot. Pure + deterministic. Returns the requested provider unchanged when
 * it is cool, no alternate is enabled, or utilization data is missing (degrades to an
 * advisory no-op so it is safe when the window-utilization feed is absent).
 */
export function recommendRoute(input: RecommendRouteInput): RoutingRecommendation {
  const requestedProvider = input.providerForModel(input.requestedModel);
  const utilByProvider = new Map(input.windowUtilization.map((e) => [e.provider, e.utilizationPct]));
  const requestedUtil = utilByProvider.get(requestedProvider);

  const base: RoutingRecommendation = {
    requestedModel: input.requestedModel,
    requestedProvider,
    recommendedProvider: null,
    recommendedModel: null,
    reason: 'requested provider window is within limits',
    applied: false,
  };

  if (requestedUtil == null || requestedUtil < input.hotThresholdPct) {
    return base;
  }

  const alternates = input.enabledProviders
    .filter((p) => p !== requestedProvider)
    .map((p) => ({ provider: p, util: utilByProvider.get(p) }))
    .filter((a): a is { provider: string; util: number } => typeof a.util === 'number')
    .sort((a, b) => a.util - b.util);

  const coolest = alternates[0];
  if (!coolest || coolest.util >= input.hotThresholdPct) {
    return base;
  }

  return {
    ...base,
    recommendedProvider: coolest.provider,
    recommendedModel: input.coolestModelForProvider(coolest.provider),
    reason: `${requestedProvider} window hot (${requestedUtil}%) → ${coolest.provider} (${coolest.util}%)`,
    applied: input.autoRoute,
  };
}
