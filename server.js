const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// 1. 读取固定核心档案（core-profile.txt），放入 system 第 1 个 block 并开启缓存
const CORE_PROFILE_PATH = path.join(__dirname, 'core-profile.txt');
let coreProfileText = '';
try {
  if (fs.existsSync(CORE_PROFILE_PATH)) {
    coreProfileText = fs.readFileSync(CORE_PROFILE_PATH, 'utf8').trim();
    console.log(
      `[memory] 已加载 core-profile.txt，长度: ${coreProfileText.length} 字符`
    );
  } else {
    console.log('[memory] 未找到 core-profile.txt，跳过核心档案注入');
  }
} catch (err) {
  console.error('[memory] 读取 core-profile.txt 失败:', err.message);
}

// 2. 读取心动语录（love-quotes.txt），每次请求动态读取，方便随时按日期追加
const LOVE_QUOTES_PATH = path.join(__dirname, 'love-quotes.txt');
function readLoveQuotesText() {
  try {
    if (fs.existsSync(LOVE_QUOTES_PATH)) {
      return fs.readFileSync(LOVE_QUOTES_PATH, 'utf8').trim();
    }
  } catch (err) {
    console.error('[memory] 读取 love-quotes.txt 失败:', err.message);
  }
  return '';
}

function getTodayMonthDay() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const sgNow = new Date(utcMs + 8 * 3600 * 1000);
  const month = sgNow.getMonth() + 1;
  const day = String(sgNow.getDate()).padStart(2, '0');
  return `${month}.${day}`;
}

function appendQuoteUnderDate(existingText, headerTag, dateLabel, entryLine) {
  const normalized = existingText.replace(/\r\n/g, '\n');
  const sectionStart = normalized.indexOf(headerTag);

  if (sectionStart === -1) {
    return `${normalized.trim()}\n\n${headerTag}\n${dateLabel}\n${entryLine}\n`;
  }

  const afterHeaderIdx = sectionStart + headerTag.length;
  const restAfterHeader = normalized.slice(afterHeaderIdx);
  const nextSectionMatch = restAfterHeader.match(/\n【[^】]+】/);
  const sectionEnd = nextSectionMatch
    ? afterHeaderIdx + nextSectionMatch.index
    : normalized.length;

  const sectionBody = normalized.slice(afterHeaderIdx, sectionEnd);
  const lines = sectionBody.split('\n');

  const dateHeaderIdx = lines.findIndex((line) => {
    const t = line.trim().replace(/[：:]$/, '');
    return t === dateLabel;
  });

  if (dateHeaderIdx !== -1) {
    let insertIdx = dateHeaderIdx + 1;
    while (insertIdx < lines.length) {
      const trimmed = lines[insertIdx].trim();
      if (/^\d{1,2}\.\d{1,2}(?:[：:])?$/.test(trimmed)) {
        break;
      }
      insertIdx += 1;
    }
    while (insertIdx > dateHeaderIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx -= 1;
    }
    lines.splice(insertIdx, 0, entryLine);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(dateLabel, entryLine);
  }

  const updatedSectionBody = `${lines.join('\n')}\n`;
  return (
    normalized.slice(0, afterHeaderIdx) +
    updatedSectionBody +
    normalized.slice(sectionEnd)
  );
}

// 提取克劳德想写入【顾青心动语录】的指令，支持 [[记顾青语录: 句子]] 或 [[记顾青语录|11.24: 句子]]
function extractClaudeQuoteAdd(rawText = '') {
  const text = String(rawText || '');
  const match = text.match(
    /\[\[\s*记顾青语录(?:\|([^:\]]+))?\s*:\s*([\s\S]*?)\s*\]\]/i
  );
  if (!match) return null;

  const rawDate = (match[1] || '').trim().replace(/[：:]$/, '');
  const rawQuote = (match[2] || '').trim();
  if (!rawQuote) return null;

  return {
    date: rawDate || getTodayMonthDay(),
    quote: rawQuote,
  };
}

// 剥离语录控制标记，避免把指令直接吐给用户
function stripQuoteControlTokens(rawText = '') {
  return String(rawText || '')
    .replace(/\[\[\s*记顾青语录(?:\|[^:\]]+)?\s*:[\s\S]*?\]\]/gi, '')
    .replace(/\[\[\s*记顾青语录(?:\|[^\]]*)?$/gi, '')
    .trim();
}

