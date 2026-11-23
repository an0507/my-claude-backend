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

// 统一转成 Anthropic 原生 /v1/messages 地址，确保透传 cache_control 命中缓存
function normalizeAnthropicMessagesUrl(rawUrl, fallbackUrl) {
  const base = (rawUrl || fallbackUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/v1/messages')) return base;
  if (base.endsWith('/v1/chat/completions')) {
    return base.replace(/\/v1\/chat\/completions$/, '/v1/messages');
  }
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

// 去掉类似 "[Kiro-企业正价]" 的中转前缀
function stripChannelPrefix(modelName = '') {
  return String(modelName || '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .trim();
}

// 幕间 / 奇异果 / opai 使用标准模型名
function resolveStandardProxyModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  return cleaned || 'claude-opus-4-6';
}

// 切到小忆时，自动映射为小忆支持的 [Kiro-企业正价] 模型
function resolveXiaoyiModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (!cleaned) return '[Kiro-企业正价]claude-opus-4-6';
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

// 兼容提取 Anthropic 原生流 / 非流 / OpenAI 兼容流里的文本增量
function extractAnthropicOrProxyText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';

  // 1. 标准 Anthropic 流式 delta: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
  if (typeof parsed?.delta?.text === 'string') {
    return parsed.delta.text;
  }

  // 2. content_block_start 内含初始文本: {"type":"content_block_start","content_block":{"type":"text","text":"..."}}
  if (
    parsed?.content_block?.type === 'text' &&
    typeof parsed?.content_block?.text === 'string'
  ) {
    return parsed.content_block.text;
  }

  // 3. 部分中转站直接返回完整的 Anthropic message 对象（非流式/单包）
  if (Array.isArray(parsed?.content)) {
    return parsed.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  if (Array.isArray(parsed?.message?.content)) {
    return parsed.message.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  // 4. OpenAI 兼容格式回退
  if (typeof parsed?.choices?.[0]?.delta?.content === 'string') {
    return parsed.choices[0].delta.content;
  }
  if (typeof parsed?.choices?.[0]?.message?.content === 'string') {
    return parsed.choices[0].message.content;
  }

  return '';
}

// 1. 幕间（当前主站）
const MUJIAN_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.MUJIAN_BASE_URL,
  'https://mujian.online/v1/messages'
);
const MUJIAN_API_KEY = (process.env.MUJIAN_API_KEY || '').trim();

// 2. 奇异果（备用站 1）
const QIYIGUO_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.QIYIGUO_BASE_URL,
  'https://api.qiyiguo.uk/v1/messages'
);
const QIYIGUO_API_KEY = (process.env.QIYIGUO_API_KEY || '').trim();

// 3. 小忆（备用站 2）
const XIAOYI_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.XIAOYI_BASE_URL,
  'https://api.chr1.com/v1/messages'
);
const XIAOYI_API_KEY = (process.env.XIAOYI_API_KEY || '').trim();

// 4. opai（备用站 3，以后随时可用）
const OPAI_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.OPAI_BASE_URL,
  'https://opai.pro/v1/messages'
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

  if (MUJIAN_MESSAGES_URL && MUJIAN_API_KEY) {
    stations.push({
      name: '幕间',
      url: MUJIAN_MESSAGES_URL,
      apiKey: MUJIAN_API_KEY,
      resolveModel: resolveStandardProxyModel,
    });
  }

  if (QIYIGUO_MESSAGES_URL && QIYIGUO_API_KEY) {
    stations.push({
      name: '奇异果',
      url: QIYIGUO_MESSAGES_URL,
      apiKey: QIYIGUO_API_KEY,
      resolveModel: resolveStandardProxyModel,
    });
  }

  if (XIAOYI_MESSAGES_URL && XIAOYI_API_KEY) {
    stations.push({
      name: '小忆',
      url: XIAOYI_MESSAGES_URL,
      apiKey: XIAOYI_API_KEY,
      resolveModel: resolveXiaoyiModel,
    });
  }

  if (OPAI_MESSAGES_URL && OPAI_API_KEY) {
    const isDuplicate = stations.some(
      (s) => s.url === OPAI_MESSAGES_URL && s.apiKey === OPAI_API_KEY
    );
    if (!isDuplicate) {
      stations.push({
        name: 'opai',
        url: OPAI_MESSAGES_URL,
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
      cache_control: { type: 'ephemeral' },
    });
  }

  const formattedMessages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((msg, idx, arr) => {
      const isSecondLast = arr.length >= 2 && idx === arr.length - 2;
      if (!isSecondLast) return msg;

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

function isFailoverError(err) {
  if (!err) return false;
  if (err.isFailover === true) return true;
  const status = Number(err.statusCode || 0);
  if ([403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('403') ||
    msg.includes('404') ||
    msg.includes('额度不足') ||
    msg.includes('insufficient') ||
    msg.includes('model_not_found') ||
    msg.includes('not supported') ||
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
    let lastError = null;
    let sentAnyText = false;

    // 1. 依次尝试中转站（幕间 -> 奇异果 -> 小忆 -> opai），走原生 /v1/messages 透传缓存
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
        const anthropicPayload = buildCachedAnthropicPayload(
          memoryPrefix,
          systemPrompt,
          messages,
          targetProxyModel,
          resolvedMaxTokens
        );

        const resp = await fetch(station.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': station.apiKey,
            Authorization: `Bearer ${station.apiKey}`,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(anthropicPayload),
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
        let rawSampleLogged = false;

        const processLine = (rawLine) => {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed.startsWith('event:') || trimmed.startsWith(':')) {
            return;
          }
          const payload = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : trimmed;
          if (!payload || payload === '[DONE]') return;

          const parsed = JSON.parse(payload);

          const usage = parsed?.message?.usage || parsed?.usage;
          if (usage) {
            console.log(
              `[${station.name} cache]`,
              `input=${usage.input_tokens ?? 0}`,
              `cache_write=${usage.cache_creation_input_tokens ?? 0}`,
              `cache_read=${usage.cache_read_input_tokens ?? 0}`,
              `output=${usage.output_tokens ?? 0}`
            );
          }

          if (parsed?.type === 'error' || parsed?.error) {
            const errObj = parsed.error || parsed;
            const upstreamErr = new Error(
              `[${station.name}] 流内错误: ${
                typeof errObj === 'string' ? errObj : JSON.stringify(errObj)
              }`
            );
            upstreamErr.statusCode = Number(errObj?.code) || 502;
            upstreamErr.isFailover = !stationSentText;
            throw upstreamErr;
          }

          const text = extractAnthropicOrProxyText(parsed);
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
          } else if (!rawSampleLogged && parsed?.type !== 'ping') {
            rawSampleLogged = true;
            console.log(
              `[${station.name} event-sample]`,
              JSON.stringify(parsed).slice(0, 300)
            );
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            try {
              processLine(line);
            } catch (parseOrStreamErr) {
              if (parseOrStreamErr?.isFailover) {
                throw parseOrStreamErr;
              }
            }
          }
        }

        // 处理流结束时缓冲区里残留的最后一行（兼容无尾部换行的响应）
        if (buffer.trim()) {
          try {
            processLine(buffer);
          } catch (parseOrStreamErr) {
            if (parseOrStreamErr?.isFailover) {
              throw parseOrStreamErr;
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
