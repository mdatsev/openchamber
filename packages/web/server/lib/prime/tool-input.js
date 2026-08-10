import path from 'node:path';

const MAX_IPYTHON_CODE_BYTES = 64 * 1024;
const MAX_IPYTHON_DIFFS = 64;
const MAX_IPYTHON_DIFF_SOURCE_BYTES = 128 * 1024;
const MAX_IPYTHON_DIFF_PATCH_BYTES = 256 * 1024;
const MAX_IPYTHON_DIFF_PATH_CHARS = 512;
const MAX_IPYTHON_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_IPYTHON_SANITIZE_TEXT_CHARS = 256 * 1024;
const MAX_IPYTHON_SANITIZE_BLOCKS = 2_048;
const MAX_IPYTHON_DIFF_MATRIX_CELLS = 250_000;
const IPYTHON_DIFF_CONTEXT_LINES = 4;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const splitSnippetLines = (value) => {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  let offset = 0;
  while (offset < normalized.length) {
    const newline = normalized.indexOf('\n', offset);
    if (newline < 0) {
      lines.push({ text: normalized.slice(offset), terminated: false });
      break;
    }
    lines.push({ text: normalized.slice(offset, newline), terminated: true });
    offset = newline + 1;
  }
  return lines;
};

const sameSnippetLine = (left, right) => left?.text === right?.text
  && left?.terminated === right?.terminated;

const basenameDiffPath = (value) => {
  const basename = path.basename(value);
  if (!basename) return null;
  return { path: basename.slice(0, MAX_IPYTHON_DIFF_PATH_CHARS), openable: false };
};

const openableDiffPath = (value) => {
  const displayPath = value.replaceAll(path.sep, '/');
  if (!displayPath || displayPath === '.') return null;
  if (value !== value.trim() || (path.sep === '/' && value.includes('\\'))) {
    return basenameDiffPath(value);
  }
  return displayPath.length <= MAX_IPYTHON_DIFF_PATH_CHARS
    ? { path: displayPath, openable: true }
    : basenameDiffPath(value);
};

const safeDiffPath = (value, workingDirectory) => {
  if (typeof value !== 'string' || !value || value.length > 2_048 || /[\0-\x1f\x7f]/.test(value)) return null;
  const normalized = path.normalize(value);
  if (path.isAbsolute(normalized)) {
    if (typeof workingDirectory === 'string' && path.isAbsolute(workingDirectory)) {
      const relative = path.relative(workingDirectory, normalized);
      if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return openableDiffPath(relative);
      }
    }
    return basenameDiffPath(normalized);
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return basenameDiffPath(normalized);
  }
  return openableDiffPath(normalized);
};

const formatHunkRange = (start, count) => count === 1 ? String(start) : `${start},${count}`;

const buildLineDiffOperations = (oldLines, newLines) => {
  const width = newLines.length + 1;
  const cells = (oldLines.length + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > MAX_IPYTHON_DIFF_MATRIX_CELLS) return null;
  const matrix = new Uint32Array(cells);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      matrix[offset] = sameSnippetLine(oldLines[oldIndex], newLines[newIndex])
        ? matrix[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(matrix[(oldIndex + 1) * width + newIndex], matrix[offset + 1]);
    }
  }
  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length
      && newIndex < newLines.length
      && sameSnippetLine(oldLines[oldIndex], newLines[newIndex])) {
      operations.push({ type: 'context', line: oldLines[oldIndex], oldIndex, newIndex });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const removeScore = oldIndex < oldLines.length ? matrix[(oldIndex + 1) * width + newIndex] : -1;
    const addScore = newIndex < newLines.length ? matrix[oldIndex * width + newIndex + 1] : -1;
    if (oldIndex < oldLines.length && removeScore >= addScore) {
      operations.push({ type: 'delete', line: oldLines[oldIndex], oldIndex, newIndex });
      oldIndex += 1;
    } else {
      operations.push({ type: 'add', line: newLines[newIndex], oldIndex, newIndex });
      newIndex += 1;
    }
  }
  return operations;
};

const buildLineDiffPatch = ({ oldLines, newLines, startLine, displayPath }) => {
  const operations = buildLineDiffOperations(oldLines, newLines);
  if (!operations) return null;
  const changed = operations.flatMap((operation, index) => operation.type === 'context' ? [] : [index]);
  if (changed.length === 0) return { unchanged: true };
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - IPYTHON_DIFF_CONTEXT_LINES);
    const end = Math.min(operations.length, index + IPYTHON_DIFF_CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const rows = [`--- a/${displayPath}`, `+++ b/${displayPath}`];
  let additions = 0;
  let deletions = 0;
  for (const range of ranges) {
    const slice = operations.slice(range.start, range.end);
    const first = slice[0];
    const oldCount = slice.filter((operation) => operation.type !== 'add').length;
    const newCount = slice.filter((operation) => operation.type !== 'delete').length;
    rows.push(`@@ -${formatHunkRange(startLine + first.oldIndex, oldCount)} +${formatHunkRange(startLine + first.newIndex, newCount)} @@`);
    for (const operation of slice) {
      if (operation.type === 'add') {
        additions += 1;
        rows.push(`+${operation.line?.text ?? ''}`);
      } else if (operation.type === 'delete') {
        deletions += 1;
        rows.push(`-${operation.line?.text ?? ''}`);
      } else {
        rows.push(` ${operation.line?.text ?? ''}`);
      }
    }
  }
  return { patch: rows.join('\n'), additions, deletions };
};