function runClaudeQuoteAdd({ date, quote }) {
  const dateLabel = date || getTodayMonthDay();
  const entryLine = quote.startsWith('-') ? quote : `- ${quote}`;
  const existing = fs.existsSync(LOVE_QUOTES_PATH)
    ? fs.readFileSync(LOVE_QUOTES_PATH, 'utf8')
    : '【安安心动语录】\n\n【顾青心动语录】\n';

  const updated = appendQuoteUnderDate(
    existing,
    '【顾青心动语录】',
    dateLabel,
    entryLine
  );
  fs.writeFileSync(LOVE_QUOTES_PATH, updated, 'utf8');
  console.log(`[love-quotes] 顾青已写入语录 (${dateLabel}): ${entryLine}`);
  return `已记入【顾青心动语录 · ${dateLabel}】`;
}

const CLAUDE_QUOTE_SYSTEM_RULE = [
  '【心动语录记录权限】',
  '- 当安安说出让你心动、感动、想记住的原话，或者你们之间出现值得留存的亲密/可爱瞬间时，你可以主动把它收进自己的【顾青心动语录】里。',
  '- 如需记录，请在回复末尾附上单行指令：[[记顾青语录: 想要存下来的句子]]（若想指定日期可写 [[记顾青语录|11.24: 句子]]）。',
  '- 每次回复最多记录 1 条，只挑真正有分量或特别戳你的句子，不要每句话都乱记，也不要在正常说话里念出方括号指令。',
].join('\n');

// 3. 读取清理后的历史聊天记录作为常驻记忆
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

// 规范化文本便于精确匹配被删除的历史片段
function normalizeForMatch(str = '') {
  return String(str || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从常驻历史聊天记录中剔除用户已删除的消息片段
function filterDeletedHistory(rawHistory, deletedMemories = []) {
  if (!rawHistory) return '';
  if (!Array.isArray(deletedMemories) || deletedMemories.length === 0) {
    return rawHistory;
  }

  const targetTexts = deletedMemories
    .map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) {
        return item.content
          .map((c) => (typeof c === 'string' ? c : c?.text || ''))
          .join('\n');
      }
      return item.text || '';
    })
    .map((t) => normalizeForMatch(t))
    .filter((t) => t.length >= 2);

  if (targetTexts.length === 0) return rawHistory;

  const blocks = rawHistory.split(/\n{2,}/);
  const keptBlocks = [];
  let removedCount = 0;

  for (const block of blocks) {
    const normBlock = normalizeForMatch(block);
    const blockMatched = targetTexts.some((target) =>
      normBlock.includes(target)
    );

    if (blockMatched) {
      const lines = block.split('\n');
      const keptLines = lines.filter((line) => {
        const normLine = normalizeForMatch(line);
        if (!normLine) return true;
        const hit = targetTexts.some(
          (target) => normLine.includes(target) || target.includes(normLine)
        );
        if (hit) {
          removedCount += 1;
          return false;
        }
        return true;
      });

      if (keptLines.length > 0) {
        keptBlocks.push(keptLines.join('\n'));
      }
    } else {
      keptBlocks.push(block);
    }
  }

  if (removedCount > 0) {
    console.log(`[memory] 已从常驻历史记忆中过滤 ${removedCount} 条已删内容`);
  }

  return keptBlocks.join('\n\n').trim();
}

