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
   * - **JS `'async'`**   — `<script type="module" async>` (non-blocking, runs ASAP)
   * - **JS `'lazy'`**    — Only emits `<link rel="modulepreload">` hint, no `<script>` tag.
   *                         The chunk executes only when dynamically imported at runtime.
   * - **JS `'defer'`**   — Same as default (ES modules are deferred by spec).
   *                         Kept as a semantic alias for readability.
   * - **CSS `'preload'`** — Non-render-blocking via `media="print"` + `onload` swap
   * - **CSS `'defer'`**  — Alias for `'preload'` (semantic convenience)
   * - **CSS `'lazy'`**   — Alias for `'preload'` (semantic convenience)
   * - **CSS `'async'`**  — Alias for `'preload'` (CSS has no native async)
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
   *     // Lazy-load icon chunks — only fetched when section renders
   *     { match: 'icons-*.min.js', strategy: 'lazy' },
   *     // Async-load numbered chunk JS files
   *     { match: /^\d+\.min\.js$/, strategy: 'async' },
   *     // Non-blocking CSS for numbered chunks
   *     { match: /^\d+\.min\.css$/, strategy: 'preload' },
   *   ]
   * })
   * ```
   */
  assetLoading?: AssetLoadingRule[]

  /**
   * Maximum size in bytes for the generated vite-tag snippet file.
   *
   * Shopify imposes a 256KB file size limit on liquid snippets.
   * When the generated vite-tag content exceeds this threshold,
   * the plugin automatically splits the if/elsif entry matching
   * logic into numbered sub-snippets (`vite-tag-0.liquid`,
   * `vite-tag-1.liquid`, etc.) and generates a main `vite-tag.liquid`
   * that delegates to each via `{% render %}`.
   *
   * The path resolution (alias replacement) stays in the main snippet.
   * Sub-snippets receive the resolved `path` variable directly.
   *
   * Set to `0` to disable splitting (not recommended if you have
   * many entry points).
   *
   * @default 204800 (200KB — leaves ~56KB headroom below Shopify's 256KB limit)
   *
   * @example
   * ```ts
   * viteShopify({
   *   // Split at 150KB for extra headroom
   *   snippetMaxSize: 150 * 1024,
   * })
   * ```
   */
  snippetMaxSize?: number
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
   * - `'async'`   — JS: `<script type="module" async>`, CSS: non-render-blocking preload
   * - `'lazy'`    — JS: modulepreload hint only (no script tag), CSS: non-render-blocking preload
   * - `'defer'`   — JS: default (modules are deferred by spec), CSS: non-render-blocking preload
   * - `'preload'` — CSS: non-render-blocking via `media="print"` + `onload` swap
   */
  strategy: 'defer' | 'async' | 'preload' | 'lazy'
}

export type DevServerUrl = `${'http' | 'https'}://${string}:${number}`

export interface FrontendURLResult {
  frontendUrl: string
  frontendPort: number
  usingLocalhost: boolean
}