const buildPrefixSuffixDiffPatch = ({ oldLines, newLines, startLine, displayPath }) => {
  let prefix = 0;
  while (prefix < oldLines.length
    && prefix < newLines.length
    && sameSnippetLine(oldLines[prefix], newLines[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && sameSnippetLine(oldLines[oldLines.length - suffix - 1], newLines[newLines.length - suffix - 1])) {
    suffix += 1;
  }
  if (prefix === oldLines.length && prefix === newLines.length) return { unchanged: true };
  const beforeStart = Math.max(0, prefix - IPYTHON_DIFF_CONTEXT_LINES);
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const trailingContext = Math.min(IPYTHON_DIFF_CONTEXT_LINES, suffix);
  const oldHunkEnd = oldChangedEnd + trailingContext;
  const newHunkEnd = newChangedEnd + trailingContext;
  const rows = [
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -${formatHunkRange(startLine + beforeStart, oldHunkEnd - beforeStart)} +${formatHunkRange(startLine + beforeStart, newHunkEnd - beforeStart)} @@`,
  ];
  for (let index = beforeStart; index < prefix; index += 1) rows.push(` ${oldLines[index]?.text ?? ''}`);
  for (let index = prefix; index < oldChangedEnd; index += 1) rows.push(`-${oldLines[index]?.text ?? ''}`);
  for (let index = prefix; index < newChangedEnd; index += 1) rows.push(`+${newLines[index]?.text ?? ''}`);
  for (let index = 0; index < trailingContext; index += 1) rows.push(` ${oldLines[oldChangedEnd + index]?.text ?? ''}`);
  return {
    patch: rows.join('\n'),
    additions: Math.max(0, newChangedEnd - prefix),
    deletions: Math.max(0, oldChangedEnd - prefix),
  };
};

const buildBoundedDiffPatch = ({ oldStr, newStr, startLine, displayPath }) => {
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  if (Buffer.byteLength(oldStr, 'utf8') + Buffer.byteLength(newStr, 'utf8') > MAX_IPYTHON_DIFF_SOURCE_BYTES) {
    return null;
  }
  const oldLines = splitSnippetLines(oldStr);
  const newLines = splitSnippetLines(newStr);
  const result = buildLineDiffPatch({ oldLines, newLines, startLine, displayPath })
    ?? buildPrefixSuffixDiffPatch({ oldLines, newLines, startLine, displayPath });
  if (result.unchanged) return null;
  if (Buffer.byteLength(result.patch, 'utf8') > MAX_IPYTHON_DIFF_PATCH_BYTES) return null;
  return result;
};

/** Project only bounded, presentation-safe IPython result details. */
export const normalizePrimeIpythonToolPresentation = (message, workingDirectory) => {
  if (!isRecord(message)
    || message.role !== 'toolResult'
    || String(message.toolName).trim().toLowerCase() !== 'ipython'
    || !isRecord(message.details)) return null;
  const durationMs = Number.isFinite(message.details.durationMs)
    && message.details.durationMs >= 0
    && message.details.durationMs <= MAX_IPYTHON_DURATION_MS
    ? message.details.durationMs
    : undefined;
  const rawDiffs = Array.isArray(message.details.diffs) ? message.details.diffs : [];
  const diffFiles = [];
  let omittedDiffs = Math.max(0, rawDiffs.length - MAX_IPYTHON_DIFFS);
  let totalPatchBytes = 0;
  for (const rawDiff of rawDiffs.slice(0, MAX_IPYTHON_DIFFS)) {
    if (!isRecord(rawDiff)) {
      omittedDiffs += 1;
      continue;
    }
    const projectedPath = safeDiffPath(rawDiff.path, workingDirectory);
    const startLine = Number.isSafeInteger(rawDiff.startLine) && rawDiff.startLine >= 1
      ? rawDiff.startLine
      : 1;
    const diff = projectedPath && buildBoundedDiffPatch({
      oldStr: rawDiff.oldStr,
      newStr: rawDiff.newStr,
      startLine,
      displayPath: projectedPath.path,
    });
    if (!projectedPath || !diff) {
      omittedDiffs += 1;
      continue;
    }
    const patchBytes = Buffer.byteLength(diff.patch, 'utf8');
    if (totalPatchBytes + patchBytes > MAX_IPYTHON_DIFF_PATCH_BYTES) {
      omittedDiffs += 1;
      continue;
    }
    totalPatchBytes += patchBytes;
    diffFiles.push({
      path: projectedPath.path,
      patch: diff.patch,
      additions: diff.additions,
      deletions: diff.deletions,
      openable: projectedPath.openable,
    });
  }
  if (durationMs === undefined && diffFiles.length === 0 && omittedDiffs === 0) return null;
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(diffFiles.length === 0 ? {} : { diffFiles }),
    ...(omittedDiffs === 0 ? {} : { omittedDiffs }),
  };
};

const containsOnlyEditConfirmations = (value, paths) => {
  if (typeof value !== 'string' || value.length > MAX_IPYTHON_SANITIZE_TEXT_CHARS || !value.trim()) return false;
  let remainder = value;
  for (const diffPath of paths) remainder = remainder.split(`Edited ${diffPath}`).join('');
  return /^[\s[\](),"']*$/.test(remainder);
};

const visibleContentTexts = (content) => {
  if (typeof content === 'string') {
    return content.length <= MAX_IPYTHON_SANITIZE_TEXT_CHARS ? [content] : null;
  }
  if (!Array.isArray(content) || content.length > MAX_IPYTHON_SANITIZE_BLOCKS) return null;
  const texts = [];
  let totalChars = 0;
  for (const block of content) {
    const text = typeof block === 'string'
      ? block
      : isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : null;
    if (text === null) return null;
    totalChars += text.length;
    if (totalChars > MAX_IPYTHON_SANITIZE_TEXT_CHARS) return null;
    texts.push(text);
  }
  return texts;
};

/** Suppress only output proven to contain the same confirmations as every projected diff. */
export const shouldSuppressPrimeIpythonEditOutput = (message, presentation) => {
  if (!presentation
    || !Array.isArray(presentation.diffFiles)
    || presentation.diffFiles.length === 0
    || presentation.omittedDiffs
    || !isRecord(message?.details)
    || !Array.isArray(message.details.diffs)
    || message.details.diffs.length !== presentation.diffFiles.length) return false;
  const paths = message.details.diffs
    .map((diff) => isRecord(diff) && typeof diff.path === 'string' ? diff.path : null)
    .filter(Boolean);
  if (paths.length !== message.details.diffs.length) return false;
  const channels = [message.details.stdout, message.details.stderr, message.details.result]
    .filter((value) => typeof value === 'string' && value.length <= MAX_IPYTHON_SANITIZE_TEXT_CHARS && value.trim());
  const contentTexts = visibleContentTexts(message.content);
  return channels.length > 0
    && contentTexts !== null
    && contentTexts.length > 0
    && channels.every((value) => containsOnlyEditConfirmations(value, paths))
    && contentTexts.every((value) => containsOnlyEditConfirmations(value, paths));
};

const replaceKnownEditPaths = (value, replacements) => {
  let sanitized = value;
  for (const replacement of replacements) sanitized = sanitized.split(replacement.raw).join(replacement.display);
  return sanitized;
};

const omittedIpythonOutputBlock = () => ({ type: 'omitted', reason: 'ipython_output_too_large' });

/** Redact adapter-private raw edit paths from any IPython output that remains visible. */
export const sanitizePrimeIpythonEditOutput = (message, content, workingDirectory) => {
  if (!isRecord(message?.details) || !Array.isArray(message.details.diffs)) return content;
  const replacements = message.details.diffs
    .flatMap((diff) => {
      if (!isRecord(diff) || typeof diff.path !== 'string' || !diff.path) return [];
      return [{ raw: diff.path, display: safeDiffPath(diff.path, workingDirectory)?.path ?? '<redacted-path>' }];
    })
    .sort((left, right) => right.raw.length - left.raw.length);
  if (replacements.length === 0) return content;
  if (typeof content === 'string') {
    return content.length <= MAX_IPYTHON_SANITIZE_TEXT_CHARS
      ? replaceKnownEditPaths(content, replacements)
      : [omittedIpythonOutputBlock()];
  }
  if (!Array.isArray(content)) return content;
  const sanitized = [];
  let remainingChars = MAX_IPYTHON_SANITIZE_TEXT_CHARS;
  let omitted = content.length >= MAX_IPYTHON_SANITIZE_BLOCKS;
  for (const block of content.slice(0, MAX_IPYTHON_SANITIZE_BLOCKS - 1)) {
    const text = typeof block === 'string'
      ? block
      : isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : null;
    if (text === null) {
      sanitized.push(block);
      continue;
    }
    if (text.length > remainingChars) {
      omitted = true;
      continue;
    }
    remainingChars -= text.length;
    const projectedText = replaceKnownEditPaths(text, replacements);
    sanitized.push(typeof block === 'string' ? projectedText : { ...block, text: projectedText });
  }
  if (omitted) sanitized.push(omittedIpythonOutputBlock());
  return sanitized;
};

/** Project only the approved transcript-safe tool input; never copy arbitrary arguments. */
export const normalizePrimeToolCallBlock = (block) => {
  if (!isRecord(block) || block.type !== 'toolCall' || typeof block.name !== 'string') return null;
  const name = block.name.trim().slice(0, 128);
  if (!name) return null;
  const projected = { type: 'tool_call', name };
  if (name !== 'ipython') return projected;
  const code = isRecord(block.arguments) ? block.arguments.code : undefined;
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_IPYTHON_CODE_BYTES) {
    return { ...projected, omitted: true };
  }
  return { ...projected, input: { code } };
};
