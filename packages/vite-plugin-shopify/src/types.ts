export interface Options {
  /**
   * Root path to your Shopify theme directory.
   *
   * @default './'
   */
  themeRoot?: string

  /**
   * Front-end entry points directory.
   *
   * @default 'frontend/entrypoints'
   */
  entrypointsDir?: string

  /**
   * Additional files to use as entry points (accepts an array of file paths or glob patterns).
   *
   * @default []
   */
  additionalEntrypoints?: string[]

  /**
   * Front-end source code directory.
   *
   * @default 'frontend'
   */
  sourceCodeDir?: string

  /**
   * Specifies the file name of the snippet that loads your assets.
   *
   * @default 'vite-tag.liquid'
   */
  snippetFile?: string

  /**
   * Specifies whether to append version numbers to your production-ready asset URLs in {@link snippetFile}.
   *
   * @default false
   */
  versionNumbers?: boolean

  /**
   * Enables the creation of Cloudflare tunnels during dev, allowing previews from any device.
   *
   * @default false
   */
  tunnel?: boolean | string

  /**
   * Specifies whether to use the {@link https://www.npmjs.com/package/@shopify/theme-hot-reload @shopify/theme-hot-reload} script to enable hot reloading for the theme.
   */
  themeHotReload?: boolean

  /**
   * File extensions to exclude from entry point generation in the vite-tag snippet.
   *
   * @default []
   */
  excludeExtensions?: string[]

  /**
   * Path patterns to exclude from entry point generation in the vite-tag snippet.
   *
   * @default []
   */
  excludePaths?: string[]

  /**
   * Per-file loading strategy overrides for production script and style tags.
   *
   * Controls how specific assets are loaded in the generated vite-tag snippet,
   * allowing fine-grained control over render-blocking behaviour for Lighthouse
   * and Core Web Vitals optimisation.
   *
   * Each rule matches against the **output filename** (e.g. `icons-shared.min.js`,
   * `42.min.css`) — not the source path.
   *
   * Matching accepts:
   * - `RegExp` — tested directly against the filename
   * - `string` with `*` — converted to a glob-style regex (e.g. `'icons-*.min.js'`)
   * - Plain `string` — exact filename match
   *
   * Strategies:
   * - **JS `'defer'`** — `<script src="..." defer></script>` (non-module, deferred)
   * - **JS `'async'`** — `<script src="..." async></script>` (non-blocking, runs ASAP)
   * - **CSS `'preload'`** — Non-render-blocking via `media="print"` + `onload` swap
   * - **CSS `'defer'`** — Alias for `'preload'` (semantic convenience)
   *
   * First matching rule wins. Assets with no matching rule use the default
   * loading strategy (`type="module"` for JS, blocking `stylesheet_tag` for CSS).
   *
   * @default []
   *
   * @example
   * ```ts
   * viteShopify({
   *   assetLoading: [
   *     // Defer all numbered chunk JS files
   *     { match: /^\d+\.min\.js$/, strategy: 'defer' },
   *     // Defer all icon chunk JS files
   *     { match: 'icons-*.min.js', strategy: 'defer' },
   *     // Non-blocking CSS for numbered chunks
   *     { match: /^\d+\.min\.css$/, strategy: 'preload' },
   *   ]
   * })
   * ```
   */
  assetLoading?: AssetLoadingRule[]
}

/**
 * A rule that overrides the default loading strategy for a matched asset file.
 */
export interface AssetLoadingRule {
  /**
   * Pattern to match against the output filename.
   *
   * - `RegExp` — tested directly (e.g. `/^\d+\.min\.js$/`)
   * - `string` with `*` — glob-style wildcard (e.g. `'icons-*.min.js'`)
   * - Plain `string` — exact filename match (e.g. `'icons-shared.min.js'`)
   */
  match: string | RegExp

  /**
   * Loading strategy to apply when the pattern matches.
   *
   * - `'defer'` — JS: `<script defer>`, CSS: non-render-blocking preload
   * - `'async'` — JS: `<script async>`, CSS: non-render-blocking preload
   * - `'preload'` — CSS: non-render-blocking via `media="print"` + `onload` swap
   */
  strategy: 'defer' | 'async' | 'preload'
}

export type DevServerUrl = `${'http' | 'https'}://${string}:${number}`

export interface FrontendURLResult {
  frontendUrl: string
  frontendPort: number
  usingLocalhost: boolean
}