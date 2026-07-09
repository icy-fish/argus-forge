export type PricingKey = `${string}:${string}`;

export type ModelPricing = {
  promptPerMillion: number;
  completionPerMillion: number;
  cachedPromptPerMillion?: number;
};

export const MODEL_PRICING_USD_PER_MILLION: Record<PricingKey, ModelPricing> = {
  "openai:gpt-4o-mini": { promptPerMillion: 0.15, completionPerMillion: 0.6, cachedPromptPerMillion: 0.075 },
  "openai:gpt-4o": { promptPerMillion: 2.5, completionPerMillion: 10, cachedPromptPerMillion: 1.25 },
  "anthropic:claude-3-5-sonnet": { promptPerMillion: 3, completionPerMillion: 15 },
  "google:gemini-1.5-pro": { promptPerMillion: 3.5, completionPerMillion: 10.5 }
};

export function estimateCostUsd(input: {
  provider: string;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
}): number | null {
  const pricing = MODEL_PRICING_USD_PER_MILLION[`${input.provider}:${input.model}`];
  if (!pricing) return null;

  const promptTokens = Math.max(0, input.promptTokens ?? 0);
  const cachedTokens = Math.max(0, input.cachedTokens ?? 0);
  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  const completionTokens = Math.max(0, input.completionTokens ?? 0);

  const promptCost = (billablePrompt / 1_000_000) * pricing.promptPerMillion;
  const cachedCost = (cachedTokens / 1_000_000) * (pricing.cachedPromptPerMillion ?? pricing.promptPerMillion);
  const completionCost = (completionTokens / 1_000_000) * pricing.completionPerMillion;
  return Number((promptCost + cachedCost + completionCost).toFixed(8));
}
