const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// 读取清理后的历史聊天记录作为常驻记忆
const HISTORY_FILE_PATH = path.join(__dirname, 'cleaned_chat_history.txt');
let cleanedChatHistory = '';
try {
  if (fs.existsSync(HISTORY_FILE_PATH)) {
    cleanedChatHistory = fs.readFileSync(HISTORY_FILE_PATH, 'utf8').trim();
    console.log(
      `[memory] 已加载 cleaned_chat_history.txt，长度: ${cleanedChatHistory.length} 字符`
    );
  } else {
    console.log('[memory] 未找到 cleaned_chat_history.txt，跳过历史记忆注入');
  }
} catch (err) {
  console.error('[memory] 读取 cleaned_chat_history.txt 失败:', err.message);
}

function buildMemoryPrefix() {
  if (!cleanedChatHistory) return '';
  return [
    '以下是之前真实发生的完整历史聊天记录，请作为连贯记忆完整接住，保持自然语气与设定一致：',
    cleanedChatHistory,
  ].join('\n\n');
}

// 默认走中转通道（如 OPAi / QimingX）；如需走官方直连，可在环境变量设置 PROVIDER=anthropic
const PROVIDER = (process.env.PROVIDER || 'proxy').toLowerCase();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROXY_API_KEY =
  process.env.OPAI_API_KEY ||
  process.env.QIMINGX_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

function normalizeChatCompletionsUrl(rawUrl, fallbackUrl) {
  const base = (rawUrl || fallbackUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/v1/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

const PROXY_BASE_URL = normalizeChatCompletionsUrl(
  process.env.OPAI_BASE_URL || process.env.QIMINGX_BASE_URL,
  'https://api.qimingx.net/v1/chat/completions'
);

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

function buildCachedAnthropicPayload(
  memoryPrefix,
  systemPrompt,
  messages,
  model,
  maxTokens
) {
  const systemBlocks = [];

  if (memoryPrefix) {
    systemBlocks.push({
      type: 'text',
      text: memoryPrefix,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (systemPrompt) {
    systemBlocks.push({
      type: 'text',
      text: systemPrompt,
    });
  }

  const formattedMessages = messages.map((msg, idx) => {
    const isStablePrefixEnd =
      !memoryPrefix && messages.length >= 2 && idx === messages.length - 2;
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
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: formattedMessages,
    stream: true,
  };
}

function buildProxyMessages(memoryPrefix, systemPrompt, messages) {
  const prefixMessages = [];

  if (memoryPrefix) {
    prefixMessages.push({
      role: 'system',
      content: [
        {
          type: 'text',
          text: memoryPrefix,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  }

  if (systemPrompt) {
    prefixMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  return [...prefixMessages, ...messages];
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    provider: PROVIDER,
    hasHistoryMemory: Boolean(cleanedChatHistory),
    historyChars: cleanedChatHistory.length,
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
  const memoryPrefix = buildMemoryPrefix();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (PROVIDER === 'anthropic') {
      if (!anthropic) {
        throw new Error('缺少 ANTHROPIC_API_KEY 环境变量');
      }

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
        memoryPrefix,
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

    if (!PROXY_API_KEY) {
      throw new Error(
        '缺少 OPAI_API_KEY（或 QIMINGX_API_KEY / OPENAI_API_KEY）环境变量'
      );
    }

    const selectedProxyModel =
      rawModel || process.env.PROXY_DEFAULT_MODEL || 'claude-sonnet-4-5';

    console.log(
      '[proxy] 端点:',
      PROXY_BASE_URL,
      '| 前端模型:',
      rawModel || '(空)',
      '| 实际请求:',
      selectedProxyModel
    );

    const formattedMessages = buildProxyMessages(
      memoryPrefix,
      systemPrompt,
      messages
    );

    const resp = await fetch(PROXY_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PROXY_API_KEY}`,
      },
      body: JSON.stringify({
        model: selectedProxyModel,
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
