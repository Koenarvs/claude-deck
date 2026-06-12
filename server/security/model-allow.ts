import { resolveModel } from '../../src/shared/agents/model-registry';

export type ModelValidation = { ok: true } | { ok: false; reason: string };

/**
 * Builds a model validator. A goal's model is allowed when:
 * - it is undefined (CLI uses its own default), or
 * - it is the 'default' sentinel (PtyManager skips --model for this), or
 * - resolveModel(model) returns a known ModelEntry, or
 * - it is one of the live catalog values (`liveValues`) the enabled providers
 *   currently offer (e.g. an Antigravity display name like "Gemini 3.1 Pro (High)"
 *   or a Codex slug like "gpt-5.2" that the static registry does not match).
 *
 * Anything else is rejected so unvalidated strings never reach `--model` argv.
 *
 * @param liveValues optional provider of the current live model values (from the
 *   model-list services' caches). Called per validation so it always sees fresh data.
 */
export function createModelValidator(liveValues?: () => Iterable<string>) {
  return function validate(model: string | undefined): ModelValidation {
    if (model === undefined || model === 'default') return { ok: true };
    if (resolveModel(model) !== null) return { ok: true };
    if (liveValues) {
      for (const v of liveValues()) {
        if (v === model) return { ok: true };
      }
    }
    return { ok: false, reason: `unknown model '${model}'` };
  };
}

export type ModelValidator = ReturnType<typeof createModelValidator>;
