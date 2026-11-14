// One structured call to Claude. The response must match a zod schema; it is validated before use.

import Anthropic from '@anthropic-ai/sdk';
import { toApiSchema } from './schemas.mjs';

const MODEL = process.env.REVIEW_MAP_MODEL ?? 'claude-opus-5-5';

export async function ask({ system, user, schema, effort = 'high', maxTokens = 64000, label }) {
  const client = new Anthropic();
  const started = Date.now();
  // Streaming keeps a long, thinking-heavy request clear of HTTP timeouts.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    // If a safety classifier declines, the API re-runs the same request on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema: toApiSchema(schema) } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();
  const secs = Math.round((Date.now() - started) / 1000);
  console.error(`[review-map] ${label}: ${msg.model}, stop=${msg.stop_reason}, in=${msg.usage.input_tokens} out=${msg.usage.output_tokens}, ${secs}s`);

  if (msg.stop_reason === 'refusal') {
    throw new Error(`${label}: the model declined (${msg.stop_details?.category ?? 'no category'}): ${msg.stop_details?.explanation ?? ''}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new Error(`${label}: response was cut off at max_tokens`);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { value: schema.parse(JSON.parse(text)), model: msg.model, usage: msg.usage };
}
