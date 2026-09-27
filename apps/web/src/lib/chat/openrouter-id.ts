/**
 * The OpenRouter slug for a native model id. OpenRouter writes Anthropic
 * versions with a dot and no snapshot date (`claude-haiku-4-5-20251001` ->
 * `anthropic/claude-haiku-4.5`); OpenAI ids keep their own dots.
 *
 * Pure and dependency-free, so callers outside chat (the model-plan API) can
 * use it without loading the AI SDK providers or the DB.
 */
export function openRouterModelId(provider: string, modelId: string): string {
  if (provider === 'openrouter' || modelId.includes('/')) return modelId;
  if (provider === 'anthropic') {
    const undated = modelId.replace(/-\d{8}$/, '');
    return `anthropic/${undated.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  }
  return `${provider}/${modelId}`;
}
