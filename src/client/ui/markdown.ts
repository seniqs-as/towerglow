/**
 * Markdown, drawn with nodes: what the models write in outcomes, reviews,
 * answers and questions.
 *
 * Every model that writes to these panels writes Markdown -- `**bold**`,
 * lists, tables, fenced code -- and a box that shows it as typed puts
 * asterisks and pipes all over the text. Measured on the jobs on disk: 16 of
 * 19 outcomes had bold, 15 fenced code, 9 a table.
 *
 * Never through `innerHTML`. The text comes from a model that read files
 * nobody here chose, so every piece of it lands in a `textContent` and markup
 * in it is only ever text. A link keeps its words and loses its target (the
 * target goes in a tooltip), an image is its alt text: a click or a fetch
 * that leaves the loopback is what the client never does.
 *
 * The subset models write, not CommonMark. Two choices differ on purpose: a
 * single newline inside a paragraph stays a line break, as these boxes showed
 * it when they were `pre-wrap`; and anything not recognised stays as text --
 * an asterisk that opens nothing is an asterisk, never dropped. The parse is
 * pure and runs in Node (`test/markdown.test.ts`); only `renderMarkdown`
 * touches the DOM.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; c: Inline[]; href: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const DELIMITER_ROW = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/;
const WORD = /[\p{L}\p{N}]/u;

/** The text, as blocks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    // A tab at the start is four columns: it is what decides nesting.
    .map((l) => l.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  return blocks(lines);
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      i = fenceAt(lines, i, fence, out);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'h', level: heading[1]!.length, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(QUOTE, ''));
      out.push({ t: 'quote', c: blocks(inner) });
      continue;
    }
    if (ITEM.test(line)) {
      i = listAt(lines, i, out);
      continue;
    }
    if (tableAt(lines, i)) {
      i = table(lines, i, out);
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]!) && !startsBlock(lines, i)) para.push(lines[i++]!.trim());
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}

function blank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Whether the line opens a block of its own, and so ends the paragraph before
 * it. A list does, whatever its first number: "Modified files:" and a list
 * under it, with no blank line between, is how models write it.
 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
    || ITEM.test(line) || tableAt(lines, i);
}

/** A fence runs to the one that closes it, or to the end: an unclosed fence is still code. */
function fenceAt(lines: string[], start: number, open: RegExpExecArray, out: Block[]): number {
  const indent = open[1]!.length;
  const mark = open[2]!;
  const body: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (indentOf(line) <= 3 && t.length >= mark.length && t === mark[0]!.repeat(t.length)) {
      i++;
      break;
    }
    body.push(line.slice(Math.min(indent, indentOf(line))));
  }
  out.push({ t: 'code', lang: open[3] ?? '', v: body.join('\n') });
  return i;
}

function ordered(marker: string): boolean {
  return /\d/.test(marker);
}

/**
 * A list, with its items and what is nested in them.
 *
 * A line belongs to an item when it is indented past the item's marker --
 * not to the content column, as CommonMark wants: models nest `- ` under
 * `1. ` with two spaces as often as with three, and the stricter rule turned
 * each of those sub-lists into a list of its own after the first. A blank
 * line stays in the item only if something indented follows it, and a line
 * that opens nothing continues the paragraph above it (a lazy line).
 */
function listAt(lines: string[], start: number, out: Block[]): number {
  const first = ITEM.exec(lines[start]!)!;
  const kind = ordered(first[2]!);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || ordered(m[2]!) !== kind) break;
    const indent = m[1]!.length;
    const column = m[3] ? m[0].length : m[0].length + 1;
    const own = [lines[i]!.slice(m[0].length)];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (blank(line)) {
        let j = i;
        while (j < lines.length && blank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) > indent) {
          for (; i < j; i++) own.push('');
          continue;
        }
        break;
      }
      const ind = indentOf(line);
      if (ind > indent) {
        own.push(line.slice(Math.min(ind, column)));
        i++;
        continue;
      }
      if (!blank(lines[i - 1]!) && !startsBlock(lines, i)) {
        own.push(line.trimStart());
        i++;
        continue;
      }
      break;
    }
    items.push(blocks(own));
    let j = i;
    while (j < lines.length && blank(lines[j]!)) j++;
    const next = j < lines.length ? ITEM.exec(lines[j]!) : null;
    if (!next || ordered(next[2]!) !== kind) break;
    i = j;
  }
  out.push({ t: 'list', ordered: kind, start: kind ? Number.parseInt(first[2]!, 10) : 1, items });
  return i;
}

