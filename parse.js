// parse.js — a fast Markdown-to-HTML renderer that produces, for every input,
// exactly the HTML that marked 18.1.3 produces with its default options
// (gfm: true, breaks: false, pedantic: false).
//
// The behaviour contract is marked's: where marked departs from the CommonMark
// or GFM specs, this module departs in the same places, byte for byte. The
// implementation is an independent re-implementation of the same two-phase
// architecture (block lexing, then inline lexing, then rendering), written
// around index-based scanning and first-character dispatch so the hot loops
// avoid the repeated anchored-regex attempts that dominate marked's runtime
// on long documents.
//
// marked is MIT-licensed (see LICENSE and NOTICE in this repository); the
// trickiest pattern definitions (emphasis delimiter matching, the GFM text
// run, table and paragraph interruption patterns) are composed from pattern
// fragments in the same way marked composes them, and are credited there.

// ---------------------------------------------------------------------------
// Small regex-composition helper: builds a RegExp from a pattern string by
// substituting named fragments with other patterns (dropping a leading ^
// from a fragment when it is embedded, so anchored fragments can be reused
// mid-pattern).
// ---------------------------------------------------------------------------
function edit(pattern, flags = '') {
  let source = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    replace(name, replacement) {
      let rep = typeof replacement === 'string' ? replacement : replacement.source;
      rep = rep.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, rep);
      return api;
    },
    getRegex() {
      return new RegExp(source, flags);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Shared "other" patterns (character classes and small utilities).
// ---------------------------------------------------------------------------
const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  tabCharGlobal: /\t/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeReplacer(ch) {
  return escapeReplacements[ch];
}

/** Escape HTML. With `encode`, every & is escaped; without, an & that
 *  already begins a character reference is left alone. */
export function escapeHtml(text, encode) {
  if (encode) {
    if (other.escapeTest.test(text)) return text.replace(other.escapeReplace, escapeReplacer);
  } else if (other.escapeTestNoEncode.test(text)) {
    return text.replace(other.escapeReplaceNoEncode, escapeReplacer);
  }
  return text;
}

/** Resolve numeric character references the way marked's text pass does:
 *  valid references become their code point (NUL, out-of-range and surrogate
 *  values become U+FFFD, and &#38; stays an escaped ampersand); a bare &
 *  that does not start a reference is escaped, but only when the string
 *  contains a numeric reference at all. */
function resolveCharRefs(text) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** marked's cleanUrl: encodeURI, undoing the %25 doubling, null on error. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
}

/** Split a table row into cells, honouring \| escapes and code spans are
 *  not special here; a pipe preceded by an odd number of backslashes stays. */
