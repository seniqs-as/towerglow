import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInline, parseMarkdown } from '../src/client/ui/markdown.ts';
import type { Block, Inline } from '../src/client/ui/markdown.ts';

/** What a reader sees of some spans: the words, with the markup as tags. */
function flat(c: Inline[]): string {
  return c.map((s) => {
    switch (s.t) {
      case 'text': return s.v;
      case 'br': return '<br>';
      case 'code': return `<code>${s.v}</code>`;
      case 'link': return `<link ${s.href}>${flat(s.c)}</link>`;
      default: return `<${s.t}>${flat(s.c)}</${s.t}>`;
    }
  }).join('');
}

function only<T extends Block['t']>(blocks: Block[], t: T): Extract<Block, { t: T }> {
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  const b = blocks[0]!;
  assert.equal(b.t, t);
  return b as Extract<Block, { t: T }>;
}

test('bold in an outcome is drawn as bold, and its asterisks are gone', () => {
  const p = only(parseMarkdown('The plan is written. **The starting problem.** Today everything'), 'p');
  assert.equal(flat(p.c), 'The plan is written. <strong>The starting problem.</strong> Today everything');
});

test('a chair minute: heading, a paragraph with code and bold, a numbered list of bold items', () => {
  const text = [
    'I answer with what I have already read.',
    '',
    '## My Dashboard - two serious conflicts',
    '',
    'The `CLAUDE.md` documents two **tested invariants**:',
    '',
    '1. **"Nobody enters the headquarters."** An interior',
    '2. **Codex out of everything**: the 7 tasks',
  ].join('\n');
  const [intro, h, p, list, ...rest] = parseMarkdown(text);
  assert.equal(rest.length, 0);
  assert.equal(intro!.t, 'p');
  assert.deepEqual(h, { t: 'h', level: 2, c: [{ t: 'text', v: 'My Dashboard - two serious conflicts' }] });
  assert.equal(p!.t === 'p' && flat(p.c), 'The <code>CLAUDE.md</code> documents two <strong>tested invariants</strong>:');
  assert.ok(list!.t === 'list' && list.ordered && list.items.length === 2);
  const second = list.items[1]!;
  assert.equal(flat(only(second, 'p').c), '<strong>Codex out of everything</strong>: the 7 tasks');
});

test('a single newline in a paragraph stays a line break, as the pre-wrap box showed it', () => {
  const p = only(parseMarkdown('first line\nsecond line'), 'p');
  assert.equal(flat(p.c), 'first line<br>second line');
});

test('a list right under its caption, with no blank line, is still a list', () => {
  const [p, list] = parseMarkdown('Modified files:\n- `docs/cta_improvement_plan.md` (new)');
  assert.equal(p!.t, 'p');
  assert.ok(list!.t === 'list' && !list.ordered);
  assert.equal(flat(only(list.items[0]!, 'p').c), '<code>docs/cta_improvement_plan.md</code> (new)');
});

test('bullets nested with two spaces stay inside their item', () => {
  const text = '- **Security:** a visitor could overwrite a file.\n  - The report no longer replaces the PDF.\n  - A link cannot delete files.\n- **Login:** fixed';
  const list = only(parseMarkdown(text), 'list');
  assert.equal(list.items.length, 2);
  const [para, sub] = list.items[0]!;
  assert.equal(para!.t, 'p');
  assert.ok(sub!.t === 'list' && sub.items.length === 2);
});

test('a bullet nested under `1. ` with two spaces is nested, not a list of its own', () => {
  const list = only(parseMarkdown('1. first\n  - under it\n2. second'), 'list');
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]![1]!.t, 'list');
});

test('a numbered list keeps the number it starts from', () => {
  const list = only(parseMarkdown('3. third\n4. fourth'), 'list');
  assert.equal(list.start, 3);
});

test('a fenced block is verbatim: the asterisks in it are the code\'s', () => {
  const code = only(parseMarkdown('```sql\nSELECT **x** FROM t;\n```'), 'code');
  assert.deepEqual(code, { t: 'code', lang: 'sql', v: 'SELECT **x** FROM t;' });
});

