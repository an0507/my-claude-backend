const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 【新增 1】健康检查接口：放在 /api/chat 之前
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'running',
  });
});

// 【新增 2】基础请求校验函数
function validateChatRequest(body) {
  if (!body || typeof body !== 'object') {
    return '请求体格式不正确';
  }

  const { messages, model } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages 必须是非空数组';
  }

  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    if (!item || typeof item !== 'object') {
      return `第 ${i + 1} 条消息格式无效`;
    }
    if (!['user', 'assistant'].includes(item.role)) {
      return `第 ${i + 1} 条消息的 role 必须为 user 或 assistant`;
    }
    if (typeof item.content !== 'string' || item.content.trim() === '') {
      return `第 ${i + 1} 条消息的 content 不能为空`;
    }
  }

  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    return 'model 必须为非空字符串';
  }

  return null;
}

app.post('/api/chat', async (req, res) => {
  // 【新增 3】先校验请求，再设置 SSE 响应头和请求模型
  const validationError = validateChatRequest(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { messages, model } = req.body;
  const selectedModel = (model && model.trim()) || 'claude-sonnet-5';
  console.log('本次请求使用模型:', selectedModel);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await anthropic.messages.stream({
      model: selectedModel,
      max_tokens: 1024,
      messages,
    });

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta?.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
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
  console.log(`服务器已启动，端口 ${PORT}`);
});
