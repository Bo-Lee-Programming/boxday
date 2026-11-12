import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const hasPayPalCreds = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

export const config = {
  port: Number(env.PORT || 3040),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3040}`).replace(/\/$/, ''),
  // "mock" works fully offline; "sandbox" talks to api-m.sandbox.paypal.com.
  paypalMode: env.PAYPAL_MODE || (hasPayPalCreds ? 'sandbox' : 'mock'),
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    baseUrl: 'https://api-m.sandbox.paypal.com',
  },
  llm: {
    // "ollama" (default, local and free), "openai" (any OpenAI-compatible endpoint), or "heuristic" (no model).
    provider: env.LLM_PROVIDER || 'ollama',
    baseUrl: (env.LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.LLM_MODEL || 'qwen2.5:3b',
    apiKey: env.LLM_API_KEY || '',
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 45000),
  },
  dataDir: path.join(ROOT, env.DATA_DIR || 'data/runtime'),
};

if (config.paypalMode === 'sandbox' && !hasPayPalCreds) {
  console.warn('[config] PAYPAL_MODE=sandbox but PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing; falling back to mock.');
  config.paypalMode = 'mock';
}
