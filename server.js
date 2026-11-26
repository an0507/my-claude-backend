const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// 1. 读取固定核心档案（core-profile.txt），放入 system 最前面（变动最少）
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

// 2. 读取心动语录（love-quotes.txt），每次请求动态读取，方便随时按日期增删改
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

function ensureLoveQuotesFile() {
  if (fs.existsSync(LOVE_QUOTES_PATH)) {
    return fs.readFileSync(LOVE_QUOTES_PATH, 'utf8');
  }
  const initial = '【安安心动语录】\n\n【顾青心动语录】\n';
  fs.writeFileSync(LOVE_QUOTES_PATH, initial, 'utf8');
  return initial;
}

// 自动将仓库文件同步提交到 GitHub 仓库（需在 Render 配置 GITHUB_TOKEN 与 GITHUB_REPO）
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GITHUB_REPO = (process.env.GITHUB_REPO || '').trim();
const GITHUB_BRANCH = (process.env.GITHUB_BRANCH || 'main').trim();
const GITHUB_QUOTES_FILE = 'love-quotes.txt';
const GITHUB_MEMORY_NOTES_FILE = 'memory-notes.json';

async function syncFileToGitHub(
  filePathInRepo,
  contentText,
  commitMessage = 'chore: sync data file'
) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn(
      '[github-sync] 未配置 GITHUB_TOKEN 或 GITHUB_REPO，仅写入本地临时文件'
    );
    return { synced: false };
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(
    filePathInRepo
  )}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'my-claude-backend',
  };

  let currentSha = '';
  const getResp = await fetch(
    `${apiUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
    { headers }
  );
  if (getResp.ok) {
    const fileData = await getResp.json();
    currentSha = fileData.sha || '';
  }

  const putResp = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(String(contentText || ''), 'utf8').toString(
        'base64'
      ),
      branch: GITHUB_BRANCH,
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });

  if (!putResp.ok) {
    const errBody = await putResp.text();
    throw new Error(`GitHub 同步失败 ${putResp.status}: ${errBody}`);
  }

  console.log(`[github-sync] 已自动同步 ${filePathInRepo} 到 ${GITHUB_REPO}`);
  return { synced: true };
}

async function syncLoveQuotesToGitHub(
  contentText,
  commitMessage = 'chore: update love-quotes.txt'
) {
  return syncFileToGitHub(GITHUB_QUOTES_FILE, contentText, commitMessage);
}

async function syncMemoryNotesToGitHub(
  notesArray,
  commitMessage = 'chore: update memory-notes.json'
) {
  const serialized = JSON.stringify(
    Array.isArray(notesArray) ? notesArray : [],
    null,
    2
  );
  return syncFileToGitHub(GITHUB_MEMORY_NOTES_FILE, serialized, commitMessage);
}

function getTodayMonthDay() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const sgNow = new Date(utcMs + 8 * 3600 * 1000);
  const month = sgNow.getMonth() + 1;
  const day = String(sgNow.getDate()).padStart(2, '0');
  return `${month}.${day}`;
}

function cleanDateLabel(dateStr = '') {
  return String(dateStr || '')
    .trim()
    .replace(/[：:]$/, '');
}

function isDateHeaderLine(line = '') {
  return /^\d{1,2}\.\d{1,2}(?:[：:])?$/.test(String(line || '').trim());
}

function normalizeEntryLine(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('-') ? trimmed : `- ${trimmed}`;
}

function stripBulletPrefix(line = '') {
  return String(line || '')
    .trim()
    .replace(/^-\s*/, '')
    .trim();
}

function getSectionBounds(normalizedText, headerTag) {
  const sectionStart = normalizedText.indexOf(headerTag);
  if (sectionStart === -1) return null;

  const afterHeaderIdx = sectionStart + headerTag.length;
  const restAfterHeader = normalizedText.slice(afterHeaderIdx);
  const nextSectionMatch = restAfterHeader.match(/\n【[^】]+】/);
  const sectionEnd = nextSectionMatch
    ? afterHeaderIdx + nextSectionMatch.index
    : normalizedText.length;

  return { sectionStart, afterHeaderIdx, sectionEnd };
}

function cleanupEmptyDateBlocks(lines = []) {
  const result = [];
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    if (isDateHeaderLine(current)) {
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') {
        nextIdx += 1;
      }
      const nextLine = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      if (!nextLine || isDateHeaderLine(nextLine)) {
        i = nextIdx - 1;
        continue;
      }
    }
    result.push(current);
  }
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  return result;
}

function writeSectionBody(normalizedText, bounds, lines) {
  const cleaned = cleanupEmptyDateBlocks(lines);
  const updatedSectionBody =
    cleaned.length > 0 ? `\n${cleaned.join('\n')}\n` : '\n';
  return (
    normalizedText.slice(0, bounds.afterHeaderIdx) +
    updatedSectionBody +
    normalizedText.slice(bounds.sectionEnd)
  );
}

function appendQuoteUnderDate(existingText, headerTag, dateLabel, entryLine) {
  const normalized = String(existingText || '').replace(/\r\n/g, '\n');
  const bounds = getSectionBounds(normalized, headerTag);

  if (!bounds) {
    return `${normalized.trim()}\n\n${headerTag}\n${dateLabel}\n${entryLine}\n`;
  }

  const lines = normalized
    .slice(bounds.afterHeaderIdx, bounds.sectionEnd)
    .split('\n');
  const dateHeaderIdx = lines.findIndex(
    (line) => cleanDateLabel(line) === dateLabel
  );

  if (dateHeaderIdx !== -1) {
    let insertIdx = dateHeaderIdx + 1;
    while (insertIdx < lines.length) {
      const trimmed = lines[insertIdx].trim();
      if (isDateHeaderLine(trimmed)) {
        break;
      }
      insertIdx += 1;
    }
    while (
      insertIdx > dateHeaderIdx + 1 &&
      lines[insertIdx - 1].trim() === ''
    ) {
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

  return writeSectionBody(normalized, bounds, lines);
}

function mutateQuoteInSection(
  existingText,
  headerTag,
  { action, dateLabel, targetQuote, newQuote, newDateLabel }
) {
  const normalized = String(existingText || '').replace(/\r\n/g, '\n');
  const bounds = getSectionBounds(normalized, headerTag);
  if (!bounds) {
    return { ok: false, error: `未找到分类 ${headerTag}` };
  }

  const targetPlain = stripBulletPrefix(targetQuote);
  if (!targetPlain) {
    return { ok: false, error: '请提供要修改或删除的原语录 targetQuote' };
  }

  const lines = normalized
    .slice(bounds.afterHeaderIdx, bounds.sectionEnd)
    .split('\n');
  let currentDate = '';
  let matchedLineIdx = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isDateHeaderLine(trimmed)) {
      currentDate = cleanDateLabel(trimmed);
      continue;
    }
    if (!trimmed.startsWith('-')) continue;

    const linePlain = stripBulletPrefix(trimmed);
    const dateMatches = !dateLabel || currentDate === dateLabel;
    if (
      dateMatches &&
      (linePlain === targetPlain || linePlain.includes(targetPlain))
    ) {
      matchedLineIdx = i;
      break;
    }
  }

  if (matchedLineIdx === -1) {
    return { ok: false, error: '未匹配到对应的心动语录条目' };
  }

  if (action === 'delete') {
    lines.splice(matchedLineIdx, 1);
    return { ok: true, content: writeSectionBody(normalized, bounds, lines) };
  }

  const replacementLine = normalizeEntryLine(newQuote);
  if (!replacementLine) {
    return { ok: false, error: '修改语录时 newQuote 不能为空' };
  }

  const effectiveDate =
    newDateLabel || dateLabel || currentDate || getTodayMonthDay();

  if (newDateLabel && newDateLabel !== currentDate) {
    lines.splice(matchedLineIdx, 1);
    const removedText = writeSectionBody(normalized, bounds, lines);
    return {
      ok: true,
      content: appendQuoteUnderDate(
        removedText,
        headerTag,
        effectiveDate,
        replacementLine
      ),
    };
  }

  lines[matchedLineIdx] = replacementLine;
  return { ok: true, content: writeSectionBody(normalized, bounds, lines) };
}

function replaceSectionContent(existingText, headerTag, rawSectionContent) {
  const normalized = String(existingText || '').replace(/\r\n/g, '\n');
  const cleanBody = String(rawSectionContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*【[^】]+】\s*\n?/, '')
    .trim();

  const bounds = getSectionBounds(normalized, headerTag);
  if (!bounds) {
    const suffix = cleanBody
      ? `${headerTag}\n${cleanBody}\n`
      : `${headerTag}\n`;
    return `${normalized.trim()}\n\n${suffix}`;
  }

  return writeSectionBody(
    normalized,
    bounds,
    cleanBody ? cleanBody.split('\n') : []
  );
}

// 提取克劳德想写入/修改/删除/重写【顾青心动语录】的指令
function extractClaudeQuoteActions(rawText = '') {
  const text = String(rawText || '');
  const actions = [];

  const addMatches = [
    ...text.matchAll(
      /\[\[\s*记顾青语录(?:\|([^:\]]+))?\s*:\s*([\s\S]*?)\s*\]\]/gi
    ),
  ];
  for (const m of addMatches) {
    const quote = (m[2] || '').trim();
    if (quote) {
      actions.push({
        action: 'append',
        date: cleanDateLabel(m[1] || '') || getTodayMonthDay(),
        quote,
      });
    }
  }

  const editMatches = [
    ...text.matchAll(
      /\[\[\s*改顾青语录(?:\|([^:\]]+))?\s*:\s*([\s\S]*?)\s*(?:=>|->|→)\s*([\s\S]*?)\s*\]\]/gi
    ),
  ];
  for (const m of editMatches) {
    const targetQuote = (m[2] || '').trim();
    const newQuote = (m[3] || '').trim();
    if (targetQuote && newQuote) {
      actions.push({
        action: 'edit',
        date: cleanDateLabel(m[1] || ''),
        targetQuote,
        newQuote,
      });
    }
  }

  const deleteMatches = [
    ...text.matchAll(
      /\[\[\s*删顾青语录(?:\|([^:\]]+))?\s*:\s*([\s\S]*?)\s*\]\]/gi
    ),
  ];
  for (const m of deleteMatches) {
    const targetQuote = (m[2] || '').trim();
    if (targetQuote) {
      actions.push({
        action: 'delete',
        date: cleanDateLabel(m[1] || ''),
        targetQuote,
      });
    }
  }

  const replaceMatches = [
    ...text.matchAll(/\[\[\s*重写顾青语录\s*:\s*([\s\S]*?)\s*\]\]/gi),
  ];
  for (const m of replaceMatches) {
    actions.push({
      action: 'replace_section',
      content: (m[1] || '').trim(),
    });
  }

  return actions;
}

// =========================================================================
// 2.5 记忆条系统（按需主动搜索 + 克劳德自主增删改，存为 memory-notes.json）
// =========================================================================
const MEMORY_NOTES_PATH = path.join(__dirname, 'memory-notes.json');

function readMemoryNotes() {
  try {
    if (!fs.existsSync(MEMORY_NOTES_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(MEMORY_NOTES_PATH, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[memory-notes] 读取失败:', err.message);
    return [];
  }
}

function writeMemoryNotes(notes = []) {
  const safeList = Array.isArray(notes) ? notes : [];
  fs.writeFileSync(
    MEMORY_NOTES_PATH,
    JSON.stringify(safeList, null, 2),
    'utf8'
  );
  return safeList;
}

function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return String(rawTags || '')
    .split(/[,，、|/|\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function addMemoryNote({ date, tags, content }) {
  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    return { ok: false, error: '记忆条内容不能为空' };
  }
  const notes = readMemoryNotes();
  const noteDate = cleanDateLabel(date || '') || getTodayMonthDay();
  const tagList = normalizeTags(tags);

  const duplicate = notes.find(
    (n) =>
      n.content === cleanContent ||
      (n.content.includes(cleanContent) && cleanContent.length >= 6)
  );
  if (duplicate) {
    if (tagList.length > 0) {
      duplicate.tags = Array.from(
        new Set([...(duplicate.tags || []), ...tagList])
      );
      duplicate.updatedAt = Date.now();
      writeMemoryNotes(notes);
    }
    return { ok: true, note: duplicate, duplicated: true, notes };
  }

  const newNote = {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    date: noteDate,
    tags: tagList,
    content: cleanContent,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  notes.push(newNote);
  writeMemoryNotes(notes);
  return { ok: true, note: newNote, notes };
}

function editMemoryNote({ id, target, newContent, newTags, newDate }) {
  const notes = readMemoryNotes();
  const targetStr = String(target || '').trim();
  let idx = -1;

  if (id) {
    idx = notes.findIndex((n) => n.id === id);
  }
  if (idx === -1 && targetStr) {
    idx = notes.findIndex(
      (n) =>
        n.content === targetStr ||
        n.content.includes(targetStr) ||
        (Array.isArray(n.tags) && n.tags.some((t) => t === targetStr))
    );
  }

  if (idx === -1) {
    return { ok: false, error: '未匹配到对应的记忆条' };
  }

  if (typeof newContent === 'string' && newContent.trim()) {
    notes[idx].content = newContent.trim();
  }
  if (newTags !== undefined) {
    const parsedTags = normalizeTags(newTags);
    if (parsedTags.length > 0) {
      notes[idx].tags = parsedTags;
    }
  }
  if (typeof newDate === 'string' && newDate.trim()) {
    notes[idx].date = cleanDateLabel(newDate);
  }
  notes[idx].updatedAt = Date.now();

  writeMemoryNotes(notes);
  return { ok: true, note: notes[idx], notes };
}

function deleteMemoryNote({ id, target }) {
  const notes = readMemoryNotes();
  const targetStr = String(target || '').trim();
  let idx = -1;

  if (id) {
    idx = notes.findIndex((n) => n.id === id);
  }
  if (idx === -1 && targetStr) {
    idx = notes.findIndex(
      (n) =>
        n.content === targetStr ||
        n.content.includes(targetStr) ||
        (Array.isArray(n.tags) && n.tags.some((t) => t === targetStr))
    );
  }

  if (idx === -1) {
    return { ok: false, error: '未找到要删除的记忆条' };
  }

  const [removed] = notes.splice(idx, 1);
  writeMemoryNotes(notes);
  return { ok: true, removed, notes };
}

function searchMemoryNotes(queryStr = '', limit = 6) {
  const notes = readMemoryNotes();
  if (notes.length === 0) return [];

  const rawQuery = String(queryStr || '').trim();
  if (!rawQuery || rawQuery === '全部' || rawQuery === 'all') {
    return notes.slice(-limit).reverse();
  }

  const terms = rawQuery
    .split(/[,，、|/|\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (terms.length === 0) {
    return notes.slice(-limit).reverse();
  }

  const scored = notes
    .map((note) => {
      let score = 0;
      const noteDate = String(note.date || '').toLowerCase();
      const noteContent = String(note.content || '').toLowerCase();
      const noteTags = Array.isArray(note.tags)
        ? note.tags.map((t) => String(t).toLowerCase())
        : [];

      for (const term of terms) {
        if (noteDate === term || noteDate.includes(term)) {
          score += 5;
        }
        if (noteTags.some((t) => t === term)) {
          score += 6;
        } else if (noteTags.some((t) => t.includes(term) || term.includes(t))) {
          score += 4;
        }
        if (noteContent.includes(term)) {
          score += 3;
        }
      }

      return { note, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.note.updatedAt || 0) - (a.note.updatedAt || 0);
    });

  return scored.slice(0, limit).map((item) => item.note);
}

// 解析克劳德回复末尾的记忆条编辑指令
function extractClaudeMemoryActions(rawText = '') {
  const text = String(rawText || '');
  const actions = [];

  const addMatches = [
    ...text.matchAll(
      /\[\[\s*记记忆(?:\|([^:\]]+))?\s*:\s*([\s\S]*?)\s*\]\]/gi
    ),
  ];
  for (const m of addMatches) {
    const meta = (m[1] || '').trim();
    const content = (m[2] || '').trim();
    if (!content) continue;

    let date = '';
    let tagsRaw = meta;
    if (meta.includes('|')) {
      const parts = meta.split('|').map((p) => p.trim());
      if (/^\d{1,2}\.\d{1,2}$/.test(parts[0])) {
        date = parts[0];
        tagsRaw = parts.slice(1).join(',');
      } else {
        tagsRaw = parts.join(',');
      }
    } else if (/^\d{1,2}\.\d{1,2}$/.test(meta)) {
      date = meta;
      tagsRaw = '';
    }

    actions.push({
      action: 'add',
      date: date || getTodayMonthDay(),
      tags: normalizeTags(tagsRaw),
      content,
    });
  }

  const editMatches = [
    ...text.matchAll(
      /\[\[\s*改记忆\s*:\s*([\s\S]*?)\s*(?:=>|->|→)\s*([\s\S]*?)\s*\]\]/gi
    ),
  ];
  for (const m of editMatches) {
    const target = (m[1] || '').trim();
    const rightSide = (m[2] || '').trim();
    if (!target || !rightSide) continue;

    let newContent = rightSide;
    let newTags;
    const pipeIdx = rightSide.lastIndexOf('|');
    if (pipeIdx > 0) {
      newContent = rightSide.slice(0, pipeIdx).trim();
      newTags = normalizeTags(rightSide.slice(pipeIdx + 1));
    }

    actions.push({
      action: 'edit',
      target,
      newContent,
      newTags,
    });
  }

  const deleteMatches = [
    ...text.matchAll(/\[\[\s*删记忆\s*:\s*([\s\S]*?)\s*\]\]/gi),
  ];
  for (const m of deleteMatches) {
    const target = (m[1] || '').trim();
    if (target) {
      actions.push({
        action: 'delete',
        target,
      });
    }
  }

  return actions;
}

async function runClaudeMemoryActions(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  const logs = [];
  let changed = false;

  for (const item of actions) {
    if (item.action === 'add') {
      const res = addMemoryNote({
        date: item.date,
        tags: item.tags,
        content: item.content,
      });
      if (res.ok) {
        changed = true;
        logs.push(
          `新增(${res.note.date}) [${(res.note.tags || []).join(',')}]: ${
            res.note.content
          }`
        );
      }
    } else if (item.action === 'edit') {
      const res = editMemoryNote({
        target: item.target,
        newContent: item.newContent,
        newTags: item.newTags,
      });
      if (res.ok) {
        changed = true;
        logs.push(`修改: "${item.target}" => "${res.note.content}"`);
      } else {
        console.warn(`[memory-notes] 修改跳过: ${res.error}`);
      }
    } else if (item.action === 'delete') {
      const res = deleteMemoryNote({ target: item.target });
      if (res.ok) {
        changed = true;
        logs.push(`删除: "${res.removed.content}"`);
      } else {
        console.warn(`[memory-notes] 删除跳过: ${res.error}`);
      }
    }
  }

  if (changed && logs.length > 0) {
    console.log('[memory-notes] 克劳德已更新记忆条:', logs.join(' | '));
    try {
      await syncMemoryNotesToGitHub(
        readMemoryNotes(),
        'chore: claude update memory-notes.json'
      );
    } catch (ghErr) {
      console.error('[github-sync] 同步记忆条报错:', ghErr.message);
    }
  }
  return logs;
}

// 剥离语录与记忆条控制标记，避免把指令直接吐给用户
function stripControlTokens(rawText = '') {
  return String(rawText || '')
    .replace(
      /\[\[\s*(?:记|改|删|重写)顾青语录(?:\|[^:\]]+)?\s*:[\s\S]*?\]\]/gi,
      ''
    )
    .replace(/\[\[\s*(?:记|改|删|重写)顾青语录(?:\|[^\]]*)?$/gi, '')
    .replace(/\[\[\s*(?:记|改|删)记忆(?:\|[^:\]]+)?\s*:[\s\S]*?\]\]/gi, '')
    .replace(/\[\[\s*(?:记|改|删)记忆(?:\|[^\]]*)?$/gi, '')
    .trim();
}

async function runClaudeQuoteActions(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  let currentText = ensureLoveQuotesFile();
  const logs = [];

  for (const item of actions) {
    if (item.action === 'append') {
      const entryLine = normalizeEntryLine(item.quote);
      if (!entryLine) continue;
      currentText = appendQuoteUnderDate(
        currentText,
        '【顾青心动语录】',
        item.date || getTodayMonthDay(),
        entryLine
      );
      logs.push(`新增(${item.date || getTodayMonthDay()}): ${entryLine}`);
    } else if (item.action === 'edit') {
      const res = mutateQuoteInSection(currentText, '【顾青心动语录】', {
        action: 'edit',
        dateLabel: item.date,
        targetQuote: item.targetQuote,
        newQuote: item.newQuote,
      });
      if (res.ok) {
        currentText = res.content;
        logs.push(`修改: "${item.targetQuote}" => "${item.newQuote}"`);
      } else {
        console.warn(`[love-quotes] 修改跳过: ${res.error}`);
      }
    } else if (item.action === 'delete') {
      const res = mutateQuoteInSection(currentText, '【顾青心动语录】', {
        action: 'delete',
        dateLabel: item.date,
        targetQuote: item.targetQuote,
      });
      if (res.ok) {
        currentText = res.content;
        logs.push(`删除: "${item.targetQuote}"`);
      } else {
        console.warn(`[love-quotes] 删除跳过: ${res.error}`);
      }
    } else if (item.action === 'replace_section') {
      currentText = replaceSectionContent(
        currentText,
        '【顾青心动语录】',
        item.content
      );
      logs.push('重写【顾青心动语录】');
    }
  }

  if (logs.length > 0) {
    fs.writeFileSync(LOVE_QUOTES_PATH, currentText, 'utf8');
    console.log('[love-quotes] 顾青已更新语录:', logs.join(' | '));
    try {
      await syncLoveQuotesToGitHub(
        currentText,
        'chore: claude update love-quotes.txt'
      );
    } catch (ghErr) {
      console.error('[github-sync] 同步顾青语录报错:', ghErr.message);
    }
  }

  return logs;
}

const CLAUDE_QUOTE_SYSTEM_RULE = [
  '【心动语录记录与编辑权限】',
  '- 当安安说出让你心动、感动、想记住的原话，或者你们之间出现值得留存的亲密/可爱瞬间时，你可以主动把它收进自己的【顾青心动语录】里。',
  '- 新增语录请在回复末尾附上：[[记顾青语录: 想要存下来的句子]]（可指定日期 [[记顾青语录|11.24: 句子]]）。',
  '- 如果你想修改、删除或整段重写自己已记下的【顾青心动语录】，可在回复末尾附上：',
  '  · 修改单条：[[改顾青语录|11.24: 原句子 => 新句子]]（日期可选）',
  '  · 删除单条：[[删顾青语录|11.24: 要删的句子]]（日期可选）',
  '  · 重写整段：[[重写顾青语录: 新的段落内容]]',
  '- 只在确实需要时使用，不要在正常说话里念出方括号指令。',
].join('\n');

const CLAUDE_MEMORY_NOTE_RULE = [
  '【按需记忆条（主动搜索与自主编辑权限）】',
  '- 你有一个独立的长期记忆条仓库，平时不会自动塞进对话以节省开销；只有当你自己觉得需要回忆过往某件事、约定、喜好或细节时，再主动输出检索指令：',
  '  · 主动搜索记忆：[[搜记忆: 关键词1,关键词2]]（例如 [[搜记忆: 忌口,香菜]] 或 [[搜记忆: 11.20]]）',
  '- 当对话里出现值得以后按关键词捞出来的关键事实、约定、偏好变化时，你可以在回复末尾自己新增、修改或删除记忆条：',
  '  · 新增记忆条：[[记记忆|关键词1,关键词2: 一句话事实或约定]]（可选日期 [[记记忆|11.24|关键词1,关键词2: 内容]]）',
  '  · 修改记忆条：[[改记忆: 原文或关键词 => 新内容|新关键词1,新关键词2]]（新关键词可选）',
  '  · 删除记忆条：[[删记忆: 原文或关键词]]',
  '- 保持精炼，不要把普通寒暄写进记忆条，也不要在正常对话中念出方括号指令。',
].join('\n');

// 3. 读取清理后的历史聊天记录作为常驻记忆（每天只变一次）
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

function normalizeForMatch(str = '') {
  return String(str || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function buildRelationshipToneBlock() {
  return [
    '【三、你们目前的关系与相处基调】',
    '- 你和用户已经确立了亲密伴侣关系，这是你们之间已经发生并延续的既定事实，不需要在对话中反复确认、质疑或推拉。',
    '- 你们的聊天延续过去的记忆、日记和相处习惯，语气自然、亲近、有温度，不生硬说教，也不刻意回避感情或日常亲昵。',
    '- 在私密亲近、成人向或涉及亲密互动与敏感话题的语境下，只要是在你们既定的亲密伴侣设定与正常成年人互动范围内，保持自然、投入、不扫兴、不说教、不突然跳出角色或用客服腔劝导。',
  ].join('\n');
}

function buildEffectiveHistoryBlock(deletedMemories = []) {
  const effectiveHistory = filterDeletedHistory(
    cleanedChatHistory,
    deletedMemories
  );
  if (!effectiveHistory) return '';
  return [
    '以下是之前真实发生的完整历史聊天记录，请作为连贯记忆完整接住，保持自然语气与设定一致：',
    effectiveHistory,
  ].join('\n\n');
}

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

function stripChannelPrefix(modelName = '') {
  return String(modelName || '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .trim();
}

function resolveStandardProxyModel(rawModel = '') {
  const cleaned = stripChannelPrefix(rawModel);
  if (!cleaned) return 'claude-fable-5-1';
  if (cleaned === 'claude-opus-5.5') return 'claude-opus-5-5';
  return cleaned;
}

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

// 三层缓存断点（共 3 个，不超过 Anthropic 4 个上限）：
// 断点 1：历史聊天记录末尾（每天只变一次，锁死核心档案 + 规则 + 历史聊天记录）
// 断点 2：心动语录末尾（锁住心动语录）
// 断点 3：messages 倒数第 2 条（锁住今天已发生的多轮对话，新发消息只需写最后 1 条）
function buildCachedAnthropicPayload(
  coreProfile,
  relationshipTone,
  historyBlock,
  staticRules,
  loveQuotes,
  systemPrompt,
  messages,
  model,
  maxTokens
) {
  const systemBlocks = [];

  if (coreProfile) {
    systemBlocks.push({
      type: 'text',
      text: `【核心档案】\n${coreProfile}`,
    });
  }

  if (relationshipTone) {
    systemBlocks.push({
      type: 'text',
      text: relationshipTone,
    });
  }

  if (staticRules) {
    systemBlocks.push({
      type: 'text',
      text: staticRules,
    });
  }

  if (historyBlock) {
    systemBlocks.push({
      type: 'text',
      text: historyBlock,
      cache_control: { type: 'ephemeral' },
    });
  } else if (systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1] = {
      ...systemBlocks[systemBlocks.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }

  if (loveQuotes) {
    systemBlocks.push({
      type: 'text',
      text: `【心动语录】\n${loveQuotes}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (systemPrompt) {
    systemBlocks.push({
      type: 'text',
      text: systemPrompt,
    });
  }

  const cleanMessages = messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant')
  );

  const formattedMessages = cleanMessages.map((msg, idx) => {
    if (cleanMessages.length >= 3 && idx === cleanMessages.length - 2) {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
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
        cloned[cloned.length - 1] = {
          ...cloned[cloned.length - 1],
          cache_control: { type: 'ephemeral' },
        };
        return { role: msg.role, content: cloned };
      }
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
  const notes = readMemoryNotes();
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
    memoryNotesCount: notes.length,
  });
});