test('the worker\'s closing block is drawn as code, not as prose', () => {
  const [p, code] = parseMarkdown('Done.\n\n```towerglow\n{"status": "done", "did": "Wrote **it**"}\n```');
  assert.equal(p!.t, 'p');
  assert.deepEqual(code, { t: 'code', lang: 'towerglow', v: '{"status": "done", "did": "Wrote **it**"}' });
});

test('an unclosed fence is still code to the end, not prose with backticks', () => {
  const code = only(parseMarkdown('```\ngit mv a b\ngit mv c d'), 'code');
  assert.equal(code.v, 'git mv a b\ngit mv c d');
});

test('a table from an outcome: header, rows, and code and bold in the cells', () => {
  const text = [
    '| Period | Area | Prevailing nature |',
    '|---|:---:|---:|',
    '| 09-07 (15 commits) | `DB_PREFIX` shared | **feature**, foundational |',
    '| 09-09 | V |',
  ].join('\n');
  const t = only(parseMarkdown(text), 'table');
  assert.deepEqual(t.align, [null, 'center', 'right']);
  assert.deepEqual(t.head.map(flat), ['Period', 'Area', 'Prevailing nature']);
  assert.deepEqual(t.rows[0]!.map(flat), ['09-07 (15 commits)', '<code>DB_PREFIX</code> shared', '<strong>feature</strong>, foundational']);
  // A short row is padded to the columns, not dropped.
  assert.deepEqual(t.rows[1]!.map(flat), ['09-09', 'V', '']);
});

test('an escaped pipe is a pipe inside its cell', () => {
  const t = only(parseMarkdown('| a | b |\n|---|---|\n| x \\| y | z |'), 'table');
  assert.deepEqual(t.rows[0]!.map(flat), ['x | y', 'z']);
});

test('a line of dashes is a rule, and a quote is a quote', () => {
  assert.deepEqual(parseMarkdown('---'), [{ t: 'hr' }]);
  const q = only(parseMarkdown('> quoted **word**'), 'quote');
  assert.equal(flat(only(q.c, 'p').c), 'quoted <strong>word</strong>');
});

test('snake_case names stay whole: an underscore inside a word opens nothing', () => {
  assert.equal(flat(parseInline('read HUMAN_GRACE_MS and job_id_here')), 'read HUMAN_GRACE_MS and job_id_here');
  assert.equal(flat(parseInline('an _emphasis_ here')), 'an <em>emphasis</em> here');
});

test('an asterisk that closes nothing is an asterisk', () => {
  assert.equal(flat(parseInline('2 * 3 * 4')), '2 * 3 * 4');
  assert.equal(flat(parseInline('**half open')), '**half open');
  assert.equal(flat(parseInline('src/**/*.ts')), 'src/**/*.ts');
});

test('emphasis nests, and the `**` inside `*...*` does not close it', () => {
  assert.equal(flat(parseInline('*a **b** c*')), '<em>a <strong>b</strong> c</em>');
  assert.equal(flat(parseInline('***both***')), '<strong><em>both</em></strong>');
  assert.equal(flat(parseInline('~~gone~~')), '<del>gone</del>');
});

test('a code span is opaque: its asterisks neither open nor close', () => {
  assert.equal(flat(parseInline('**bold `a*b` still**')), '<strong>bold <code>a*b</code> still</strong>');
  assert.equal(flat(parseInline('`**not bold**`')), '<code>**not bold**</code>');
});

test('a backslash keeps a character as itself', () => {
  assert.equal(flat(parseInline('\\*not em\\*')), '*not em*');
});

test('a link keeps its words and its target, an image only its words', () => {
  assert.equal(flat(parseInline('see [the plan](docs/plan.md) now')), 'see <link docs/plan.md>the plan</link> now');
  assert.equal(flat(parseInline('![a chart](https://example.com/x.png)')), 'a chart');
  assert.equal(flat(parseInline('- [ ] todo')), '- [ ] todo');
});

test('the renderer never writes markup from a string, and never makes a way out', () => {
  // The text comes from models that read files nobody here chose: every
  // piece of it goes into a text node. No anchors and no images either --
  // a click or a fetch off the loopback is what the client never does.
  const src = readFileSync(new URL('../src/client/ui/markdown.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|DOMParser|createContextualFragment/);
  assert.doesNotMatch(src, /createElement\(\s*'(a|img|iframe|script|link|style)'/);
});
