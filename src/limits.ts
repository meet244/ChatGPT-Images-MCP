export type GenerationLimit = 'conversation_full' | 'usage_limit';
export interface GenerationLimitNotice { kind: GenerationLimit; freeTier?: boolean; resetText?: string; }

export function generationLimitNotice(text: string): GenerationLimitNotice | undefined {
  const kind = classifyGenerationLimit(text);
  if (!kind) return;
  const normalized = text.replace(/’/g, "'").replace(/\s+/g, ' ').trim();
  const freeTier = kind === 'usage_limit' && /you(?:'ve| have) hit the Free plan limit for image (?:generation|creation)/i.test(normalized);
  // Preserve the displayed relative time; do not guess a timestamp or a 24-hour reset.
  const resetText = normalized.match(/wait for more\s+([^.!?]+(?:\.|$))/i)?.[1]?.trim()
    ?? normalized.match(/(?:when )?the limit resets?\s+(?:in\s+)?([^.!?]+(?:\.|$))/i)?.[1]?.trim();
  return { kind, ...(freeTier ? { freeTier: true } : {}), ...(resetText ? { resetText: resetText.slice(0, 200) } : {}) };
}

// Only explicit English notices qualify for rollover. Unknown errors never trigger a retry.
export function classifyGenerationLimit(text: string): GenerationLimit | undefined {
  const normalized = text.replace(/’/g, "'").replace(/\s+/g, ' ').trim();
  if (/^(?:you(?:'re| are) out of (?:images|image creations)|you(?:'ve| have) hit (?:the |your )?(?:(?:free|plus|pro|business) plan )?limit for image (?:generation|creation)s?)\b/i.test(normalized)) return 'usage_limit';
  if (/^(?:you(?:'ve| have) reached (?:your |the )?(?:(?:free |daily )?image (?:creation|generation) limit|(?:image|file|upload) (?:usage |generation )?limit)|image (?:creation|generation) limit reached|you(?:'re| are) generating images too quickly|too many requests)\b/i.test(normalized)) return 'usage_limit';
  if (/^(?:you(?:'ve| have) reached the maximum length for this conversation|this conversation (?:is|has become) too (?:long|large))\b/i.test(normalized)) return 'conversation_full';
  if (/^(?:conversation|chat) (?:length |context )?limit reached\b/i.test(normalized) && /(?:start|starting|open|opening) (?:a )?new (?:chat|conversation)/i.test(normalized)) return 'conversation_full';
  return undefined;
}
