import type { MarkdownToJSX } from "markdown-to-jsx/react";
import { createElement, Fragment, type ReactNode } from "react";

const SCHEMES = ["http:", "https:", "mailto:"];

/** An address an agent wrote, if it is an absolute web or mail address; null drops it. */
export function safeHref(value: string): string | null {
  const url = URL.parse(value);
  return url && SCHEMES.includes(url.protocol) ? url.href : null;
}

// A dropped address leaves the link's words as plain text.
function link({ href, children }: { href?: string; children?: ReactNode }): ReactNode {
  if (!href) return createElement(Fragment, null, children);
  return createElement("a", { href, target: "_blank", rel: "noopener noreferrer" }, children);
}

// The browser never loads an address an agent wrote: an image is a link to it, labelled with its alt text.
function image({ src, alt }: { src?: string; alt?: string }): ReactNode {
  return link({ ...(src ? { href: src } : {}), children: alt || src });
}

/** How every agent message body is parsed: no HTML, safeHref the only judge of an address. */
export const markdownOptions: MarkdownToJSX.Options = {
  disableParsingRawHTML: true,
  // A body that opens with a block between two --- lines is words to show, not settings to hide.
  disableFrontmatter: true,
  sanitizer: safeHref,
  // A heading of an agent's must not take an id the page uses.
  slugify: () => "",
  forceBlock: true,
  wrapper: Fragment,
  overrides: { a: link, img: image },
};

/** The same, for text still being written: a half-written mark is held back rather than shown raw. */
export const streamingOptions: MarkdownToJSX.Options = { ...markdownOptions, optimizeForStreaming: true };
