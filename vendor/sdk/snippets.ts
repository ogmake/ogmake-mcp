// @ogmake/sdk — og:image snippet per framework. Single source: both
// apps/web's docs and packages/mcp's `og_snippet` tool call this instead of
// each hand-rolling their own copy (decisions-2026-09-22.md item 3).
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
