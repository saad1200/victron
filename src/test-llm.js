#!/usr/bin/env node
/**
 * Quick LLM connectivity test — verifies both Gemini and OpenAI can respond.
 * Usage: node src/test-llm.js
 */

const axios = require('axios');
require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const TEST_PROMPT = 'Respond with exactly: {"status":"ok","provider":"<your name>"}';

// ─────────────────────────── Gemini ──────────────────────────────────

async function testGemini() {
  if (!GEMINI_API_KEY) return { provider: 'gemini', status: 'SKIP', reason: 'GEMINI_API_KEY not set' };

  const endpoints = [
    { api: 'v1', body: {
      systemInstruction: { parts: [{ text: 'Respond with valid JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 50, responseMimeType: 'application/json' },
    }},
    { api: 'v1beta', body: {
      contents: [{ role: 'user', parts: [{ text: 'Respond with valid JSON only.\n\n' + TEST_PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 50, responseMimeType: 'application/json' },
    }},
  ];

  for (const { api, body } of endpoints) {
    const url = `https://generativelanguage.googleapis.com/${api}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    try {
      const start = Date.now();
      const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const elapsed = Date.now() - start;
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const usage = res.data.usageMetadata || {};
      return {
        provider: 'gemini',
        status: 'OK',
        endpoint: api,
        model: GEMINI_MODEL,
        latency: `${elapsed}ms`,
        promptTokens: usage.promptTokenCount || 0,
        completionTokens: usage.candidatesTokenCount || 0,
        response: text.trim(),
      };
    } catch (err) {
      const status = err.response?.status;
      if (status !== 400) {
        // Not a model/endpoint mismatch — real error
        const errBody = err.response?.data?.error?.message || err.message;
        return {
          provider: 'gemini',
          status: 'FAIL',
          endpoint: api,
          model: GEMINI_MODEL,
          httpStatus: status,
          error: errBody,
        };
      }
      // 400 = endpoint/model mismatch, try next
    }
  }
  return { provider: 'gemini', status: 'FAIL', error: 'All endpoints returned 400' };
}

// ─────────────────────────── OpenAI ─────────────────────────────────

async function testOpenAI() {
  if (!OPENAI_API_KEY) return { provider: 'openai', status: 'SKIP', reason: 'OPENAI_API_KEY not set' };

  const url = 'https://api.openai.com/v1/chat/completions';
  try {
    const start = Date.now();
    const res = await axios.post(url, {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'Respond with valid JSON only.' },
        { role: 'user', content: TEST_PROMPT },
      ],
      temperature: 0,
      max_tokens: 50,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      timeout: 15000,
    });
    const elapsed = Date.now() - start;
    const choice = res.data.choices?.[0];
    const usage = res.data.usage || {};
    return {
      provider: 'openai',
      status: 'OK',
      model: OPENAI_MODEL,
      latency: `${elapsed}ms`,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      response: (choice?.message?.content || '').trim(),
    };
  } catch (err) {
    const status = err.response?.status;
    const errBody = err.response?.data?.error?.message || err.message;
    return {
      provider: 'openai',
      status: 'FAIL',
      model: OPENAI_MODEL,
      httpStatus: status,
      error: errBody,
    };
  }
}

// ─────────────────────────── Run ────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         LLM Connectivity Test            ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log(`Configured primary: ${(process.env.LLM_PROVIDER || 'openai').toUpperCase()}`);
  console.log(`Gemini model:  ${GEMINI_MODEL}  key: ...${GEMINI_API_KEY ? GEMINI_API_KEY.slice(-4) : 'NOT SET'}`);
  console.log(`OpenAI model:  ${OPENAI_MODEL}  key: ...${OPENAI_API_KEY ? OPENAI_API_KEY.slice(-4) : 'NOT SET'}\n`);

  const [gemini, openai] = await Promise.all([testGemini(), testOpenAI()]);

  for (const result of [gemini, openai]) {
    const icon = result.status === 'OK' ? '✅' : result.status === 'SKIP' ? '⏭️' : '❌';
    console.log(`${icon}  ${result.provider.toUpperCase()}`);
    for (const [k, v] of Object.entries(result)) {
      if (k === 'provider') continue;
      console.log(`    ${k}: ${v}`);
    }
    console.log();
  }

  const anyOk = [gemini, openai].some(r => r.status === 'OK');
  if (!anyOk) {
    console.log('⚠️  No LLM provider is working. Check your API keys and billing.');
    process.exit(1);
  }
}

main();
