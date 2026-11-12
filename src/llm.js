// Minimal LLM client: structured JSON output from a local Ollama model or any
// OpenAI-compatible endpoint. Every call takes a deterministic fallback so the
// app keeps working (and says so) when no model is reachable.
import { config } from './config.js';

const { provider, baseUrl, model, apiKey, timeoutMs } = config.llm;

export const llmInfo = () => ({ provider, model, baseUrl: provider === 'heuristic' ? null : baseUrl });

async function post(url, body) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function rawJSON(system, user, schema) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  if (provider === 'ollama') {
    const out = await post(`${baseUrl}/api/chat`, {
      model,
      messages,
      stream: false,
      format: schema,
      options: { temperature: 0, num_predict: 400 },
      keep_alive: '30m',
    });
    return JSON.parse(out.message.content);
  }
  if (provider === 'openai') {
    const out = await post(`${baseUrl}/v1/chat/completions`, {
      model,
      messages,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema } },
    });
    return JSON.parse(out.choices[0].message.content);
  }
  throw new Error('heuristic mode');
}

/**
 * Ask the model for JSON matching `schema`. On any failure, `fallback()` is used.
 * Returns { data, via: 'llm' | 'heuristic', ms, error? }.
 */
export async function chatJSON({ system, user, schema, fallback }) {
  const t0 = Date.now();
  if (provider !== 'heuristic') {
    try {
      const data = await rawJSON(system, user, schema);
      return { data, via: 'llm', ms: Date.now() - t0 };
    } catch (err) {
      return { data: await fallback(), via: 'heuristic', ms: Date.now() - t0, error: String(err.message || err) };
    }
  }
  return { data: await fallback(), via: 'heuristic', ms: Date.now() - t0 };
}

export async function llmHealth() {
  if (provider === 'heuristic') return { ok: false, reason: 'heuristic mode (no model configured)' };
  try {
    const url = provider === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/v1/models`;
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, reason: res.ok ? 'reachable' : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}
