const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 同时兼容简写别名与前端完整模型 ID（若某模型在当前账号下无权限或报 404，可调整右侧目标 ID）
const MODEL_MAP = {
  'o5.5': 'claude-sonnet-4-6',
  'claude-opus-5-5': 'claude-sonnet-4-6',

  'f5.2': 'claude-sonnet-4-6',
  'claude-fable-5-2': 'claude-sonnet-4-6',

  'f5.1': 'claude-haiku-4-5-20251001',
  'claude-fable-5-1': 'claude-haiku-4-5-20251001',

  'f5': 'claude-haiku-4-5-20251001',
  'f5.0': 'claude-haiku-4-5-20251001',
  'claude-fable-5-0': 'claude-haiku-4-5-20251001',

  'o5': 'claude-opus-4-6',
  'claude-opus-5': 'claude-opus-4-6',

  'o4.6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
};

const FALLBACK_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const MAX_ALLOWED_TOKENS = 8192;

function resolveModel(inputModel) {
  if (!inputModel || typeof inputModel !== 'string') {
    return FALLBACK_MODEL;
  }
  const normalized = inputModel.trim();
  if (!normalized) {
    return FALLBACK_MODEL;
  }
  return MODEL_MAP[normalized] || normalized;
}

function resolveMaxTokens(inputMaxTokens) {
  if (typeof inputMaxTokens !== 'number' || !Number.isFinite(inputMaxTokens)) {
    return DEFAULT_MAX_TOKENS;
  }
  const floored = Math.floor(inputMaxTokens);
  if (floored <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(floored, MAX_ALLOWED_TOKENS);
}

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'running' });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, system, maxTokens } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必须是非空数组' });
  }

  const rawModel = typeof model === 'string' ? model.trim() : '';
  const selectedModel = resolveModel(rawModel);
  const resolvedMaxTokens = resolveMaxTokens(maxTokens);
  const systemPrompt =
    typeof system === 'string' && system.trim() ? system.trim() : undefined;

  console.log(
    '收到模型:',
    rawModel || '(空)',
    '-> 实际请求:',
    selectedModel,
    '| maxTokens:',
    resolvedMaxTokens,
    '| 是否带 system:',
    Boolean(systemPrompt)
  );

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
  });

  try {
    const stream = await anthropic.messages.stream({
      model: selectedModel,
      max_tokens: resolvedMaxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages,
    });

    for await (const chunk of stream) {
      if (clientClosed || res.writableEnded) {
        break;
      }
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta?.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    if (!clientClosed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    console.error(err);
    if (!clientClosed && !res.writableEnded) {
      const msg = err?.message || '出错了，请稍后再试';
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器已启动，端口 ${PORT}`);
});
