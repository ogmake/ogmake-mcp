// @ogmake/sdk — og:image snippet per framework. Single source: both
// apps/web's docs and packages/mcp's `og_snippet` tool call this instead of
// each hand-rolling their own copy (decisions-2026-09-22.md item 3).
import { DEFAULT_BASE_URL, publicAutoBase } from "./client";
export type SnippetFramework = "html" | "hugo" | "jekyll" | "rails" | "laravel" | "django" | "wordpress" | "ghost";

export const SNIPPET_FRAMEWORKS: readonly SnippetFramework[] = [
  "html",
  "hugo",
  "jekyll",
  "rails",
  "laravel",
  "django",
  "wordpress",
  "ghost",
] as const;

export function isSnippetFramework(value: string): value is SnippetFramework {
  return (SNIPPET_FRAMEWORKS as readonly string[]).includes(value);
}

/** Renders the `og:image` (+ `twitter:image`) tag pair for `framework`,
 * pointing at `imageUrl`. `imageUrl` is inserted verbatim — callers building
 * it from `signImageUrl`/`publicImageUrl` already have a fully-formed,
 * already-encoded URL; this function does no further escaping beyond each
 * templating language's own attribute-quoting convention. */
export function ogSnippet(framework: SnippetFramework, imageUrl: string): string {
  switch (framework) {
    case "html":
      return [
        `<meta property="og:image" content="${imageUrl}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${imageUrl}" />`,
      ].join("\n");
    case "hugo":
      return [
        `<meta property="og:image" content="{{ "${imageUrl}" }}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="{{ "${imageUrl}" }}" />`,
      ].join("\n");
    case "jekyll":
      return [
        `<meta property="og:image" content="${imageUrl}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${imageUrl}" />`,
      ].join("\n");
    case "rails":
      return [
        `<%= tag.meta property: "og:image", content: "${imageUrl}" %>`,
        `<%= tag.meta name: "twitter:card", content: "summary_large_image" %>`,
        `<%= tag.meta name: "twitter:image", content: "${imageUrl}" %>`,
      ].join("\n");
    case "laravel":
      return [
        `<meta property="og:image" content="{{ '${imageUrl}' }}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="{{ '${imageUrl}' }}">`,
      ].join("\n");
    case "django":
      return [
        `<meta property="og:image" content="${imageUrl}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="${imageUrl}">`,
      ].join("\n");
    case "wordpress":
      return [
        `<meta property="og:image" content="<?php echo esc_url( '${imageUrl}' ); ?>" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="<?php echo esc_url( '${imageUrl}' ); ?>" />`,
      ].join("\n");
    case "ghost":
      return [
        `<meta property="og:image" content="${imageUrl}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${imageUrl}" />`,
      ].join("\n");
  }
}

/** Default stand-in for the page URL in {@link autoSnippet}: replace it with
 * your CMS/template variable that prints the page's URL-encoded address. */
export const DEFAULT_AUTO_URL_PLACEHOLDER = "{{PAGE_URL_ENCODED}}";

export interface AutoSnippetOptions {
  /** A key the owner marked public. */
  publicKey: string;
  /** Inserted verbatim as the `url=` value. It must print the page URL
   * URL-encoded at render time (e.g. Liquid `{{ page.url | absolute_url |
   * url_encode }}`). Defaults to {@link DEFAULT_AUTO_URL_PLACEHOLDER}. */
  urlPlaceholder?: string;
  template?: string;
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
}

/** The auto-mode `<head>` block for any CMS: og:image (+ width/height) and
 * the Twitter card tags, pointing at the public
 * `/p/{publicKey}/auto?url=...` URL with a template placeholder for the
 * page URL. The `&` before `template=` is written as `&amp;`, as HTML
 * attribute values require. */
export function autoSnippet(opts: AutoSnippetOptions): string {
  const placeholder = opts.urlPlaceholder ?? DEFAULT_AUTO_URL_PLACEHOLDER;
  let imageUrl = `${publicAutoBase(opts.publicKey, opts.baseUrl ?? DEFAULT_BASE_URL)}?url=${placeholder}`;
  if (opts.template) imageUrl += `&amp;template=${encodeURIComponent(opts.template)}`;
  return [
    `<meta property="og:image" content="${imageUrl}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${imageUrl}" />`,
  ].join("\n");
}
