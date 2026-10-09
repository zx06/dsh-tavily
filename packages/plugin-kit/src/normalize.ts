/**
 * Small normalization helpers ported from the pi tavily-tools reference.
 *
 * @module normalize
 */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function compactText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? '';
}

export function shorten(text: string | undefined, max = 500): string {
  const normalized = compactText(text);
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

/** Trim, drop empties, dedupe, cap length. Returns undefined when nothing survives. */
export function cleanStringArray(values: string[] | undefined, maxItems: number): string[] | undefined {
  if (!values?.length) return undefined;
  const deduped = Array.from(
    new Set(values.map((item) => item.trim()).filter(Boolean)),
  ).slice(0, maxItems);
  return deduped.length > 0 ? deduped : undefined;
}

export function normalizeUrl(raw: string, fieldName: string): string {
  const url = compactText(raw);
  if (!url) throw new Error(`${fieldName} cannot be empty`);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} must be an http(s) URL`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(fieldName)) throw error;
    throw new Error(`${fieldName} is not a valid URL: ${url}`);
  }
  return url;
}

export function normalizeUrls(urls: string[], maxItems = 20): string[] {
  const cleaned = cleanStringArray(urls, maxItems) ?? [];
  if (cleaned.length === 0) throw new Error('urls cannot be empty');
  return cleaned.map((url) => normalizeUrl(url, 'urls[]'));
}
