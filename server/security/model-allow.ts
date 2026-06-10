import { resolveModel } from '../../src/shared/agents/model-registry';

export type ModelValidation = { ok: true } | { ok: false; reason: string };

/**
 * Builds a model validator. A goal's model is allowed when:
 * - it is undefined (CLI uses its own default), or
 * - it is the 'default' sentinel (PtyManager skips --model for this), or
 * - resolveModel(model) returns a known ModelEntry.
 *
 * Anything else is rejected so unvalidated strings never reach `--model` argv.
 */
export function createModelValidator() {
  return function validate(model: string | undefined): ModelValidation {
    if (model === undefined || model === 'default') return { ok: true };
    if (resolveModel(model) !== null) return { ok: true };
    return { ok: false, reason: `unknown model '${model}'` };
  };
}

export type ModelValidator = ReturnType<typeof createModelValidator>;
