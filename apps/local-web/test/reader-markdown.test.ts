import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

test("Reader Markdown renders common structure without executing raw HTML", () => {
  const markdown = `# Heading

Paragraph with \`inline\` code and [link](https://example.com).

- bullet
1. numbered

> quote

| A | B |
| - | - |
| 1 | 2 |

\`\`\`ts
const preserved = true;
\`\`\`

<script>globalThis.compromised = true</script>

TAIL CONCLUSION`;
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: markdown }));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code class="language-ts">const preserved = true;/);
  assert.match(html, /TAIL CONCLUSION/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /globalThis\.compromised = true<\/script>/);
});
