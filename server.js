const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// 默认切回 Anthropic 官方通道
const PROVIDER = (process.env.PROVIDER || 'anthropic').toLowerCase();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const QIMINGX_API_KEY =
  process.env.QIMINGX_API_KEY || process.env.OPENAI_API_KEY || '';
const QIMINGX_BASE_URL =
  process.env.QIMINGX_BASE_URL ||
  'https://api.qimingx.net/v1/chat/completions';

const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

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

function buildCachedAnthropicPayload(systemPrompt, messages, model, maxTokens) {
  const systemBlocks = systemPrompt
    ? [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : undefined;

  const formattedMessages = messages.map((msg, idx) => {
    const isStablePrefixEnd = messages.length >= 2 && idx === messages.length - 2;
    if (!isStablePrefixEnd) return msg;

    if (typeof msg.content === 'string') {
      return {
        ...msg,
        content: [
          {
            type: 'text',
            text: msg.content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      };
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const cloned = [...msg.content];
      const lastIdx = cloned.length - 1;
      const lastItem = cloned[lastIdx];
      if (typeof lastItem === 'string') {
        cloned[lastIdx] = {
          type: 'text',
          text: lastItem,
          cache_control: { type: 'ephemeral' },
        };
      } else if (lastItem && typeof lastItem === 'object') {
        cloned[lastIdx] = {
          ...lastItem,
          cache_control: { type: 'ephemeral' },
        };
      }
      return { ...msg, content: cloned };
    }

    return msg;
  });

  return {
    model,
    max_tokens: maxTokens,
    ...(systemBlocks ? { system: systemBlocks } : {}),
    messages: formattedMessages,
    stream: true,
  };
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    provider: PROVIDER,
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

      // 优先使用前端传来的官方模型名；若前端传的是非官方别名（如 f5.1），回退到官方默认模型
      const looksLikeOfficialModel = /^claude-/i.test(rawModel);
      const selectedModel = looksLikeOfficialModel
        ? rawModel
        : process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-5';

      console.log(
        '[anthropic] 前端模型:',
        rawModel || '(空)',
        '| 实际请求:',
        selectedModel
      );

      const payload = buildCachedAnthropicPayload(
        systemPrompt,
        messages,
        selectedModel,
        resolvedMaxTokens
      );

      const stream = await anthropic.messages.create(payload);

      for await (const event of stream) {
        if (event?.message?.usage) {
          const {
            input_tokens = 0,
            cache_creation_input_tokens = 0,
            cache_read_input_tokens = 0,
          } = event.message.usage;
          console.log(
            '[anthropic cache]',
            `input=${input_tokens}`,
            `write=${cache_creation_input_tokens}`,
            `read=${cache_read_input_tokens}`
          );
        }

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

    const formattedMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const resp = await fetch(QIMINGX_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QIMINGX_API_KEY}`,
      },
      body: JSON.stringify({
        model: rawModel || 'claude-sonnet-4-5',
        messages: formattedMessages,
        max_tokens: resolvedMaxTokens,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`上游接口错误 ${resp.status}: ${errText}`);
    }

    const reader = resp.body.getReader();
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
