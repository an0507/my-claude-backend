const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 通道开关：默认 'qimingx'，如需切回 Anthropic 官方可在 Render 设置 PROVIDER=anthropic
const PROVIDER = (process.env.PROVIDER || 'qimingx').toLowerCase();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const QIMINGX_API_KEY =
  process.env.QIMINGX_API_KEY || process.env.OPENAI_API_KEY || '';
const QIMINGX_BASE_URL =
  process.env.QIMINGX_BASE_URL ||
  'https://api.qimingx.net/v1/chat/completions';

const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

// 当前优先测试的克劳德模型
const PRIMARY_CLAUDE_MODEL = '北极星-claude-opus-4-8';

// 遇到 503 或“没有可用的模型”时自动顺次尝试的备选模型列表
const QIMINGX_FALLBACK_MODELS = [
  PRIMARY_CLAUDE_MODEL,
  '北极星-claude-opus-4-7',
  '北极星-claude-opus-4-5',
  '北极星-claude-opus-5-5',
  '按量天狼星-claude-opus-4-8',
  '按量天狼星-claude-opus-4-7',
  '按量天狼星-claude-opus-4-6',
];

// 前端传入模型名 -> 优先映射到的模型名
const QIMINGX_MODEL_MAP = {
  'o5.5': PRIMARY_CLAUDE_MODEL,
  'f5.2': PRIMARY_CLAUDE_MODEL,
  'f5.1': PRIMARY_CLAUDE_MODEL,
  'f5': PRIMARY_CLAUDE_MODEL,
  'f5.0': PRIMARY_CLAUDE_MODEL,
  'claude-fable-5-0': PRIMARY_CLAUDE_MODEL,
  'claude-fable-5': PRIMARY_CLAUDE_MODEL,
  'claude-sonnet-4-6': PRIMARY_CLAUDE_MODEL,
  'o5': PRIMARY_CLAUDE_MODEL,
  'o4.6': PRIMARY_CLAUDE_MODEL,
};

function extractDeltaText(delta) {
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

function shouldRetryNextModel(status, errText) {
  const text = String(errText || '');
  return (
    status === 503 ||
    text.includes('没有可用的模型') ||
    text.includes('service_unavailable')
  );
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    provider: PROVIDER,
    primaryModel: PRIMARY_CLAUDE_MODEL,
  });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, system, maxTokens } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必须是非空数组' });
  }

  const rawModel = typeof model === 'string' ? model.trim() : '';
  const resolvedMaxTokens =
    typeof maxTokens === 'number' && maxTokens > 0
      ? Math.min(maxTokens, 2048)
      : 800;
  const systemPrompt =
    typeof system === 'string' && system.trim() ? system.trim() : '';

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (PROVIDER === 'anthropic') {
      if (!anthropic) {
        throw new Error('缺少 ANTHROPIC_API_KEY 环境变量');
      }

      const selectedModel = rawModel || 'claude-sonnet-4-5';
      console.log('[anthropic] 使用模型:', selectedModel);

      const stream = await anthropic.messages.create({
        model: selectedModel,
        max_tokens: resolvedMaxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
        stream: true,
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta'
        ) {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (!QIMINGX_API_KEY) {
      throw new Error('缺少 QIMINGX_API_KEY 环境变量');
    }

    const mappedModel =
      QIMINGX_MODEL_MAP[rawModel] || rawModel || PRIMARY_CLAUDE_MODEL;

    const candidateModels = Array.from(
      new Set([mappedModel, ...QIMINGX_FALLBACK_MODELS].filter(Boolean))
    );

    const formattedMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    let upstreamRes = null;
    let activeModel = mappedModel;
    let lastErr = null;

    for (const candidate of candidateModels) {
      activeModel = candidate;
      console.log(
        '[qimingx] 前端模型:',
        rawModel || '(空)',
        '| 尝试模型:',
        candidate
      );

      const resp = await fetch(QIMINGX_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${QIMINGX_API_KEY}`,
        },
        body: JSON.stringify({
          model: candidate,
          messages: formattedMessages,
          max_tokens: resolvedMaxTokens,
          stream: true,
        }),
      });

      if (resp.ok) {
        upstreamRes = resp;
        break;
      }

      const errText = await resp.text();
      lastErr = new Error(`上游接口错误 ${resp.status}: ${errText}`);
      console.warn('[qimingx] 尝试失败:', candidate, '->', lastErr.message);

      if (!shouldRetryNextModel(resp.status, errText)) {
        throw lastErr;
      }
    }

    if (!upstreamRes) {
      throw lastErr || new Error('没有可用的模型，请稍后重试');
    }

    console.log('[qimingx] 最终接入模型:', activeModel);

    if (!upstreamRes.body) {
      const json = await upstreamRes.json();
      const fullText = json?.choices?.[0]?.message?.content || '';
      if (fullText) {
        res.write(`data: ${JSON.stringify({ text: fullText })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sentAnyText = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const text =
            extractDeltaText(parsed?.choices?.[0]?.delta) ||
            parsed?.choices?.[0]?.message?.content ||
            '';
          if (text) {
            sentAnyText = true;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch (_) {}
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const parsed = JSON.parse(payload);
          const text = extractDeltaText(parsed?.choices?.[0]?.delta);
          if (text) {
            sentAnyText = true;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch (_) {}
      }
    }

    if (!sentAnyText) {
      res.write(`data: ${JSON.stringify({ text: '' })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err);
    const msg = err?.message || '出错了，请稍后再试';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器已启动，端口 ${PORT}，当前通道: ${PROVIDER}`);
});
