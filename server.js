function getTodayMonthDay() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const sgNow = new Date(utcMs + 8 * 3600 * 1000);
  const month = sgNow.getMonth() + 1;
  const day = String(sgNow.getDate()).padStart(2, '0');
  return `${month}.${day}`;
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

function isDateHeaderLine(line = '') {
  return /^\d{1,2}\.\d{1,2}(?:[：:])?$/.test(String(line || '').trim());
}

function cleanDateLabel(dateStr = '') {
  return String(dateStr || '')
    .trim()
    .replace(/[：:]$/, '');
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

function appendQuoteUnderDate(existingText, headerTag, dateLabel, entryLine) {
  const normalized = String(existingText || '').replace(/\r\n/g, '\n');
  const bounds = getSectionBounds(normalized, headerTag);

  if (!bounds) {
    return `${normalized.trim()}\n\n${headerTag}\n${dateLabel}\n${entryLine}\n`;
  }

  const { afterHeaderIdx, sectionEnd } = bounds;
  const sectionBody = normalized.slice(afterHeaderIdx, sectionEnd);
  const lines = sectionBody.split('\n');

  const dateHeaderIdx = lines.findIndex((line) => {
    const t = cleanDateLabel(line);
    return t === dateLabel;
  });

  if (dateHeaderIdx !== -1) {
    let insertIdx = dateHeaderIdx + 1;
    while (insertIdx < lines.length) {
      const trimmed = lines[insertIdx].trim();
      if (isDateHeaderLine(trimmed)) {
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

  const cleanedLines = cleanupEmptyDateBlocks(lines);
  const updatedSectionBody =
    cleanedLines.length > 0 ? `\n${cleanedLines.join('\n')}\n` : '\n';

  return (
    normalized.slice(0, afterHeaderIdx) +
    updatedSectionBody +
    normalized.slice(sectionEnd)
  );
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

  const { afterHeaderIdx, sectionEnd } = bounds;
  const sectionBody = normalized.slice(afterHeaderIdx, sectionEnd);
  const lines = sectionBody.split('\n');

  const targetPlain = stripBulletPrefix(targetQuote);
  if (!targetPlain) {
    return { ok: false, error: '请提供要修改或删除的原语录 targetQuote' };
  }

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
    const cleanedLines = cleanupEmptyDateBlocks(lines);
    const updatedSectionBody =
      cleanedLines.length > 0 ? `\n${cleanedLines.join('\n')}\n` : '\n';
    const nextText =
      normalized.slice(0, afterHeaderIdx) +
      updatedSectionBody +
      normalized.slice(sectionEnd);
    return { ok: true, content: nextText };
  }

  const replacementLine = normalizeEntryLine(newQuote);
  if (!replacementLine) {
    return { ok: false, error: '修改语录时 newQuote 不能为空' };
  }

  const effectiveDate =
    newDateLabel || dateLabel || currentDate || getTodayMonthDay();
  if (newDateLabel && newDateLabel !== currentDate) {
    lines.splice(matchedLineIdx, 1);
    const cleanedAfterRemove = cleanupEmptyDateBlocks(lines);
    const tempSection =
      cleanedAfterRemove.length > 0
        ? `\n${cleanedAfterRemove.join('\n')}\n`
        : '\n';
    const removedText =
      normalized.slice(0, afterHeaderIdx) +
      tempSection +
      normalized.slice(sectionEnd);
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
  const cleanedLines = cleanupEmptyDateBlocks(lines);
  const updatedSectionBody =
    cleanedLines.length > 0 ? `\n${cleanedLines.join('\n')}\n` : '\n';
  const nextText =
    normalized.slice(0, afterHeaderIdx) +
    updatedSectionBody +
    normalized.slice(sectionEnd);
  return { ok: true, content: nextText };
}

function replaceSectionContent(existingText, headerTag, newSectionContent) {
  const normalized = String(existingText || '').replace(/\r\n/g, '\n');
  const cleanBody = String(newSectionContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*【[^】]+】\s*\n?/, '')
    .trim();

  const bounds = getSectionBounds(normalized, headerTag);
  if (!bounds) {
    const suffix = cleanBody ? `${headerTag}\n${cleanBody}\n` : `${headerTag}\n`;
    return `${normalized.trim()}\n\n${suffix}`;
  }

  const { afterHeaderIdx, sectionEnd } = bounds;
  const replacementBlock = cleanBody ? `\n${cleanBody}\n` : '\n';
  return (
    normalized.slice(0, afterHeaderIdx) +
    replacementBlock +
    normalized.slice(sectionEnd)
  );
}

app.post('/api/love-quotes', (req, res) => {
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
    const existing = fs.existsSync(LOVE_QUOTES_PATH)
      ? fs.readFileSync(LOVE_QUOTES_PATH, 'utf8')
      : '【安安心动语录】\n\n【顾青心动语录】\n';

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
    res.status(200).json({ ok: true, action, content: updated.trim() });
  } catch (err) {
    res.status(500).json({ error: `操作心动语录失败: ${err.message}` });
  }
});
