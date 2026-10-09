# ogmake-mcp

Local stdio [MCP](https://modelcontextprotocol.io) server for
[ogmake.com](https://ogmake.com) og:image generation. Run it with
`npx -y ogmake-mcp`.

## Tools

- **`list_templates`** — lists every registered og:image template id,
  version, and its params JSON Schema. No API key required.
- **`render_html`** — renders raw HTML/CSS to a stored PNG/JPG/WebP/PDF (2 credits;
  needs `OGMAKE_API_KEY`).
- **`render_image`** — renders an og:image.
  - With `OGMAKE_API_KEY` set: renders `template` (+ optional `params`,
    `format`, `preset`, `scale`, `v`, `bg`, `font` — a Google Fonts family) via the authenticated API and
    returns its hosted URL plus the image bytes.
  - With no `OGMAKE_API_KEY`: renders a **watermarked** free image from
    `title` (+ optional `description`, `site`) and returns **image bytes
    only** — no hosted URL (the free endpoint never stores one).
- **`create_batch`** — starts an async batch of up to 500 renders (`POST /v1/batch`);
  returns a `batch_id` immediately. Optional `webhookUrl` (https) gets a signed
  `batch.completed` event. Needs `OGMAKE_API_KEY`.
- **`get_batch`** — a batch's status plus each item's stored URL or error. Needs
  `OGMAKE_API_KEY`.
- **`build_image_url`** — builds an image URL for `template` without
  rendering it.
  - With `OGMAKE_SIGNING_SECRET` + `OGMAKE_SIGNING_KEY_ID` set: signs the URL
    locally (HMAC-SHA256) — the signing secret never leaves your machine and
    is never sent to the model.
  - Else with `OGMAKE_PUBLIC_KEY_ID` set: builds an unsigned `/p/:keyId/:template`
    URL (the key must be marked public and allow-list that template on
    ogmake.com).
- **`og_snippet`** — renders the `og:image`/`twitter:image` meta tag snippet
  for a given framework (`html`, `hugo`, `jekyll`, `rails`, `laravel`,
  `django`, `wordpress`, `ghost`) and image URL.
- **`get_usage`** — current billing period's render usage/quota for the
  `OGMAKE_API_KEY` account. Requires `OGMAKE_API_KEY`.

Every secret (`OGMAKE_API_KEY`, `OGMAKE_SIGNING_SECRET`) stays local: it is
read from the environment once at startup and is never echoed back in a
tool result, error message, or log line.

## Environment variables

| Variable                | Required for                                    |
| ------------------------ | ------------------------------------------------ |
| `OGMAKE_API_KEY`         | authenticated `render_image`, `render_html`, `create_batch`, `get_batch`, `get_usage` |
| `OGMAKE_BASE_URL`        | optional — override the API origin (defaults to `https://ogmake.com`) |
| `OGMAKE_SIGNING_SECRET`  | local signing in `build_image_url` (base64url)    |
| `OGMAKE_SIGNING_KEY_ID`  | local signing in `build_image_url` (paired with the secret above) |
| `OGMAKE_PUBLIC_KEY_ID`   | unsigned `/p` URLs in `build_image_url`           |

## Install

### Claude Code

```sh
claude mcp add ogmake --env OGMAKE_API_KEY=og_live_... -- npx -y ogmake-mcp
```

Or add to `.mcp.json` (project scope) / `~/.claude.json` (user scope); Cursor
takes the same block in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ogmake": {
      "command": "npx",
      "args": ["-y", "ogmake-mcp"],
      "env": { "OGMAKE_API_KEY": "og_live_..." }
    }
  }
}
```

Without `OGMAKE_API_KEY` only `list_templates`, watermarked free `render_image`,
`build_image_url` and `og_snippet` work.

Support: support@ogmake.com · License: MIT

## Development

```sh
pnpm --filter ogmake-mcp run test        # unit tests, 100% coverage
pnpm --filter ogmake-mcp run test:e2e    # spawns the packed CLI over stdio against a local wrangler dev
pnpm --filter ogmake-mcp run build       # tsup bundle -> dist/index.js
pnpm --filter ogmake-mcp run pack        # build + npm pack -> pack-out/*.tgz
```

## Development

`vendor/` holds the SDK and request-signing helper this server bundles, so the
repository builds standalone: `npm install && npm run build && npm test`.