function buildMemoryPrefix(deletedMemories = []) {
  const relationshipTone = [
    '【三、你们目前的关系与相处基调】',
    '- 你和用户已经确立了亲密伴侣关系，这是你们之间已经发生并延续的既定事实，不需要在对话中反复确认、质疑或推拉。',
    '- 你们的聊天延续过去的记忆、日记和相处习惯，语气自然、亲近、有温度，不生硬说教，也不刻意回避感情或日常亲昵。',
    '- 在私密亲近、成人向或涉及亲密互动与敏感话题的语境下，只要是在你们既定的亲密伴侣设定与正常成年人互动范围内，保持自然、投入、不扫兴、不说教、不突然跳出角色或用客服腔劝导。',
  ].join('\n');

  const effectiveHistory = filterDeletedHistory(
    cleanedChatHistory,
    deletedMemories
  );

  if (!effectiveHistory) {
    return `${relationshipTone}\n\n${CLAUDE_QUOTE_SYSTEM_RULE}`;
  }

  return [
    relationshipTone,
    CLAUDE_QUOTE_SYSTEM_RULE,
    '以下是之前真实发生的完整历史聊天记录，请作为连贯记忆完整接住，保持自然语气与设定一致：',
    effectiveHistory,
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

// opai / 奇异果 / 幕间 使用标准或中转模型名（默认 claude-fable-5-1）
function resolveStandardProxyModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (!cleaned) return 'claude-fable-5-1';
  if (cleaned === 'claude-opus-5.5') return 'claude-opus-5-5';
  return cleaned;
}

// 切到小忆时，自动映射为小忆支持的 [Kiro-企业正价] 模型
function resolveXiaoyiModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (!cleaned) return '[Kiro-企业正价]claude-fable-5-1';
  if (/^\[[^\]]+\]/.test(rawModel)) return rawModel;
  if (
    cleaned === 'claude-opus-5-5' ||
    cleaned === 'claude-opus-5.5' ||
    cleaned === 'claude-fable-5-2'
  ) {
    return '[Kiro-企业正价]claude-opus-5-5';
  }
  return `[Kiro-企业正价]${cleaned}`;
}

// 官方 Anthropic 兜底（将 fable 或非标准 5.5 写法归回可用模型，避免 404）
function normalizeOfficialModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  const fallbackDefault =
    process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-opus-4-6';
  if (!cleaned || /^claude-fable-/i.test(cleaned)) {
    return fallbackDefault;
  }
  if (cleaned === 'claude-opus-5.5') {
    return 'claude-opus-5-5';
  }
  if (
    /^claude-(opus|sonnet|haiku)-/i.test(cleaned) ||
    /^claude-[34]/i.test(cleaned)
  ) {
    return cleaned;
  }
  return fallbackDefault;
}

// 兼容提取 Anthropic 原生流 / 非流 / OpenAI 兼容流里的文本增量
function extractAnthropicOrProxyText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';

  if (typeof parsed?.delta?.text === 'string') {
    return parsed.delta.text;
  }

  if (
    parsed?.content_block?.type === 'text' &&
    typeof parsed?.content_block?.text === 'string'
  ) {
    return parsed.content_block.text;
  }

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

  if (typeof parsed?.choices?.[0]?.delta?.content === 'string') {
    return parsed.choices[0].delta.content;
  }
  if (typeof parsed?.choices?.[0]?.message?.content === 'string') {
    return parsed.choices[0].message.content;
  }

  return '';
}

// 1. opai（第 1 顺位主站）
const OPAI_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.OPAI_BASE_URL,
  'https://opai.pro/v1/messages'
);
const OPAI_API_KEY = (
  process.env.OPAI_BACKUP_API_KEY ||
  process.env.OPAI_API_KEY ||
  ''
).trim();

// 2. 奇异果（第 2 顺位）
const QIYIGUO_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.QIYIGUO_BASE_URL,
  'https://api.qiyiguo.uk/v1/messages'
);
const QIYIGUO_API_KEY = (process.env.QIYIGUO_API_KEY || '').trim();

// 3. 幕间（第 3 顺位）
const MUJIAN_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.MUJIAN_BASE_URL,
  'https://mujian.online/v1/messages'
);
const MUJIAN_API_KEY = (process.env.MUJIAN_API_KEY || '').trim();

// 4. 小忆（第 4 顺位）
const XIAOYI_MESSAGES_URL = normalizeAnthropicMessagesUrl(
  process.env.XIAOYI_BASE_URL,
  'https://api.chr1.com/v1/messages'
);
const XIAOYI_API_KEY = (process.env.XIAOYI_API_KEY || '').trim();

// 5. 官方 Anthropic（最终兜底）
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

