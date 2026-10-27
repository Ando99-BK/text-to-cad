// The Markdown Claude writes in its replies, parsed to plain data the page turns into DOM nodes
// (never HTML text, so nothing in a reply can inject markup). The subset is what chat replies
// use: paragraphs, headings, bullet and numbered lists, fenced code, and inline bold, italic and
// code. Anything else stays text.

const FENCE = /^\s*```/u;
const BULLET = /^\s*[-*+]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/u;

/** Inline runs: `[{ type: "text" | "strong" | "em" | "code", text }]`. */
export function parseInline(text) {
  const runs = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      runs.push({ type: "text", text: rest });
      break;
    }
    if (match.index) runs.push({ type: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) runs.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**") || token.startsWith("__")) runs.push({ type: "strong", text: token.slice(2, -2) });
    else runs.push({ type: "em", text: token.slice(1, -1) });
    rest = rest.slice(match.index + token.length);
  }
  return runs;
}

/**
 * Blocks: `{ type: "p", inline }`, `{ type: "h", level, inline }`, `{ type: "ul" | "ol", items:
 * [inline] }` and `{ type: "code", text }`. An unclosed fence (a reply still streaming) runs to
 * the end.
 */
export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text).replace(/\r\n?/gu, "\n").split("\n");
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) {
      flush();
      const code = [];
      while (++index < lines.length && !FENCE.test(lines[index])) code.push(lines[index]);
      blocks.push({ type: "code", text: code.join("\n").replace(/\n+$/u, "") });
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ type: "h", level: heading[1].length, inline: parseInline(heading[2].trim()) });
    } else if (bullet || numbered) {
      flush();
      const type = bullet ? "ul" : "ol";
      const last = blocks.at(-1);
      const item = parseInline((bullet ?? numbered)[1].trim());
      if (last?.type === type && lines[index - 1]?.trim()) last.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (/^\s{2,}\S/u.test(line) && (blocks.at(-1)?.type === "ul" || blocks.at(-1)?.type === "ol") && !paragraph.length) {
      // An indented line under a list item continues it.
      const items = blocks.at(-1).items;
      items[items.length - 1] = [...items.at(-1), { type: "text", text: " " }, ...parseInline(line.trim())];
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

function inlineNodes(document, runs) {
  return runs.map((run) => {
    if (run.type === "text") return document.createTextNode(run.text);
    const node = document.createElement(run.type);
    node.textContent = run.text;
    return node;
  });
}

/** The blocks as DOM nodes, for `parent.replaceChildren(...)`. */
export function renderMarkdown(document, text) {
  return parseMarkdown(text).map((block) => {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      return pre;
    }
    if (block.type === "ul" || block.type === "ol") {
      const list = document.createElement(block.type);
      for (const item of block.items) {
        const li = document.createElement("li");
        li.append(...inlineNodes(document, item));
        list.append(li);
      }
      return list;
    }
    const node = document.createElement(block.type === "h" ? `h${Math.min(block.level + 2, 6)}` : "p");
    node.append(...inlineNodes(document, block.inline));
    return node;
  });
}