function splitCells(row, cellCount) {
  const replaced = row.replace(other.findPipe, (match, offset, full) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && full[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(other.splitPipe);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (cellCount !== undefined) {
    if (cells.length > cellCount) cells.splice(cellCount);
    else while (cells.length < cellCount) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

/** Remove trailing copies of `ch` (used for raw trimming and for counting
 *  trailing backslashes). */
function trimTrailing(str, ch) {
  let end = str.length;
  if (end === 0) return '';
  let count = 0;
  while (count < end) {
    if (str.charAt(end - count - 1) === ch) count++;
    else break;
  }
  return str.slice(0, end - count);
}

/** Drop trailing blank lines the way marked does for indented code and
 *  HTML blocks: if the text ends with more than one blank line, cut back
 *  to the last non-blank line. */
function trimBlankLines(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && other.blankLine.test(lines[last])) last--;
  if (lines.length - last <= 2) return text;
  return lines.slice(0, last + 1).join('\n');
}

/** Normalise a link label into its lookup key. */
function linkLabelKey(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Find the closing bracket/paren matching the opener inside `text`,
 *  skipping escaped characters. Returns the index of the extra closer,
 *  -2 when openers remain unclosed, or -1 when balanced or absent. */
function findClosing(text, pair) {
  if (text.indexOf(pair[0]) === -1 && text.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs to spaces, tracking the column so a tab advances to the
 *  next multiple-of-4 boundary relative to `startColumn`. */
function expandTabs(text, startColumn = 0) {
  let col = startColumn;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis masking. Before inline lexing, marked builds a length-preserving
// "masked" shadow of the source in which link destinations, code spans,
// HTML and escaped punctuation are neutralised, then records, for each of
// '*', '_' and '~', the last position where a closing delimiter run could
// start. The emphasis tokenisers consult that shadow so a closer that sits
// inside a code span or a link destination is never used.
// ---------------------------------------------------------------------------
function scanDelims(maskedSrc) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = maskedSrc.length;
  for (let s = 0; s < n; s++) {
    const ch = maskedSrc[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = s === 0 ? '\n' : maskedSrc[s - 1];
    let i = s + 1;
    while (i < n && maskedSrc[i] === ch) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEm[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc, lastEm, lastDel };
}

function lastEmCloser(ctx, masked, ch) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  if (top && top.maskedSrc === masked) {
    if (top.lastEm === null) {
      const scan = scanDelims(top.maskedSrc);
      top.lastEm = scan.lastEm;
      top.lastDel = scan.lastDel;
    }
    return top.lastEm[ch];
  }
  return scanDelims(masked).lastEm[ch];
}

function lastDelCloser(ctx, masked) {
  const top = ctx.maskStack[ctx.maskStack.length - 1];
  if (top && top.maskedSrc === masked) {
    if (top.lastEm === null) {
      const scan = scanDelims(top.maskedSrc);
      top.lastEm = scan.lastEm;
      top.lastDel = scan.lastDel;
    }
    return top.lastDel;
  }
  return scanDelims(masked).lastDel;
}

// ---------------------------------------------------------------------------
// Block-level patterns (GFM rule set).
// ---------------------------------------------------------------------------
const blockTags =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const commentPattern = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const blockHtmlRe = edit(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .replace('comment', commentPattern)
  .replace('tag', blockTags)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const blockDefLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const blockDefRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockDefLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const setextBase = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const bulletFragment = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const blockLheadingRe = edit(setextBase)
  .replace(/bull/g, bulletFragment)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const paragraphBase = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockTableRe = edit(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .replace('hr', /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', blockTags)
  .getRegex();

// The paragraph pattern above needs the real table pattern in place of the
// placeholder; rebuild it now that blockTableRe exists, in the same slot
// marked substitutes its table rule.
const blockParagraphFullRe = edit(paragraphBase)
  .replace('hr', /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', blockTableRe)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', blockTags)
  .getRegex();

const blockquoteParagraphRe = edit(paragraphBase)
  .replace('hr', /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', blockTags)
  .getRegex();

const blockBlockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraphRe)
  .getRegex();

const blockRules = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: blockBlockquoteRe,
  list: /^ {0,3}([*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/,
  html: blockHtmlRe,
  def: blockDefRe,
  lheading: blockLheadingRe,
  paragraph: blockParagraphFullRe,
  table: blockTableRe,
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline-level patterns (GFM rule set).
// ---------------------------------------------------------------------------
const punctClass = /[\p{P}\p{S}]/u;
const punctNoTilde = /(?!~)[\p{P}\p{S}]/u;
const punctSpaceClass = /[\s\p{P}\p{S}]/u;
const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctSpaceClass = /[^\s\p{P}\p{S}]/u;
const notPunctSpaceOrTilde = /(?:[^\s\p{P}\p{S}]|~)/u;

// The label of a link: bracket-balanced text that may contain escaped
// brackets and code spans.
const linkLabelPattern = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const linkRefPattern = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

const inlineRules = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: edit(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  )
    .replace('comment', /^<!--(?:-?>|[\s\S]*?-->)/)
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .getRegex(),
  link: edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', linkLabelPattern)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .getRegex(),
  reflink: edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', linkLabelPattern)
    .replace('ref', linkRefPattern)
    .getRegex(),
  nolink: edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', linkRefPattern)
    .getRegex(),
  emStrongLDelim: edit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
    .replace(/punct/g, punctNoTilde)
    .getRegex(),
  emStrongRDelimAst: edit(
    "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
    'gu',
  )
    .replace(/notPunctSpace/g, notPunctSpaceOrTilde)
    .replace(/punctSpace/g, punctSpaceNoTilde)
    .replace(/punct/g, punctNoTilde)
    .getRegex(),
  emStrongRDelimUnd: edit(
    "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
    'gu',
  )
    .replace(/notPunctSpace/g, notPunctSpaceClass)
    .replace(/punctSpace/g, punctSpaceClass)
    .replace(/punct/g, punctClass)
    .getRegex(),
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  delLDelim: edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
    .replace(/punct/g, punctClass)
    .getRegex(),
  delRDelim: edit(
    "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
    'gu',
  )
    .replace(/notPunctSpace/g, notPunctSpaceClass)
    .replace(/punctSpace/g, punctSpaceClass)
    .replace(/punct/g, punctClass)
    .getRegex(),
  autolink: edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace(
      'email',
      /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
    )
    .getRegex(),
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: edit(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  )
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
    .getRegex(),
  punctuation: edit(/^((?![*_])punctSpace)/, 'u')
    .replace(/punctSpace/g, punctSpaceClass)
    .getRegex(),
  anyPunctuation: edit(/\\(punct)/, 'gu')
    .replace(/punct/g, punctClass)
    .getRegex(),
  anyPunctuationOutsideCode: edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
    .replace(/punct/g, punctClass)
    .getRegex(),
  blockSkip: edit('link|precode-code|html', 'g')
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('precode-', '(?<!`)()')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .getRegex(),
  reflinkSearch: edit('reflink|nolink(?!\\()', 'g')
    .replace(
      'reflink',
      edit(/^!?\[(label)\]\[(ref)\]/)
        .replace('label', /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
        .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/)
        .getRegex(),
    )
    .replace(
      'nolink',
      edit(/^!?\[(ref)\](?:\[\])?/)
        .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/)
        .getRegex(),
    )
    .getRegex(),
};

// ---------------------------------------------------------------------------
// Masking: build the length-preserving shadow described above. Code spans,
// inline links and HTML tags collapse to bracketed runs of 'a'; reflink
// labels that resolve collapse the same way; escaped punctuation outside
// code becomes '+'. Only the emphasis scan reads the shadow.
// ---------------------------------------------------------------------------
function maskReflink(match, ctx) {
  const open = match.lastIndexOf('[');
  if (!Object.hasOwn(ctx.links, linkLabelKey(match.slice(open + 1, -1)))) return match;
  if (open > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, open - 1);
    if (linkInText(ctx, inner)) {
      return '[' + inner.replace(inlineRules.reflinkSearch, (m) => maskReflink(m, ctx)) + '][' + 'a'.repeat(match.length - open - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

function maskText(ctx, src) {
  // Each replacement below is the identity when its trigger characters
  // are absent (or, for reflinks, when no link definitions exist), so
  // those passes are skipped outright.
  let masked = src;
  if (ctx.linkCount > 0 && src.includes('[')) {
    masked = masked.replace(inlineRules.reflinkSearch, (match) => maskReflink(match, ctx));
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(inlineRules.anyPunctuationOutsideCode, (match, codeRun, escaped) =>
      escaped
        ? '+'.repeat(match.length)
        : codeRun
          ? codeRun + match.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun
          : match,
    );
  }
  if (src.includes('`') || src.includes('[') || src.includes('<')) {
    masked = masked.replace(inlineRules.blockSkip, (match, _labelCode, precode) => {
      const skip = precode ? precode.length : 0;
      return match.slice(0, skip) + '[' + 'a'.repeat(match.length - skip - 2) + ']';
    });
  }
  return masked;
}

/** Does `text` contain a working inline link or a resolvable reflink?
 *  Used by the masker to decide how much of a reflink to neutralise. */
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(inlineRules.blockSkip)) {
    if (inlineRules.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(inlineRules.reflinkSearch)) {
    const found = match[0];
    const open = found.lastIndexOf('[');
    if (
      !(found.charAt(0) === '!' || !Object.hasOwn(ctx.links, linkLabelKey(found.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(ctx, found.slice(1, open - 1)))
    ) {
      return true;
    }
  }
  return false;
}

/** A link label is unusable when an HTML tag or autolink that starts
 *  inside it runs past the label's end. */
function labelRunsPast(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = inlineRules.code.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelStart + s);
    const tag = inlineRules.tag.exec(rest) || inlineRules.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Block tokenisers. Each inspects the remaining source and returns a token
// or undefined. Inline content is not lexed here; it is queued on
// ctx.inlineQueue (via queueInline) and resolved after the block pass, so
// link reference definitions anywhere in the document are known first.
// ---------------------------------------------------------------------------
function queueInline(ctx, src) {
  const tokens = [];
  ctx.inlineQueue.push({ src, tokens });
  return tokens;
}

function spaceToken(ctx, src) {
  const cap = blockRules.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function indentedCodeToken(ctx, src) {
  const cap = blockRules.code.exec(src);
  if (cap) {
    const raw = trimBlankLines(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(other.codeRemoveIndent, '') };
  }
}

/** For a fenced block whose opening line is itself indented with backtick
 *  fences, marked compensates the content lines by that indent. */
function fenceText(raw, text) {
  const indentMatch = raw.match(other.indentCodeCompensation);
  if (indentMatch === null) return text;
  const indent = indentMatch[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(other.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

function fencesToken(ctx, src) {
  const cap = blockRules.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(inlineRules.anyPunctuation, '$1') : cap[2],
      text: fenceText(raw, cap[3] || ''),
    };
  }
}

function headingToken(ctx, src) {
  const cap = blockRules.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const trimmed = trimTrailing(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: trimTrailing(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(ctx, text) };
  }
}

function hrToken(ctx, src) {
  const cap = blockRules.hr.exec(src);
  if (cap) return { type: 'hr', raw: trimTrailing(cap[0], '\n') };
}

function blockquoteToken(ctx, src) {
  const cap = blockRules.blockquote.exec(src);
  if (!cap) return;
  let lines = trimTrailing(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (other.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkRaw = chunk.join('\n');
    const chunkText = chunkRaw
      .replace(other.blockquoteMarkerWhitespace, (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
    text = text ? text + '\n' + chunkText : chunkText;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    blockTokens(ctx, chunkText, tokens, true);
    ctx.state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const merged = last.raw + '\n' + lines.join('\n').replace(other.blockquoteSetextReplace2, '');
      const replacement = blockquoteToken(ctx, merged);
      tokens[tokens.length - 1] = replacement;
      const rest = merged.substring(replacement.raw.length).replace(/^\n/, '');
      const restLines = rest ? rest.split('\n').length : 0;
      const consumed = restLines ? lines.slice(0, -restLines) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + replacement.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const replacement = listToken(ctx, combined);
      tokens[tokens.length - 1] = replacement;
      const extraLines =
        replacement.raw.length > last.raw.length
          ? combined.slice(last.raw.length + 1, replacement.raw.length).split('\n').length
          : 0;
      if (extraLines > 0) {
        const consumedText = lines.slice(0, extraLines).join('\n');
        raw = raw + '\n' + consumedText;
        text = text + '\n' + consumedText;
      }
      lines = lines.slice(extraLines);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// "Begin" probes used inside list items, parameterised by an indent that
// marked clamps to 0..3 (indent - 1). Only four variants exist; cache them.
const beginProbeCache = [];
function beginProbes(indent) {
  const key = Math.max(0, Math.min(3, indent - 1));
  let probes = beginProbeCache[key];
  if (!probes) {
    probes = {
      k: key,
      nextBullet: new RegExp(`^ {0,${key}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
      hr: new RegExp(`^ {0,${key}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
      fences: new RegExp(`^ {0,${key}}(?:\`\`\`|~~~)`),
      heading: new RegExp(`^ {0,${key}}#{1,6}(?:\\s|$)`),
      html: new RegExp(
        `^ {0,${key}}(?:</?(?:${blockTags})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
      blockquote: new RegExp(`^ {0,${key}}>`),
    };
    beginProbeCache[key] = probes;
  }
  return probes;
}

/** Could any begin probe match this line? Every probe allows up to k
 *  leading spaces followed by one specific construct character, so the
 *  first non-space character decides which single probe is worth
 *  running. */
function probeHit(probes, line) {
  let s = 0;
  while (line[s] === ' ') s++;
  if (s > probes.k) return false;
  const ch = line[s];
  if (ch === '`' || ch === '~') return probes.fences.test(line);
  if (ch === '#') return probes.heading.test(line);
  if (ch === '>') return probes.blockquote.test(line);
  if (ch === '<') return probes.html.test(line);
  if (ch === '-' || ch === '*') return probes.hr.test(line) || probes.nextBullet.test(line);
  if (ch === '_') return probes.hr.test(line);
  if (ch === '+' || (ch >= '0' && ch <= '9')) return probes.nextBullet.test(line);
  return false;
}

/** The lazy-continuation check tests only the fences, heading, html and
 *  hr probes against the previous line. */
function probeHitLazy(probes, line) {
  let s = 0;
  while (line[s] === ' ') s++;
  if (s > probes.k) return false;
  const ch = line[s];
  if (ch === '`' || ch === '~') return probes.fences.test(line);
  if (ch === '#') return probes.heading.test(line);
  if (ch === '<') return probes.html.test(line);
  if (ch === '-' || ch === '*' || ch === '_') return probes.hr.test(line);
  return false;
}

/** Index of the first character that is not a space (tabs count as
 *  non-spaces, matching a [^ ] search), or -1. */
function firstNonSpace(text) {
  for (let i = 0; i < text.length; i++) if (text[i] !== ' ') return i;
  return -1;
}

/** Width of the leading whitespace of `text` when each tab counts as 4
 *  spaces (a plain tab-to-4-spaces expansion), or -1 when the line is
 *  all whitespace. */
function leadingWidth4(text) {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') width += 1;
    else if (text[i] === '\t') width += 4;
    else return width;
  }
  return -1;
}

/** Expand the leading tabs of a line (only the leading run is touched).
 *  A leading run without a tab expands to itself, so it is returned as
 *  is — the common case for space-indented lists. */
function expandLeadingTabs(line, baseColumn) {
  const first = line.charCodeAt(0);
  if (first !== 32 && first !== 9) return line;
  let hasTab = first === 9;
  for (let j = 1; (line[j] === ' ' || line[j] === '\t') && !hasTab; j++) {
    if (line[j] === '\t') hasTab = true;
  }
  if (!hasTab) return line;
  return line.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, baseColumn));
}

function listToken(ctx, src) {
  const firstCap = blockRules.list.exec(src);
  if (!firstCap) return;
  const fullSrc = src;
  const srcLen = src.length;
  let pos = 0;
  const bullet = firstCap[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = new RegExp(`( {0,3}${bulletPattern})((?:[\t ][^\\n]*)?(?:\\n|$))`, 'y');
  const hrTestRe = new RegExp(blockRules.hr.source.slice(1), 'y');
  let prevItemLoose = false;

  while (pos < srcLen) {
    let itemHasBlankLine = false;
    let itemText = '';
    itemRe.lastIndex = pos;
    const cap = itemRe.exec(fullSrc);
    hrTestRe.lastIndex = pos;
    if (!cap || hrTestRe.test(fullSrc)) break;
    const itemStart = pos;
    pos += cap[0].length;
    const firstLine = cap[2].endsWith('\n') ? cap[2].slice(0, -1) : cap[2];
    const bulletWidth = cap[1].length;
    const lineContent = expandLeadingTabs(firstLine, bulletWidth);
    let blankContent = !lineContent.trim();
    let indent = 0;
    if (blankContent) {
      indent = bulletWidth + 1;
    } else {
      indent = firstNonSpace(lineContent);
      if (indent > 4) indent = 1;
      itemText = lineContent.slice(indent);
      indent += bulletWidth;
    }
    if (blankContent) {
      const nl = fullSrc.indexOf('\n', pos);
      const nextLine = nl === -1 ? fullSrc.slice(pos) : fullSrc.slice(pos, nl);
      if (other.blankLine.test(nextLine)) {
        pos = nl === -1 ? srcLen : nl + 1;
        itemHasBlankLine = true;
      }
    }
    if (!itemHasBlankLine) {
      const probes = beginProbes(indent);
      let currentLine = lineContent;
      while (pos < srcLen) {
        const nl = fullSrc.indexOf('\n', pos);
        const lineEnd = nl === -1 ? srcLen : nl;
        const rawLine = fullSrc.slice(pos, lineEnd);
        const expanded = expandLeadingTabs(rawLine, 0);
        if (probeHit(probes, rawLine)) break;
        if (firstNonSpace(expanded) >= indent || !rawLine.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            blankContent ||
            leadingWidth4(currentLine) >= 4 ||
            probeHitLazy(probes, currentLine)
          ) {
            break;
          }
          const lazyLine =
            /^ {0,3}(?:=+|-+) *$/.test(rawLine) && blockRules.lheading.test(currentLine + '\n' + rawLine)
              ? '    ' + rawLine.replace(/^ {0,3}/, '')
              : rawLine;
          itemText += '\n' + lazyLine;
        }
        blankContent = !rawLine.trim();
        pos = lineEnd + 1;
        currentLine = expanded.slice(indent);
      }
    }
    const itemRaw = fullSrc.slice(itemStart, pos);
    if (!list.loose) {
      if (prevItemLoose) list.loose = true;
      else if (other.doubleBlankLine.test(itemRaw)) prevItemLoose = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: other.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = fullSrc.slice(0, pos).trimEnd();

  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = blockTokens(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw));
    }
  }

  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      first.raw = first.raw.replace(other.listReplaceTask, '');
      first.text = first.text.replace(other.listReplaceTask, '');
      for (let g = ctx.inlineQueue.length - 1; g >= 0; g--) {
        if (other.listIsTask.test(ctx.inlineQueue[g].src)) {
          ctx.inlineQueue[g].src = ctx.inlineQueue[g].src.replace(other.listReplaceTask, '');
          break;
        }
      }
      const checkboxMatch = other.listTaskCheckbox.exec(item.raw);
      if (checkboxMatch) {
        const checkbox = { type: 'checkbox', raw: checkboxMatch[0] + ' ', checked: checkboxMatch[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function htmlBlockToken(ctx, src) {
  const cap = blockRules.html.exec(src);
  if (cap) {
    const raw = trimBlankLines(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}

function defToken(ctx, src) {
  const cap = blockRules.def.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosing(cap[2], '()') !== -1) return;
    return {
      type: 'def',
      tag: linkLabelKey(cap[1]),
      raw: trimTrailing(cap[0], '\n'),
      href: cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inlineRules.anyPunctuation, '$1') : '',
      title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inlineRules.anyPunctuation, '$1') : cap[3],
    };
  }
}

const tableDelimiterLineRe = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

/** A table match needs its second line to be a delimiter row; blocks
 *  whose second line is anything else skip the full table pattern. */
function hasTableDelimiter(src) {
  const firstEnd = src.indexOf('\n');
  if (firstEnd === -1) return false;
  const secondStart = firstEnd + 1;
  let secondEnd = src.indexOf('\n', secondStart);
  if (secondEnd === -1) secondEnd = src.length;
  if (secondEnd === secondStart) return false;
  return tableDelimiterLineRe.test(src.slice(secondStart, secondEnd));
}

function tableToken(ctx, src) {
  if (!hasTableDelimiter(src)) return;
  const cap = blockRules.table.exec(src);
  if (!cap || !other.tableDelimiter.test(cap[2])) return;
  const headerCells = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rowLines = cap[3] && cap[3].trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return;
  const table = { type: 'table', raw: trimTrailing(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of aligns) {
    table.align.push(
      other.tableAlignRight.test(cell) ? 'right' : other.tableAlignCenter.test(cell) ? 'center' : other.tableAlignLeft.test(cell) ? 'left' : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(ctx, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowLine of rowLines) {
    table.rows.push(
      splitCells(rowLine, headerCells.length).map((cell, i) => ({
        text: cell,
        tokens: queueInline(ctx, cell),
        header: false,
        align: table.align[i],
      })),
    );
  }
  return table;
}

/** A setext underline line: up to 3 leading spaces, a run of = or -,
 *  then only spaces/tabs. A lheading match needs one as its second or
 *  later line, so blocks without one skip the (expensive) pattern. One
 *  compiled search does the whole scan. */
const setextUnderlineRe = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/;
function hasSetextUnderline(src) {
  return setextUnderlineRe.test(src);
}

function lheadingToken(ctx, src) {
  if (!hasSetextUnderline(src)) return;
  const cap = blockRules.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: trimTrailing(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(ctx, text) };
  }
}

function paragraphToken(ctx, src) {
  const cap = blockRules.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(ctx, text) };
  }
}

function blockTextToken(ctx, src) {
  const cap = blockRules.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(ctx, cap[0]) };
}

// ---------------------------------------------------------------------------
// The block pass. Mirrors marked's driver, including its token merges: a
// run of blank lines collapses into the previous token's raw, indented code
// and link definitions that directly follow a paragraph are folded into it,
// and inside a blockquote consecutive paragraphs merge.
// ---------------------------------------------------------------------------
function blockTokens(ctx, src, tokens, nested) {
  let lastLength = Infinity;
  while (src) {
    if (src.length < lastLength) lastLength = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));

    let token;
    if ((token = spaceToken(ctx, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (token.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(token);
      continue;
    }
    // First-significant-character dispatch: every block pattern below
    // allows at most 3 leading spaces before one specific character, so
    // blocks starting with anything else skip straight past them.
    let lead = 0;
    while (src[lead] === ' ') lead++;
    const fc = src[lead];
    if (lead >= 4 || fc === '\t') {
      if ((token = indentedCodeToken(ctx, src))) {
        src = src.substring(token.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
          last.text += '\n' + token.text;
          ctx.inlineQueue[ctx.inlineQueue.length - 1].src = last.text;
        } else tokens.push(token);
        continue;
      }
    } else {
      if ((fc === '`' || fc === '~') && (token = fencesToken(ctx, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (fc === '#' && (token = headingToken(ctx, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((fc === '-' || fc === '_' || fc === '*') && (token = hrToken(ctx, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (fc === '>' && (token = blockquoteToken(ctx, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (
        (fc === '-' || fc === '+' || fc === '*' || (fc >= '0' && fc <= '9')) &&
        (token = listToken(ctx, src))
      ) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (fc === '<' && (token = htmlBlockToken(ctx, src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (fc === '[' && (token = defToken(ctx, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
        ctx.inlineQueue[ctx.inlineQueue.length - 1].src = last.text;
      } else {
        if (!ctx.links[token.tag]) {
          ctx.links[token.tag] = { href: token.href, title: token.title };
          ctx.linkCount++;
        }
          tokens.push(token);
        }
        continue;
      }
    }
    if ((token = tableToken(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = lheadingToken(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (ctx.state.top && (token = paragraphToken(ctx, src))) {
      const last = tokens[tokens.length - 1];
      if (nested && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue[ctx.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      src = src.substring(token.raw.length);
      continue;
    }
    if ((token = blockTextToken(ctx, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue[ctx.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenisers.
// ---------------------------------------------------------------------------
function escapeToken(ctx, src) {
  const cap = inlineRules.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tagToken(ctx, src) {
  const cap = inlineRules.tag.exec(src);
  if (cap) {
    if (!ctx.state.inLink && other.startATag.test(cap[0])) ctx.state.inLink = true;
    else if (ctx.state.inLink && other.endATag.test(cap[0])) ctx.state.inLink = false;
    if (!ctx.state.inRawBlock && other.startPreScriptTag.test(cap[0])) ctx.state.inRawBlock = true;
    else if (ctx.state.inRawBlock && other.endPreScriptTag.test(cap[0])) ctx.state.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: ctx.state.inLink, inRawBlock: ctx.state.inRawBlock, block: false, text: cap[0] };
  }
}

function createLinkToken(ctx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const label = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const tokens = inlineTokens(ctx, label, []);
  const emitted = ctx.state.linkEmitted;
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    ctx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text: label, tokens };
}

function linkToken(ctx, src) {
  if (ctx.state.linkParenPossible === false) return;
  // An inline link needs a literal "](" somewhere ahead.
  if (!src.includes('](')) return;
  const cap = inlineRules.link.exec(src);
  if (!cap) return;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelRunsPast(src, cap[1], labelStart)) return;
  let href = cap[2].trim();
  if (other.startAngleBracket.test(href)) {
    if (!other.endAngleBracket.test(href)) return;
    const unescaped = trimTrailing(href.slice(0, -1), '\\');
    if ((href.length - unescaped.length) % 2 === 0) return;
  } else {
    const closing = findClosing(cap[2], '()');
    if (closing === -2) return;
    if (closing > -1) {
      const cut = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + closing;
      cap[2] = cap[2].substring(0, closing);
      cap[0] = cap[0].substring(0, cut).trim();
      cap[3] = '';
    }
  }
  const backslashes = trimTrailing(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - backslashes.length) % 2 === 0) return;
  let dest = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';
  dest = dest.trim();
  if (other.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return createLinkToken(ctx, cap, {
    href: dest ? dest.replace(inlineRules.anyPunctuation, '$1') : dest,
    title: title ? title.replace(inlineRules.anyPunctuation, '$1') : title,
  }, cap[0]);
}

function reflinkToken(ctx, src) {
  // Both the reflink and nolink patterns need a ']' somewhere ahead.
  if (!src.includes(']')) return;
  let cap = inlineRules.reflink.exec(src) || inlineRules.nolink.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelRunsPast(src, cap[1], labelStart)) return;
    const link = ctx.links[linkLabelKey(cap[2] || cap[1])];
    if (!link) {
      const firstChar = cap[0].charAt(0);
      return { type: 'text', raw: firstChar, text: firstChar };
    }
    return createLinkToken(ctx, cap, link, cap[0]);
  }
}

function emStrongToken(ctx, src, fullSrc, prevChar) {
  let cap = inlineRules.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return;
  const delim = cap[0][0];
  const sameChar = prevChar === delim;
  const pos = fullSrc.length - src.length;
  let runStart = pos;
  while (runStart > 0 && fullSrc[runStart - 1] === delim) runStart--;
  const beforeRun = [...fullSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelimOrPunct = beforeRun === '*' || beforeRun === '_' || !!inlineRules.punctuation.exec(beforeRun);
  if (runStart < pos) prevChar = beforeRun;
  const cannotOpen = runStart < pos ? beforeIsDelimOrPunct : !!inlineRules.punctuation.exec(prevChar);
  if (cap[4] && prevChar.match(other.unicodeAlphaNumeric)) return;
  const punctAfter = cap[1] || cap[3] || '';
  if (!punctAfter || !prevChar || cannotOpen) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    let surplus = 0;
    const runLength = pos - runStart + openerLen;
    const closerCanPunct = !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
    if (delim !== '*' && delim !== '_') return;
    const rDelim = delim === '*' ? inlineRules.emStrongRDelimAst : inlineRules.emStrongRDelimUnd;
    const lastPossible = lastEmCloser(ctx, fullSrc, delim);
    const openerEnd = fullSrc.length - src.length + openerLen;
    if (lastPossible < openerEnd) return;
    const masked = fullSrc.slice(fullSrc.length - src.length + openerLen);
    const limit = lastPossible - openerEnd;
    rDelim.lastIndex = 0;
    let match;
    while ((match = rDelim.exec(masked)) !== null && !(match.index > limit)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (match[3] || match[4]) {
        remaining += runLen;
        continue;
      }
      if (match[5] || match[6] || closerCanPunct) {
        if (sameChar && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + runLen) % 3)) {
          surplus += runLen;
          continue;
        }
      }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining + surplus);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + runLen);
      if (Math.min(openerLen, runLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(ctx, text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
}

function codespanToken(ctx, src) {
  const cap = inlineRules.code.exec(src);
  if (cap) {
    let text = cap[2].replace(/\n/g, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const padded = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function brToken(ctx, src) {
  const cap = inlineRules.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function delToken(ctx, src, fullSrc, prevChar) {
  let cap = inlineRules.delLDelim.exec(src);
  if (!cap) return;
  if (!(cap[1] || '') || !prevChar || inlineRules.punctuation.exec(prevChar)) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    const rDelim = inlineRules.delRDelim;
    const lastPossible = lastDelCloser(ctx, fullSrc);
    const openerEnd = fullSrc.length - src.length + openerLen;
    if (lastPossible < openerEnd) return;
    const masked = fullSrc.slice(fullSrc.length - src.length + openerLen);
    const limit = lastPossible - openerEnd;
    rDelim.lastIndex = 0;
    let match;
    while ((match = rDelim.exec(masked)) !== null && !(match.index > limit)) {
      const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (runLen !== openerLen) continue;
      if (match[3] || match[4]) {
        remaining += runLen;
        continue;
      }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining);
      const firstCharLen = [...match[0]][0].length;
      const raw = src.slice(0, openerLen + match.index + firstCharLen + runLen);
      const text = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
}

function autolinkToken(ctx, src) {
  const cap = inlineRules.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return { type: 'link', raw: cap[0], text, href, tokens: [{ type: 'text', raw: text, text }], autolink: true };
  }
}

function urlToken(ctx, src) {
  const cap = inlineRules.url.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = cap[0];
        cap[0] = inlineRules.backpedal.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, tokens: [{ type: 'text', raw: text, text }], autolink: true };
  }
}

function inlineTextToken(ctx, src) {
  const cap = inlineRules.text.exec(src);
  if (cap) {
    const inRaw = ctx.state.inRawBlock;
    return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : resolveCharRefs(cap[0]), escaped: inRaw };
  }
}

// ---------------------------------------------------------------------------
// A hand scanner for the GFM text run, computing exactly the extent the
// inline text pattern matches: a leading run of backticks/tildes or one
// ordinary character, then lazy growth until a position where a link,
// emphasis, autolink, hard break or e-mail could start. The pattern's
// per-position lookaheads (an e-mail local part scan at every character)
// are what make the regex slow on long plain text; here the same stop
// conditions are checked with direct character tests.
// ---------------------------------------------------------------------------
// Lookup table for the e-mail local-part character set (all ASCII).
const emailLocalTable = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-") {
  emailLocalTable[ch.charCodeAt(0)] = 1;
}
// Characters at which a text run always stops (the pattern's first
// lookahead set): \ < ! [ ` * ~ _
const textStopTable = new Uint8Array(128);
for (const code of [92, 60, 33, 91, 96, 42, 126, 95]) textStopTable[code] = 1;

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function startsMailtoOrXmpp(src, at) {
  return src.startsWith('mailto:', at) || src.startsWith('xmpp:', at);
}

/** At `at`, is there an e-mail local part (1+ local chars) followed by @? */
function emailAhead(src, at) {
  let j = at;
  while (j < src.length) {
    const code = src.charCodeAt(j);
    if (code > 127 || emailLocalTable[code] === 0) break;
    j++;
  }
  return j > at && src[j] === '@';
}

/** At `at`, do two or more spaces end the line? */
function hardBreakAhead(src, at) {
  let j = at;
  while (src[j] === ' ') j++;
  return j - at >= 2 && src[j] === '\n';
}

/** At `at`, does an http/https/ftp URL start (any letter case)? Written
 *  with direct character comparisons; no substring is allocated. */
function protocolAhead(src, at) {
  const c = src.charCodeAt(at);
  if (c === 102 || c === 70) {
    // f
    return (
      (src[at + 1] === 't' || src[at + 1] === 'T') &&
      (src[at + 2] === 'p' || src[at + 2] === 'P') &&
      src[at + 3] === ':' && src[at + 4] === '/' && src[at + 5] === '/'
    );
  }
  if (c === 104 || c === 72) {
    // h
    if (
      !((src[at + 1] === 't' || src[at + 1] === 'T') &&
        (src[at + 2] === 't' || src[at + 2] === 'T') &&
        (src[at + 3] === 'p' || src[at + 3] === 'P'))
    ) {
      return false;
    }
    if (src[at + 4] === ':' && src[at + 5] === '/' && src[at + 6] === '/') return true;
    return (
      (src[at + 4] === 's' || src[at + 4] === 'S') &&
      src[at + 5] === ':' && src[at + 6] === '/' && src[at + 7] === '/'
    );
  }
  return false;
}

function textRunLength(src) {
  const n = src.length;
  // First alternative: one non-alphanumeric character directly before a
  // mailto:/xmpp: address is a text run of its own.
  if (!isAlnumCode(src.charCodeAt(0)) && startsMailtoOrXmpp(src, 1)) return 1;

  // The opening group: a backtick or tilde run, or any single character.
  let i = 1;
  const first = src[0];
  if (first === '`' || first === '~') {
    while (i < n && src[i] === first) i++;
  }

  // Zero-width stops right after the opening group.
  if (src[i] === '`' || src[i] === '~') return i;
  if (hardBreakAhead(src, i)) return i;
  if (emailAhead(src, i)) return i;

  // Lazy growth, event-driven: between candidate positions no stop
  // condition can fire, so the scan jumps from one candidate to the
  // next. Candidates are: a stop-set character or 'w' (found with a
  // compiled search), a protocol scheme (found via its '://'), a www.
  // address, the character before a mailto:/xmpp: address, the
  // character before an e-mail local part that reaches '@', and the
  // character before a run of 2+ spaces that ends the line. At each
  // candidate the conditions are checked in the pattern's order.
  let p = i;
  for (;;) {
    let q = n;
    stopSearchRe.lastIndex = p;
    const stopMatch = stopSearchRe.exec(src);
    if (stopMatch) q = stopMatch.index;
    for (let idx = src.indexOf('://', p + 3); idx !== -1; idx = src.indexOf('://', idx + 1)) {
      if (idx - 5 >= q) break;
      for (const s of [idx - 5, idx - 4, idx - 3]) {
        if (s >= p && protocolAhead(src, s)) {
          if (s < q) q = s;
          break;
        }
      }
    }
    const wwwIdx = src.indexOf('www.', p);
    if (wwwIdx !== -1 && wwwIdx < q) q = wwwIdx;
    for (let idx = src.indexOf('  \n', p); idx !== -1; idx = src.indexOf('  \n', idx + 1)) {
      let runStart = idx;
      while (src[runStart - 1] === ' ') runStart--;
      if (runStart - 1 >= p) {
        if (runStart - 1 < q) q = runStart - 1;
        break;
      }
    }
    {
      let from = p + 1;
      for (;;) {
        const idxM = src.indexOf('mailto:', from);
        const idxX = src.indexOf('xmpp:', from);
        const idx = idxM === -1 ? idxX : idxX === -1 ? idxM : Math.min(idxM, idxX);
        if (idx === -1) break;
        if (idx - 1 < q) q = idx - 1;
        break;
      }
    }
    for (let idx = src.indexOf('@', p + 1); idx !== -1; idx = src.indexOf('@', idx + 1)) {
      let runStart = idx;
      while (runStart > 0) {
        const code = src.charCodeAt(runStart - 1);
        if (code > 127 || emailLocalTable[code] === 0) break;
        runStart--;
      }
      if (runStart - 1 >= p) {
        if (runStart - 1 < q) q = runStart - 1;
        break;
      }
    }
    if (q >= n) return n;

    const code = src.charCodeAt(q);
    if (code < 128 && textStopTable[code] === 1) return q;
    if (code === 104 || code === 72 || code === 102 || code === 70) {
      if (protocolAhead(src, q)) return q;
    } else if (code === 119 && src.startsWith('www.', q)) {
      // w: a www. address counts only after whitespace or one of *_~(
      const prev = src[q - 1];
      if (
        prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' || prev === '\v' ||
        prev === '*' || prev === '_' || prev === '~' || prev === '('
      ) {
        return q;
      }
    }
    if (src[q + 1] === ' ' && code !== 32 && hardBreakAhead(src, q + 1)) return q + 1;
    if (!isAlnumCode(code) && startsMailtoOrXmpp(src, q + 1)) return q + 1;
    if (code > 127 || emailLocalTable[code] === 0) {
      const nextCode = src.charCodeAt(q + 1);
      if (nextCode < 128 && emailLocalTable[nextCode] === 1 && emailAhead(src, q + 1)) return q + 1;
    }
    p = q + 1;
  }
}

const stopSearchRe = /[\\<!\[`*~_w]/g;

function inlineTextTokenFast(ctx, src) {
  const len = textRunLength(src);
  if (len <= 0) return;
  const raw = len === src.length ? src : src.slice(0, len);
  const inRaw = ctx.state.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : resolveCharRefs(raw), escaped: inRaw };
}

// ---------------------------------------------------------------------------
// The inline pass. `masked` is the shadow of `src` built by maskText; the
// emphasis tokenisers read it, everything else reads `src`. Adjacent text
// tokens merge, and the character before the current position is tracked
// for the emphasis flanking checks.
// ---------------------------------------------------------------------------
function inlineTokens(ctx, src, tokens) {
  const savedParenPossible = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = savedParenPossible && src.includes(')');
  try {
    // Fast path: a string with no inline markup starters, no autolink
    // triggers and no hard-break spacing lexes as a single text token.
    if (
      !/[\\<!\[`*~_]/.test(src) &&
      src.indexOf('@') === -1 &&
      src.indexOf('://') === -1 &&
      src.indexOf('mailto:') === -1 &&
      src.indexOf('xmpp:') === -1 &&
      src.indexOf('  \n') === -1 &&
      !/(^|[\s*_~(])www\./.test(src)
    ) {
      const inRaw = ctx.state.inRawBlock;
      tokens.push({ type: 'text', raw: src, text: inRaw ? src : resolveCharRefs(src), escaped: inRaw });
      return tokens;
    }
    let masked = src;
    if (src.includes('*') || src.includes('_') || src.includes('~')) {
      // The mask only changes something when the source holds a backslash,
      // backtick, '[' or '<'; otherwise the shadow is the source itself.
      if (src.includes('\\') || src.includes('`') || src.includes('[') || src.includes('<')) {
        masked = maskText(ctx, src);
      }
    }
    ctx.maskStack.push({ maskedSrc: masked, lastEm: null, lastDel: 0 });
    try {
      inlineLoop(ctx, src, masked, tokens);
    } finally {
      ctx.maskStack.pop();
    }
  } finally {
    ctx.state.linkParenPossible = savedParenPossible;
  }
  return tokens;
}

/** Cheap guard for the extended-autolink tokeniser: could an autolink
 *  start here at all (a mailto:/xmpp: address, a protocol URL, a www.
 *  address, or an e-mail address)? False positives only waste one regex
 *  attempt; the tokeniser itself decides. */
function urlPlausible(src) {
  const c = src[0];
  if (c === 'm' && src.startsWith('mailto:')) return true;
  if (c === 'x' && src.startsWith('xmpp:')) return true;
  if (c === 'w' && src.startsWith('www.')) return true;
  if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && protocolAhead(src, 0)) return true;
  const code = src.charCodeAt(0);
  if (code < 128 && emailLocalTable[code] === 1) return emailAhead(src, 0);
  return false;
}

function inlineLoop(ctx, src, masked, tokens) {
  let prevChar = '';
  let afterText = false;
  let lastLength = Infinity;
  while (src) {
    if (src.length < lastLength) lastLength = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!afterText) prevChar = '';
    afterText = false;

    // First-character dispatch: at any position only a few tokenisers can
    // match, and they are tried in marked's order within each group.
    let token;
    const c = src.charCodeAt(0);
    if (c === 92) {
      // backslash
      token = escapeToken(ctx, src) || brToken(ctx, src);
    } else if (c === 60) {
      // <
      token = tagToken(ctx, src) || autolinkToken(ctx, src);
    } else if (c === 91 || c === 33) {
      // [ or !
      token = linkToken(ctx, src);
      if (!token) {
        token = reflinkToken(ctx, src);
        if (token) {
          src = src.substring(token.raw.length);
          const last = tokens[tokens.length - 1];
          if (token.type === 'text' && last && last.type === 'text') {
            last.raw += token.raw;
            last.text += token.text;
          } else tokens.push(token);
          continue;
        }
      }
    } else if (c === 42 || c === 95) {
      // * or _
      token = emStrongToken(ctx, src, masked, prevChar);
    } else if (c === 96) {
      // `
      token = codespanToken(ctx, src);
    } else if (c === 126) {
      // ~
      token = delToken(ctx, src, masked, prevChar);
    } else if (c === 32) {
      // space
      token = brToken(ctx, src);
    }
    // marked tries the url tokeniser at every position where the earlier
    // tokenisers failed — including after a failed emStrong/del/codespan
    // attempt (an e-mail address may start with '_', for instance).
    if (!token && !ctx.state.inLink && urlPlausible(src)) {
      token = urlToken(ctx, src);
    }
    if (token) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if ((token = inlineTextTokenFast(ctx, src))) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      afterText = true;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.raw += token.raw;
        last.text += token.text;
      } else tokens.push(token);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering. Walks the token tree and emits marked's HTML.
// ---------------------------------------------------------------------------
function renderTextToken(token) {
  if (token.tokens) return renderInline(token.tokens);
  if (token.escaped) return token.text;
  return escapeHtml(token.text);
}

function renderInline(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
        out += renderTextToken(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link':
        out += renderLink(token);
        break;
      case 'image':
        out += renderImage(token);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'strong':
        out += '<strong>' + renderInline(token.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInline(token.tokens) + '</em>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(token.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += '<del>' + renderInline(token.tokens) + '</del>';
        break;
      case 'text':
        out += renderTextToken(token);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

/** Plain-text rendering used for image alt attributes. */
function renderInlineText(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineText(token.tokens) : token.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
        out += token.text;
        break;
      case 'checkbox':
        out += token.raw;
        break;
      case 'br':
        break;
      case 'escape':
        out += token.text;
        break;
      default:
        out += token.tokens ? renderInlineText(token.tokens) : (token.text ?? '');
    }
  }
  return out;
}

function renderLink(token) {
  const text = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens);
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return text;
  let out = '<a href="' + escapeHtml(cleaned, token.autolink) + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  return out + '>' + text + '</a>';
}

function renderImage(token) {
  let alt = token.text;
  if (token.tokens) alt = renderInlineText(token.tokens);
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return escapeHtml(alt);
  let out = '<img src="' + escapeHtml(cleaned) + '" alt="' + escapeHtml(alt) + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  return out + '>';
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCodeBlock(token) {
  const langWord = (token.lang || '').match(other.notSpaceStart)[0];
  const body = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  const escaped = token.escaped ? body : escapeHtml(body, true);
  if (langWord) return '<pre><code class="language-' + escapeHtml(langWord) + '">' + escaped + '</code></pre>\n';
  return '<pre><code>' + escaped + '</code></pre>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderTable(token) {
  let head = '';
  for (const cell of token.header) head += renderTableCell(cell);
  let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
  if (token.rows.length > 0) {
    let body = '';
    for (const row of token.rows) {
      let cells = '';
      for (const cell of row) cells += renderTableCell(cell);
      body += '<tr>\n' + cells + '</tr>\n';
    }
    out += '<tbody>' + body + '</tbody>';
  }
  return out + '</table>\n';
}

function renderList(token) {
  let body = '';
  for (const item of token.items) {
    body += '<li>' + renderBlocks(item.tokens) + '</li>\n';
  }
  const tag = token.ordered ? 'ol' : 'ul';
  const start = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : '';
  return '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
}

function renderBlocks(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + token.depth + '>' + renderInline(token.tokens) + '</h' + token.depth + '>\n';
        break;
      case 'code':
        out += renderCodeBlock(token);
        break;
      case 'table':
        out += renderTable(token);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(token.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(token);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + renderInline(token.tokens) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(token);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function createContext() {
  return {
    links: Object.create(null),
    linkCount: 0,
    inlineQueue: [],
    maskStack: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
}

/** The HTML marked 18.1.3 renders for `markdown` with its default options. */
export function parse(markdown) {
  const ctx = createContext();
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const tokens = blockTokens(ctx, src, [], false);
  for (let i = 0; i < ctx.inlineQueue.length; i++) {
    const entry = ctx.inlineQueue[i];
    ctx.state.inRawBlock = false;
    inlineTokens(ctx, entry.src, entry.tokens);
  }
  ctx.inlineQueue = [];
  return renderBlocks(tokens);
}
