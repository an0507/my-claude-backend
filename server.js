const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PROVIDER = (process.env.PROVIDER || 'qimingx').toLowerCase();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const QIMINGX_API_KEY = process.env.QIMINGX_API_KEY || process.env.OPENAI_API_KEY || '';
const QIMINGX_BASE_URL =
  process.env.QIMINGX_BASE_URL || 'https://api.qimingx.net/v1/chat/completions';

const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

const TEST_CLAUDE_MODEL = '北极星-claude-opus-4-5';

// 先全部映射到测试模型，方便快速验证连通性
const QIMINGX_MODEL_MAP = {
  'o5.5': TEST_CLAUDE_MODEL,
  'f5.2': TEST_CLAUDE_MODEL,
  'f5.1': TEST_CLAUDE_MODEL,
  'f5': TEST_CLAUDE_MODEL,
  'f5.0': TEST_CLAUDE_MODEL,
  'claude-fable-5-0': TEST_CLAUDE_MODEL,
  'claude-fable-5': TEST_CLAUDE_MODEL,
  'o5': TEST_CLAUDE_MODEL,
  'o4.6': TEST_CLAUDE_MODEL,
};

const QIMINGX_FALLBACK_MODEL = TEST_CLAUDE_MODEL;

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

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'running', provider: PROVIDER });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, system, maxTokens } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必须是非空数组' });
  }

  const rawModel = typeof model === 'string' ? model.trim() : '';
  const resolvedMaxTokens =
    typeof maxTokens === 'number' && maxTokens > 0 ? Math.min(maxTokens, 2048) : 800;
  const systemPrompt = typeof system === 'string' && system.trim() ? system.trim() : '';

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (PROVIDER === 'anthropic') {
      if (!anthropic) {
        throw new Error('缺少 ANTHROPIC_API_KEY 环境变量');
      }

      const selectedModel = rawModel || 'claude-sonnet-4-5';
      console.log('[anthropic] 模型:', selectedModel);

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

    const selectedModel =
      QIMINGX_MODEL_MAP[rawModel] || rawModel || QIMINGX_FALLBACK_MODEL;
    const formattedMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    console.log(
      '[qimingx] 收到模型:',
      rawModel || '(空)',
      '-> 实际请求:',
      selectedModel
    );

    const upstreamRes = await fetch(QIMINGX_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QIMINGX_API_KEY}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: formattedMessages,
        max_tokens: resolvedMaxTokens,
        stream: true,
      }),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      throw new Error(`上游接口错误 ${upstreamRes.status}: ${errText}`);
    }

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