/** A header line with a pipe, and under it a row of dashes with one too. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i]!;
  const rule = lines[i + 1];
  return rule !== undefined && head.includes('|') && rule.includes('|') && DELIMITER_ROW.test(rule);
}

function table(lines: string[], start: number, out: Block[]): number {
  const align: Align[] = cells(lines[start + 1]!).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  // The row of dashes says how many columns there are; a row with more or
  // fewer cells is cut or padded to it, never dropped.
  const row = (line: string): Inline[][] => {
    const got = cells(line);
    return align.map((_, k) => parseInline(got[k] ?? ''));
  };
  const head = row(lines[start]!);
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line) || !line.includes('|')) break;
    if (FENCE.test(line) || HEADING.test(line) || QUOTE.test(line)) break;
    rows.push(row(line));
    i++;
  }
  out.push({ t: 'table', align, head, rows });
  return i;
}

/**
 * The cells of a row. Split on every pipe not escaped, code spans included:
 * that is the GFM rule, and a stray backtick then cannot swallow the rest of
 * the row.
 */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** The spans of one block of text: newlines become line breaks. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (!text) return;
    text.split('\n').forEach((part, k) => {
      if (k > 0) out.push({ t: 'br' });
      if (part) out.push({ t: 'text', v: part });
    });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runOf(src, i, '`');
      const close = closingTicks(src, i + run, run);
      if (close < 0) {
        text += src.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      out.push({ t: 'code', v: codeText(src.slice(i + run, close)) });
      i = close + run;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const image = c === '!';
      const link = linkAt(src, image ? i + 1 : i);
      if (link) {
        flush();
        // An image is its words: loading it would be a request out.
        if (image) out.push(...parseInline(link.label));
        else out.push({ t: 'link', c: parseInline(link.label), href: link.href });
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(src.slice(i));
      if (auto) {
        text += auto[1];
        i += auto[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const span = emphasisAt(src, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.end;
        continue;
      }
      // The whole run stays text: trying again one character in would pair
      // the second asterisk of a `**` that closes nothing.
      const run = runOf(src, i, c);
      text += src.slice(i, i + run);
      i += run;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function runOf(src: string, i: number, ch: string): number {
  let j = i;
  while (src[j] === ch) j++;
  return j - i;
}

/** Where a run of exactly `n` backticks starts, from `from` on; -1 if none. */
function closingTicks(src: string, from: number, n: number): number {
  let j = src.indexOf('`', from);
  while (j >= 0) {
    const run = runOf(src, j, '`');
    if (run === n) return j;
    j = src.indexOf('`', j + run);
  }
  return -1;
}

/** One space each side is padding for a backtick next to the edge, not content. */
function codeText(raw: string): string {
  const v = raw.replace(/\n/g, ' ');
  return v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim() ? v.slice(1, -1) : v;
}

/** `[label](target)`, with `start` on the bracket. */
function linkAt(src: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let j = start;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const target = /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(j + 1));
  if (!target) return null;
  return { label: src.slice(start + 1, j), href: target[1]!, end: j + 1 + target[0].length };
}

/**
 * `*em*`, `**strong**`, `***both***`, `~~struck~~`, and the same with `_`.
 *
 * An opener is followed by something that is not a space, a closer is
 * preceded by one, and the closer is a run of exactly as many: `2 * 3` is
 * arithmetic, and the `**` inside `*a **b** c*` is not what closes the `*`.
 * With `_` both sides must be the edge of a word, or every `snake_case_name`
 * in an outcome would turn half italic.
 */
function emphasisAt(src: string, i: number): { node: Inline; end: number } | null {
  const ch = src[i]!;
  const run = runOf(src, i, ch);
  if (ch === '~' ? run !== 2 : run > 3) return null;
  const after = src[i + run];
  if (after === undefined || /\s/.test(after)) return null;
  if (ch === '_' && i > 0 && WORD.test(src[i - 1]!)) return null;
  const close = closerOf(src, i + run, ch, run);
  if (close < 0) return null;
  const inner = parseInline(src.slice(i + run, close));
  const node: Inline = ch === '~' ? { t: 'del', c: inner }
    : run === 1 ? { t: 'em', c: inner }
    : run === 2 ? { t: 'strong', c: inner }
    : { t: 'strong', c: [{ t: 'em', c: inner }] };
  return { node, end: close + run };
}

function closerOf(src: string, from: number, ch: string, n: number): number {
  let j = from;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    // A code span is opaque: the asterisk in `a*b` closes nothing outside it.
    if (c === '`') {
      const run = runOf(src, j, '`');
      const end = closingTicks(src, j + run, run);
      j = end < 0 ? j + run : end + run;
      continue;
    }
    if (c === ch) {
      const run = runOf(src, j, ch);
      const edge = ch !== '_' || !WORD.test(src[j + run] ?? '');
      if (run === n && j > from && !/\s/.test(src[j - 1]!) && edge) return j;
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

/* The DOM: the only part that needs a document. */

/**
 * Replace what `el` shows with `text`, drawn. The box gets the `md` class,
 * which spaces the blocks; its own class keeps the color and the size.
 */
export function renderMarkdown(el: HTMLElement, text: string): void {
  const doc = el.ownerDocument;
  el.classList.add('md');
  el.replaceChildren(...parseMarkdown(text).map((b) => blockNode(doc, b)));
}

function blockNode(doc: Document, b: Block): Node {
  switch (b.t) {
    case 'p':
      return spans(doc.createElement('p'), b.c);
    case 'h': {
      // Under the panel's own title: `#` is the first heading inside it.
      const h = doc.createElement(`h${Math.min(6, b.level + 2)}`);
      return spans(h, b.c);
    }
    case 'code': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.v;
      pre.appendChild(code);
      return pre;
    }
    case 'hr':
      return doc.createElement('hr');
    case 'quote': {
      const q = doc.createElement('blockquote');
      q.append(...b.c.map((c) => blockNode(doc, c)));
      return q;
    }
    case 'list': {
      const list = doc.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) (list as HTMLOListElement).start = b.start;
      for (const item of b.items) {
        const li = doc.createElement('li');
        li.append(...item.map((c) => blockNode(doc, c)));
        list.appendChild(li);
      }
      return list;
    }
    case 'table': {
      const wrap = doc.createElement('div');
      wrap.className = 'md__table';
      const table = doc.createElement('table');
      const row = (cellsOf: Inline[][], tag: 'th' | 'td'): HTMLTableRowElement => {
        const tr = doc.createElement('tr');
        cellsOf.forEach((c, k) => {
          const cell = spans(doc.createElement(tag), c);
          const align = b.align[k];
          if (align) cell.style.textAlign = align;
          tr.appendChild(cell);
        });
        return tr;
      };
      const head = doc.createElement('thead');
      head.appendChild(row(b.head, 'th'));
      const body = doc.createElement('tbody');
      for (const r of b.rows) body.appendChild(row(r, 'td'));
      table.append(head, body);
      wrap.appendChild(table);
      return wrap;
    }
  }
}

function spans<T extends HTMLElement>(el: T, c: Inline[]): T {
  el.append(...c.map((s) => spanNode(el.ownerDocument, s)));
  return el;
}

function spanNode(doc: Document, s: Inline): Node {
  switch (s.t) {
    case 'text':
      return doc.createTextNode(s.v);
    case 'br':
      return doc.createElement('br');
    case 'code': {
      const code = doc.createElement('code');
      code.textContent = s.v;
      return code;
    }
    case 'link': {
      // Words, not a way out: the target is shown on hover and goes nowhere.
      const span = spans(doc.createElement('span'), s.c);
      span.className = 'md__link';
      span.title = s.href;
      return span;
    }
    default:
      return spans(doc.createElement(s.t), s.c);
  }
}
