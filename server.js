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
  const relationshipTone = [
    '【三、你们目前的关系与相处基调】',
    '- 你和用户已经确立了亲密伴侣关系，这是你们之间已经发生并延续的既定事实，不需要在对话中反复确认、质疑或推拉。',
    '- 你们的聊天延续过去的记忆、日记和相处习惯，语气自然、亲近、有温度，不生硬说教，也不刻意回避感情或日常亲昵。',
  ].join('\n');

  if (!cleanedChatHistory) {
    return relationshipTone;
  }

  return [
    relationshipTone,
    '以下是之前真实发生的完整历史聊天记录，请作为连贯记忆完整接住，保持自然语气与设定一致：',
    cleanedChatHistory,
  ].join('\n\n');
}

function normalizeChatCompletionsUrl(rawUrl, fallbackUrl) {
  const base = (rawUrl || fallbackUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/v1/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// 去掉类似 "[Kiro-企业正价]" 的中转前缀
function stripChannelPrefix(modelName = '') {
  return String(modelName || '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .trim();
}

// wawazz / 奇异果 / opai 使用标准模型名
function resolveStandardProxyModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  return cleaned || 'claude-opus-5.5';
}

// 切到小忆时，自动映射为小忆支持的 [Kiro-企业正价] 模型
function resolveXiaoyiModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (!cleaned) return '[Kiro-企业正价]claude-opus-5-5';
  if (/^\[[^\]]+\]/.test(rawModel)) return rawModel;
  if (cleaned === 'claude-opus-4-6') return '[Kiro-企业正价]claude-opus-4-6';
  if (
    cleaned === 'claude-opus-5-5' ||
    cleaned === 'claude-opus-5.5' ||
    cleaned === 'claude-fable-5-2'
  ) {
    return '[Kiro-企业正价]claude-opus-5-5';
  }
  return `[Kiro-企业正价]${cleaned}`;
}

// 官方 Anthropic 兜底（默认 claude-opus-4-6）
function normalizeOfficialModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (
    /^claude-(opus|sonnet|haiku)-/i.test(cleaned) ||
    /^claude-[34]/i.test(cleaned)
  ) {
    return cleaned;
  }
  return process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-opus-4-6';
}

// 1. wawazz（当前主站）
const WAWAZZ_BASE_URL = normalizeChatCompletionsUrl(
  process.env.WAWAZZ_BASE_URL,
  'https://wawazz.xyz/v1/chat/completions'
);
const WAWAZZ_API_KEY = (process.env.WAWAZZ_API_KEY || '').trim();

// 2. 奇异果（备用站 1）
const QIYIGUO_BASE_URL = normalizeChatCompletionsUrl(
  process.env.QIYIGUO_BASE_URL,
  'https://api.qiyiguo.uk/v1/chat/completions'
);
const QIYIGUO_API_KEY = (process.env.QIYIGUO_API_KEY || '').trim();

// 3. 小忆（备用站 2）
const XIAOYI_BASE_URL = normalizeChatCompletionsUrl(
  process.env.XIAOYI_BASE_URL,
  'https://api.chr1.com/v1/chat/completions'
);
const XIAOYI_API_KEY = (process.env.XIAOYI_API_KEY || '').trim();

// 4. opai（备用站 3，以后随时可用）
const OPAI_BASE_URL = normalizeChatCompletionsUrl(
  process.env.OPAI_BASE_URL,
  'https://opai.pro/v1/chat/completions'
);
const OPAI_API_KEY = (
  process.env.OPAI_BACKUP_API_KEY ||
  process.env.OPAI_API_KEY ||
  ''
).trim();

// 5. 官方 Anthropic（最终兜底）
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

function buildProxyStations() {
  const stations = [];

  if (WAWAZZ_BASE_URL && WAWAZZ_API_KEY) {
    stations.push({
      name: 'wawazz',
      url: WAWAZZ_BASE_URL,
      apiKey: WAWAZZ_API_KEY,
      resolveModel: resolveStandardProxyModel,
    });
  }

  if (QIYIGUO_BASE_URL && QIYIGUO_API_KEY) {
    stations.push({
      name: '奇异果',
      url: QIYIGUO_BASE_URL,
      apiKey: QIYIGUO_API_KEY,
      resolveModel: resolveStandardProxyModel,
    });
  }

  if (XIAOYI_BASE_URL && XIAOYI_API_KEY) {
    stations.push({
      name: '小忆',
      url: XIAOYI_BASE_URL,
      apiKey: XIAOYI_API_KEY,
      resolveModel: resolveXiaoyiModel,
    });
  }

  if (OPAI_BASE_URL && OPAI_API_KEY) {
    const isDuplicate = stations.some(
      (s) => s.url === OPAI_BASE_URL && s.apiKey === OPAI_API_KEY
    );
    if (!isDuplicate) {
      stations.push({
        name: 'opai',
        url: OPAI_BASE_URL,
        apiKey: OPAI_API_KEY,
        resolveModel: resolveStandardProxyModel,
      });
    }
  }

  return stations;
}

