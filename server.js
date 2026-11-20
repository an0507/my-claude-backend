const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

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

const PRIMARY_CLAUDE_MODEL = '按量天狼星-claude-opus-4-8';

const QIMINGX_FALLBACK_MODELS = [
  PRIMARY_CLAUDE_MODEL,
  '北极星-claude-opus-4-8',
];

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
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 429 ||
    text.includes('没有可用的模型') ||
    text.includes('service_unavailable') ||
    text.includes('Bedrock error') ||
    text.includes('timeout') ||
    text.includes('aborted')
  );
}

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 构建带缓存断点的结构：
 * 1. Anthropic 官方 SDK：把 system 设为带 cache_control 的 block，并在倒数第二条历史消息挂断点
 * 2. 启明星（OpenAI 兼容接口）：将稳定的 system 置顶，并附加 cache_control 提示（兼容不支持该字段的上游时不会报错）
 */
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

function buildCachedOpenAICompatibleMessages(systemPrompt, messages) {
  const result = [];
  if (systemPrompt) {
    result.push({
      role: 'system',
      content: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isStablePrefixEnd = messages.length >= 2 && i === messages.length - 2;

    if (isStablePrefixEnd && typeof msg.content === 'string') {
      result.push({
        ...msg,
        content: [
          {
            type: 'text',
            text: msg.content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    provider: PROVIDER,
    primaryModel: PRIMARY_CLAUDE_MODEL,
    promptCaching: true,
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
      ? Math.min(maxTokens, 1024)
      : 600;
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
      console.log('[anthropic] 使用模型 (缓存已启用):', selectedModel);

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

    const mappedModel =
      QIMINGX_MODEL_MAP[rawModel] || rawModel || PRIMARY_CLAUDE_MODEL;

    const candidateModels = Array.from(
      new Set([mappedModel, ...QIMINGX_FALLBACK_MODELS].filter(Boolean))
    );

    const formattedMessages = buildCachedOpenAICompatibleMessages(
      systemPrompt,
      messages
    );

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

      try {
        const resp = await fetchWithTimeout(
          QIMINGX_BASE_URL,
          {
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
          },
          25000
        );

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
      } catch (err) {
        lastErr = err;
        console.warn(
          '[qimingx] 模型请求异常:',
          candidate,
          '->',
          err?.message || err
        );
      }
    }

    if (!upstreamRes) {
      throw lastErr || new Error('没有可用的模型，请稍后重试');
    }

    console.log('[qimingx] 最终接入模型:', activeModel);

    if (!upstreamRes.body) {
      const json = await upstreamRes.json();
      if (json?.usage) {
        console.log('[qimingx usage]', JSON.stringify(json.usage));
      }
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
          if (parsed?.usage) {
            console.log('[qimingx stream usage]', JSON.stringify(parsed.usage));
          }
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