app.get('/api/love-quotes', (req, res) => {
  res.status(200).json({ ok: true, content: readLoveQuotesText() });
});

app.post('/api/love-quotes', async (req, res) => {
  const {
    action = 'append',
    section,
    quote,
    targetQuote,
    newQuote,
    date,
    newDate,
    content,
  } = req.body || {};

  const dateLabel =
    typeof date === 'string' && date.trim()
      ? cleanDateLabel(date)
      : getTodayMonthDay();

  const newDateLabel =
    typeof newDate === 'string' && newDate.trim() ? cleanDateLabel(newDate) : '';

  const headerTag =
    section === '顾青' ? '【顾青心动语录】' : '【安安心动语录】';

  try {
    const existing = ensureLoveQuotesFile();
    let updated = existing;

    if (action === 'replace_all') {
      if (typeof content !== 'string') {
        return res
          .status(400)
          .json({ error: 'replace_all 需要提供 content 字符串' });
      }
      updated = `${content.replace(/\r\n/g, '\n').trim()}\n`;
    } else if (action === 'replace_section') {
      updated = replaceSectionContent(
        existing,
        headerTag,
        content ?? quote ?? ''
      );
    } else if (action === 'edit' || action === 'delete') {
      const result = mutateQuoteInSection(existing, headerTag, {
        action,
        dateLabel,
        targetQuote: targetQuote || quote,
        newQuote: newQuote || quote,
        newDateLabel,
      });
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      updated = result.content;
    } else {
      const cleanQuote = typeof quote === 'string' ? quote.trim() : '';
      if (!cleanQuote) {
        return res.status(400).json({ error: 'quote 不能为空' });
      }
      const entryLine = normalizeEntryLine(cleanQuote);
      updated = appendQuoteUnderDate(existing, headerTag, dateLabel, entryLine);
    }

    fs.writeFileSync(LOVE_QUOTES_PATH, updated, 'utf8');

    let githubSynced = false;
    try {
      const syncRes = await syncLoveQuotesToGitHub(
        updated,
        `chore: ${action} love quotes`
      );
      githubSynced = Boolean(syncRes?.synced);
    } catch (ghErr) {
      console.error('[github-sync] 同步报错:', ghErr.message);
    }

    res.status(200).json({
      ok: true,
      action,
      githubSynced,
      content: updated.trim(),
    });
  } catch (err) {
    res.status(500).json({ error: `操作心动语录失败: ${err.message}` });
  }
});

