import assert from "node:assert/strict";
import { test } from "node:test";
import { Markdown } from "markdown-to-jsx/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownOptions, safeHref, streamingOptions } from "./markdown.ts";

const OPTIONS = { markdownOptions, streamingOptions };

function each(check: (render: (text: string) => string, name: string) => void): void {
  for (const [name, options] of Object.entries(OPTIONS)) {
    check((text) => renderToStaticMarkup(createElement(Markdown, { options }, text)), name);
  }
}

test("safeHref keeps only absolute web and mail addresses", () => {
  const cases: [string, string | null][] = [
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
    ["http://example.com", "http://example.com/"],
    ["HTTPS://EXAMPLE.COM/", "https://example.com/"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    ["  https://example.com/", "https://example.com/"],
    ["javascript:alert(1)", null],
    ["JavaScript:alert(1)", null],
    ["  javascript:alert(1)", null],
    ["java\tscript:alert(1)", null],
    ["data:text/html,<b>x</b>", null],
    ["data:image/png;base64,AAAA", null],
    ["vbscript:msgbox(1)", null],
    ["file:///etc/hosts", null],
    ["ftp://example.com/", null],
    ["/settings", null],
    ["notes.md", null],
    ["#top", null],
    ["//example.com/", null],
    ["", null],
  ];
  for (const [value, kept] of cases) assert.equal(safeHref(value), kept, JSON.stringify(value));
});

test("an HTML tag in a body is shown as text, never made an element", () => {
  const tags = [
    "<script>alert(1)</script>",
    '<iframe src="https://example.com"></iframe>',
    '<img src="https://example.com/x.png">',
    '<img src=x onerror="alert(1)">',
    '<a href="https://example.com" onclick="alert(1)">x</a>',
    '<div onmouseover="alert(1)">hover</div>',
  ];
  each((render, name) => {
    for (const tag of tags) {
      for (const text of [tag, `Before ${tag} after`, `- item\n\n${tag}`]) {
        const html = render(text);
        assert.doesNotMatch(html, /<(script|iframe|img|div)\b/i, `${name}: ${text}`);
        assert.doesNotMatch(html, /<[^>]*\son\w+=/i, `${name}: ${text}`);
        assert.match(html, /&lt;/, `${name}: ${text}`);
      }
    }
  });
});

test("links to anything but a web or mail address keep their words and lose the address", () => {
  const targets = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "JaVaScRiPt:alert(1)",
    "%20javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "DATA:text/html,x",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "/relative/path",
    "notes.md",
    "#heading",
  ];
  each((render, name) => {
    for (const target of targets) {
      for (const text of [`[open me](${target})`, `[open me](  ${target})`, `[open me][r]\n\n[r]: ${target}`]) {
        const html = render(text);
        assert.doesNotMatch(html, /href=/, `${name}: ${text}`);
        assert.match(html, /open me/, `${name}: ${text}`);
      }
    }
  });
});

test("a kept link opens in a new tab with no opener", () => {
  each((render, name) => {
    for (const text of ["[docs](https://example.com/docs)", "<https://example.com/docs>", "https://example.com/docs"]) {
      assert.match(
        render(text),
        /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">/,
        `${name}: ${text}`,
      );
    }
  });
});

test("image syntax makes a link labelled with its alt text, never an image", () => {
  each((render, name) => {
    const html = render("![pricing chart](https://example.com/chart.png)");
    assert.doesNotMatch(html, /<img/i, name);
    assert.match(html, /<a href="https:\/\/example\.com\/chart\.png" [^>]*>pricing chart<\/a>/, name);
    const dropped = render("![tracker](javascript:alert(1))");
    assert.doesNotMatch(dropped, /<img|href=/i, name);
    assert.match(dropped, /tracker/, name);
  });
});

test("the markdown an agent writes becomes plain elements", () => {
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      { options: markdownOptions },
      "# root\n\nSome **bold**, `code` and:\n\n- [x] done\n- [ ] open\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nnpm test\n```",
    ),
  );
  assert.match(html, /<h1 id="">root<\/h1>/, "a heading takes no id from its words");
  for (const part of [
    "<strong>bold</strong>",
    "<code>code</code>",
    'type="checkbox"',
    "<blockquote>",
    "<table>",
    "<pre><code",
  ]) {
    assert.ok(html.includes(part), part);
  }
});

test("streaming holds back a half-written mark instead of showing it raw", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { options: streamingOptions }, "It is **nearly"));
  assert.doesNotMatch(html, /\*\*/);
});