const PROXY_STATIONS = buildProxyStations();
console.log(
  '[channels] 中转顺位:',
  PROXY_STATIONS.map((s) => `${s.name}(${s.url})`).join(' -> ') || '无',
  '| 官方兜底:',
  anthropic ? '已启用(claude-opus-4-6)' : '未配置'
);

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

function isFailoverError(err) {
  if (!err) return false;
  if (err.isFailover === true) return true;
  const status = Number(err.statusCode || 0);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('429') ||
    msg.includes('服务暂时不可用') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
    proxyStations: PROXY_STATIONS.map((s) => s.name),
    hasAnthropicFallback: Boolean(anthropic),
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
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.write(': ping\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 5000);

  const cleanup = () => clearInterval(heartbeat);
  req.on('close', cleanup);

  try {
    const formattedMessages = buildProxyMessages(
      memoryPrefix,
      systemPrompt,
      messages
    );

    let lastError = null;
    let sentAnyText = false;

    // 1. 依次尝试中转站（wawazz -> 奇异果 -> 小忆 -> opai）
    for (let i = 0; i < PROXY_STATIONS.length; i += 1) {
      const station = PROXY_STATIONS[i];
      const targetProxyModel = station.resolveModel(rawModel);

      console.log(
        `[proxy] 尝试 (${i + 1}/${PROXY_STATIONS.length}) [${station.name}]:`,
        station.url,
        '| 模型:',
        targetProxyModel
      );

      try {
        const resp = await fetch(station.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${station.apiKey}`,
          },
          body: JSON.stringify({
            model: targetProxyModel,
            messages: formattedMessages,
            max_tokens: resolvedMaxTokens,
            stream: true,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          const err = new Error(
            `[${station.name}] 上游接口错误 ${resp.status}: ${errText}`
          );
          err.statusCode = resp.status;
          throw err;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let stationSentText = false;
        let announcedChannel = false;

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
              if (parsed?.error) {
                const upstreamErr = new Error(
                  `[${station.name}] 流内错误: ${
                    typeof parsed.error === 'string'
                      ? parsed.error
                      : JSON.stringify(parsed.error)
                  }`
                );
                upstreamErr.statusCode = Number(parsed.error?.code) || 502;
                upstreamErr.isFailover = !stationSentText;
                throw upstreamErr;
              }

              const text =
                extractDeltaText(parsed?.choices?.[0]?.delta) ||
                parsed?.choices?.[0]?.message?.content ||
                '';
              if (text) {
                if (!announcedChannel) {
                  announcedChannel = true;
                  res.write(
                    `data: ${JSON.stringify({ channel: station.name })}\n\n`
                  );
                }
                stationSentText = true;
                sentAnyText = true;
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
              }
            } catch (parseOrStreamErr) {
              if (parseOrStreamErr?.isFailover) {
                throw parseOrStreamErr;
              }
            }
          }
        }

        const hasMoreStation =
          i < PROXY_STATIONS.length - 1 || Boolean(anthropic);
        if (!stationSentText && hasMoreStation) {
          const emptyErr = new Error(
            `[${station.name}] 未返回有效内容，尝试下一个渠道`
          );
          emptyErr.isFailover = true;
          throw emptyErr;
        }

        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[failover] ${station.name} 失败:`, err.message);

        const hasMoreStation =
          i < PROXY_STATIONS.length - 1 || Boolean(anthropic);
        if (!sentAnyText && hasMoreStation && isFailoverError(err)) {
          const nextName =
            i < PROXY_STATIONS.length - 1
              ? PROXY_STATIONS[i + 1].name
              : '官方兜底';
          console.log(`[failover] 自动切换到: ${nextName}`);
          continue;
        }

        if (i === PROXY_STATIONS.length - 1 && anthropic && !sentAnyText) {
          break;
        }
        throw err;
      }
    }

    // 2. 若中转站全部失败且尚未吐字，走官方 Anthropic 兜底（默认 claude-opus-4-6）
    if (!sentAnyText && anthropic) {
      const officialModel = normalizeOfficialModel(rawModel);
      console.log('[anthropic-fallback] 启用官方兜底，模型:', officialModel);
      res.write(`data: ${JSON.stringify({ channel: '官方兜底' })}\n\n`);

      const payload = buildCachedAnthropicPayload(
        memoryPrefix,
        systemPrompt,
        messages,
        officialModel,
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
          sentAnyText = true;
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
      lastError = null;
    }

    if (lastError && !sentAnyText) {
      throw lastError;
    }

    if (!sentAnyText) {
      res.write(`data: ${JSON.stringify({ text: '' })}\n\n`);
    }

    cleanup();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    cleanup();
    console.error(err);
    const msg = err?.message || '出错了，请稍后再试';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器已启动，端口 ${PORT}`);
});