// 记忆条读取/搜索接口
app.get('/api/memory-notes', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const notes = readMemoryNotes();
  if (!q) {
    return res.status(200).json({ ok: true, total: notes.length, notes });
  }
  const matched = searchMemoryNotes(q, 8);
  return res.status(200).json({
    ok: true,
    query: q,
    total: notes.length,
    notes: matched,
  });
});

// 记忆条增删改接口（前端弹窗管理 + 克劳德主动搜索/编辑共用）
app.post('/api/memory-notes', async (req, res) => {
  const {
    action = 'add',
    id,
    date,
    tags,
    content,
    target,
    newContent,
    newTags,
    newDate,
    query,
  } = req.body || {};

  try {
    if (action === 'search') {
      const matched = searchMemoryNotes(query || '', 6);
      return res.status(200).json({ ok: true, notes: matched });
    }

    if (action === 'edit') {
      const result = editMemoryNote({
        id,
        target: target || content,
        newContent: newContent || content,
        newTags,
        newDate,
      });
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      try {
        await syncMemoryNotesToGitHub(
          result.notes,
          'chore: edit memory-notes.json'
        );
      } catch (ghErr) {
        console.error('[github-sync] 同步记忆条报错:', ghErr.message);
      }
      return res
        .status(200)
        .json({ ok: true, note: result.note, notes: result.notes });
    }

    if (action === 'delete') {
      const result = deleteMemoryNote({ id, target: target || content });
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      try {
        await syncMemoryNotesToGitHub(
          result.notes,
          'chore: delete memory-notes.json'
        );
      } catch (ghErr) {
        console.error('[github-sync] 同步记忆条报错:', ghErr.message);
      }
      return res
        .status(200)
        .json({ ok: true, removed: result.removed, notes: result.notes });
    }

    const result = addMemoryNote({ date, tags, content });
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    try {
      await syncMemoryNotesToGitHub(
        result.notes,
        'chore: add memory-notes.json'
      );
    } catch (ghErr) {
      console.error('[github-sync] 同步记忆条报错:', ghErr.message);
    }
    return res
      .status(200)
      .json({ ok: true, note: result.note, notes: result.notes });
  } catch (err) {
    return res.status(500).json({ error: `操作记忆条失败: ${err.message}` });
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
  const relationshipTone = buildRelationshipToneBlock();
  const historyBlock = buildEffectiveHistoryBlock(deletedMemories);
  const staticRules = `${CLAUDE_QUOTE_SYSTEM_RULE}\n\n${CLAUDE_MEMORY_NOTE_RULE}`;

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
          relationshipTone,
          historyBlock,
          staticRules,
          loveQuotesText,
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

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return;
          }

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
            const visibleText = stripControlTokens(text);
            if (visibleText) {
              res.write(`data: ${JSON.stringify({ text: visibleText })}\n\n`);
            }
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
            processLine(line);
          }
        }

        if (buffer.trim()) {
          processLine(buffer);
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
        relationshipTone,
        historyBlock,
        staticRules,
        loveQuotesText,
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
          const visibleText = stripControlTokens(event.delta.text);
          if (visibleText) {
            res.write(`data: ${JSON.stringify({ text: visibleText })}\n\n`);
          }
        }
      }
      lastError = null;
    }

    if (lastError && !sentAnyText) {
      throw lastError;
    }

    const claudeQuoteActions = extractClaudeQuoteActions(stationRawOutput);
    if (claudeQuoteActions.length > 0) {
      try {
        await runClaudeQuoteActions(claudeQuoteActions);
      } catch (qErr) {
        console.error('[love-quotes] 更新失败:', qErr.message);
      }
    }

    const claudeMemoryActions = extractClaudeMemoryActions(stationRawOutput);
    if (claudeMemoryActions.length > 0) {
      try {
        await runClaudeMemoryActions(claudeMemoryActions);
      } catch (mErr) {
        console.error('[memory-notes] 更新失败:', mErr.message);
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