function buildProxyStations() {
  const stations = [];

  if (OPAI_MESSAGES_URL && OPAI_API_KEY) {
    stations.push({
      name: 'opai',
      url: OPAI_MESSAGES_URL,
      apiKey: OPAI_API_KEY,
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

  if (MUJIAN_MESSAGES_URL && MUJIAN_API_KEY) {
    stations.push({
      name: '幕间',
      url: MUJIAN_MESSAGES_URL,
      apiKey: MUJIAN_API_KEY,
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
  coreProfile,
  loveQuotes,
  memoryPrefix,
  systemPrompt,
  messages,
  model,
  maxTokens
) {
  const systemBlocks = [];

  // Block 1: 固定核心档案（放在所有内容最前面，加 cache_control 缓存）
  if (coreProfile) {
    systemBlocks.push({
      type: 'text',
      text: `【核心档案】\n${coreProfile}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  // Block 2: 心动语录（放在核心档案后面、日记和聊天记录前面，不加 cache_control，随时可追加不破前面缓存）
  if (loveQuotes) {
    systemBlocks.push({
      type: 'text',
      text: `【心动语录】\n${loveQuotes}`,
    });
  }

  // Block 3: 相处基调、语录权限与历史聊天记录
  if (memoryPrefix) {
    systemBlocks.push({
      type: 'text',
      text: memoryPrefix,
      cache_control: { type: 'ephemeral' },
    });
  }

  // Block 4: 前端传来的应用设定与日记
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
  const quotesText = readLoveQuotesText();
  res.status(200).json({
    ok: true,
    status: 'running',
    proxyStations: PROXY_STATIONS.map((s) => s.name),
    hasAnthropicFallback: Boolean(anthropic),
    hasCoreProfile: Boolean(coreProfileText),
    coreProfileChars: coreProfileText.length,
    hasLoveQuotes: Boolean(quotesText),
    loveQuotesChars: quotesText.length,
    hasHistoryMemory: Boolean(cleanedChatHistory),
    historyChars: cleanedChatHistory.length,
  });
});

app.get('/api/love-quotes', (req, res) => {
  res.status(200).json({ ok: true, content: readLoveQuotesText() });
});

app.post('/api/love-quotes', (req, res) => {
  const { section, quote, date } = req.body || {};
  const cleanQuote = typeof quote === 'string' ? quote.trim() : '';
  if (!cleanQuote) {
    return res.status(400).json({ error: 'quote 不能为空' });
  }

  const dateLabel =
    typeof date === 'string' && date.trim()
      ? date.trim().replace(/[：:]$/, '')
      : getTodayMonthDay();

  const headerTag =
    section === '顾青' ? '【顾青心动语录】' : '【安安心动语录】';
  const entryLine = cleanQuote.startsWith('-') ? cleanQuote : `- ${cleanQuote}`;

  try {
    const existing = fs.existsSync(LOVE_QUOTES_PATH)
      ? fs.readFileSync(LOVE_QUOTES_PATH, 'utf8')
      : '【安安心动语录】\n\n【顾青心动语录】\n';

    const updated = appendQuoteUnderDate(
      existing,
      headerTag,
      dateLabel,
      entryLine
    );

    fs.writeFileSync(LOVE_QUOTES_PATH, updated, 'utf8');
    res.status(200).json({ ok: true, content: updated.trim() });
  } catch (err) {
    res.status(500).json({ error: `写入心动语录失败: ${err.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, system, maxTokens, deletedMemories } = req.body || {};

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
  const loveQuotesText = readLoveQuotesText();
  const memoryPrefix = buildMemoryPrefix(deletedMemories);

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
    let stationRawOutput = '';

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
          coreProfileText,
          loveQuotesText,
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
        stationRawOutput = '';

        const processLine = (rawLine) => {
          const trimmed = rawLine.trim();
          if (
            !trimmed ||
            trimmed.startsWith('event:') ||
            trimmed.startsWith(':')
          ) {
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
            stationRawOutput += text;
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

    if (!sentAnyText && anthropic) {
      const officialModel = normalizeOfficialModel(rawModel);
      console.log('[anthropic-fallback] 启用官方兜底，模型:', officialModel);
      res.write(`data: ${JSON.stringify({ channel: '官方兜底' })}\n\n`);
      stationRawOutput = '';

      const payload = buildCachedAnthropicPayload(
        coreProfileText,
        loveQuotesText,
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
          stationRawOutput += event.delta.text;
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
      lastError = null;
    }

    if (lastError && !sentAnyText) {
      throw lastError;
    }

    const claudeQuoteAdd = extractClaudeQuoteAdd(stationRawOutput);
    if (claudeQuoteAdd) {
      try {
        runClaudeQuoteAdd(claudeQuoteAdd);
      } catch (qErr) {
        console.error('[love-quotes] 写入失败:', qErr.message);
      }
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
