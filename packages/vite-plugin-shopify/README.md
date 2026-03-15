# vite-plugin-shopify

`vite-plugin-shopify` aims to integrate Vite as seamlessly as possible with Shopify themes to optimize your theme development experience.

## Features

- ⚡️ [Everything Vite provides](https://vitejs.dev/guide/features.html), plus:
- 🤖 Automatic entrypoint detection
- 🏷 Smart tag generation to load your scripts and styles
- 🌎 Full support for assets served from Shopify's CDN
- 👌 Zero-Config
- 🔩 Extensible
- 🚫 Entry exclusion by extension or path pattern
- ⚙️ Per-file loading strategy control for Lighthouse optimisation

## Install

```bash
npm i vite-plugin-shopify -D

# yarn
yarn add vite-plugin-shopify -D

# pnpm
pnpm add vite-plugin-shopify -D
```

## Usage

Add the `vite-plugin-shopify` to your `vite.config.js` file and configure it:

```js
import shopify from 'vite-plugin-shopify'

export default {
  plugins: [
    /* Plugin options are not required, defaults shown */
    shopify({
      // Root path to your Shopify theme directory (location of snippets, sections, templates, etc.)
      themeRoot: './',
      // Front-end source code directory
      sourceCodeDir: 'frontend',
      // Front-end entry points directory
      entrypointsDir: 'frontend/entrypoints',
      // Additional files to use as entry points (accepts an array of file paths or glob patterns)
      additionalEntrypoints: [],
      // Specifies the file name of the snippet that loads your assets
      snippetFile: 'vite-tag.liquid',
      // Specifies whether to append version numbers to your production-ready asset URLs in `snippetFile`
      versionNumbers: false,
      // Enables the creation of Cloudflare tunnels during dev, allowing previews from any device
      tunnel: false,
      // Specifies whether to use the @shopify/theme-hot-reload script to enable hot reloading for the theme
      themeHotReload: true,
      // File extensions to exclude from entry point generation
      excludeExtensions: [],
      // Path patterns to exclude from entry point generation
      excludePaths: [],
      // Per-file loading strategy overrides for production builds
      assetLoading: []
    })
  ]
}
```

Volt, a Vite plugin for Shopify development does not require you to specify the entry points for your theme. By default, it treats JavaScript and CSS files (including preprocessed
languages such as TypeScript, JSX, TSX, and Sass) within the `frontend/entrypoints` folder in the root of your project as entry points for Vite.

```
/
└── frontend/
    └── entrypoints/
        ├── theme.scss
        └── theme.ts
```

### Adding scripts and styles to your theme

Volt, a Vite plugin for Shopify development generates a `vite-tag` snippet which includes `<script>` and `<link>` tags, and all the liquid logic needed
to load your assets.

With your Vite entry points configured, you only need to reference them with the `vite-tag` snippet that you add to the `<head>` of your theme's layout:

```liquid
{% liquid
  # Recommended: New syntax compatible with Shopify's strict Liquid parser
  render 'vite-tag', entry: 'theme.scss'
  render 'vite-tag', entry: 'theme.ts'
%}
```

**Legacy syntax (still supported):**
```liquid
{% liquid
  # Old syntax - still works for backward compatibility
  render 'vite-tag' with 'theme.scss'
  render 'vite-tag' with 'theme.ts'
%}
```

> **Note:** The new syntax using named parameters (`entry:`) is required for compatibility with Shopify's [strict Liquid parser](https://shopify.dev/docs/storefronts/themes/tools/rigid-liquid-migration#using-with-with-key-value-pairs). The old `with` syntax is still supported for backward compatibility but may be deprecated in future Shopify updates.

During development, the `vite-tag` will load your assets from the Vite development server and inject the Vite client to enable Hot Module Replacement.
In build mode, the snippet will load your compiled and versioned assets, including any imported CSS, and use the `asset_url` filter to serve your assets
from the Shopify content delivery network (CDN).

#### Loading `additionalEntrypoints`

```liquid
{% liquid
  # Relative to sourceCodeDir
  render 'vite-tag', entry: '@/foo.ts'
  render 'vite-tag', entry: '~/foo.ts'
%}
```

```liquid
{% liquid
  # Relative to project root
  render 'vite-tag', entry: '/bar.ts' # leading slash is required
%}
```

#### Preloading stylesheets

You can pass the `preload_stylesheet` variable to the `vite-tag` snippet to enable the `preload` parameter of the `stylesheet_tag` filter. Use it sparingly. For example, consider preloading only render-blocking stylesheets.
[Learn more](https://shopify.dev/themes/best-practices/performance#use-resource-hints-to-preload-key-resources).

```liquid
{% render 'vite-tag', entry: 'theme.scss', preload_stylesheet: true %}
```

**Legacy syntax (still supported):**
```liquid
{% render 'vite-tag' with 'theme.scss', preload_stylesheet: true %}
```

### Import aliases

For convenience, `~/` and `@/` are aliased to your `frontend` folder, which simplifies imports:

```js
import App from '@/components/App.vue'
import '@/styles/my_styles.css'
```

---

## Excluding entry points

By default, the plugin treats every file inside `entrypointsDir` as a Vite entry point. In projects with a large number of non-entry files (e.g. Vue SFCs, icon components, shared utilities) living alongside entry files, this can result in hundreds of unnecessary entry registrations.

Two options let you exclude files from entry point generation in the `vite-tag` snippet.

### `excludeExtensions`

Excludes files by their file extension. Useful for preventing frameworks-specific file types from being registered as entries.

```js
shopify({
  // Exclude all .vue, .tsx, and .jsx files from entry generation
  excludeExtensions: ['.vue', '.tsx', '.jsx']
})
```

### `excludePaths`

Excludes files whose resolved path contains the given substring. Useful for excluding entire directories.

```js
shopify({
  // Exclude all files under the snippets/icons/ directory
  excludePaths: ['snippets/icons/']
})
```

Both options can be combined:

```js
shopify({
  excludeExtensions: ['.vue', '.tsx', '.jsx'],
  excludePaths: ['snippets/icons/', 'shared/utils/']
})
```

---

## Asset loading strategies

By default, the plugin generates standard render-blocking tags for all production assets — `<script type="module">` for JS and Shopify's `stylesheet_tag` for CSS. For pages that load many chunks, this can negatively impact Lighthouse scores (FCP, LCP, INP).

The `assetLoading` option lets you override the loading behaviour of specific output files, giving you fine-grained control over which assets are render-blocking and which are deferred.

> **Important:** All Vite/Rollup output uses ES module syntax (`import`/`export`), so `type="module"` is always preserved on script tags. ES module scripts are deferred by the browser by spec — this is handled automatically.

### Configuration

`assetLoading` accepts an array of rules. Each rule has a `match` pattern and a `strategy`. The **first matching rule wins** — subsequent matches are ignored.

```js
shopify({
  assetLoading: [
    // Lazy-load icon chunks — only execute when dynamically imported
    { match: 'icons-*.min.js', strategy: 'lazy' },
    // Async-load numbered chunk JS
    { match: /^\d+\.min\.js$/, strategy: 'async' },
    // Non-blocking CSS for numbered chunks
    { match: /^\d+\.min\.css$/, strategy: 'preload' },
    // Non-blocking CSS for icon chunks
    { match: 'icons-*.min.css', strategy: 'preload' },
  ]
})
```

### Match patterns

Patterns are tested against the **output filename** (e.g. `icons-shared.min.js`, `42.min.css`) — not the source path.

| Type | Example | Description |
|---|---|---|
| `RegExp` | `/^\d+\.min\.js$/` | Tested directly against the filename |
| Glob string | `'icons-*.min.js'` | `*` matches any characters (converted to regex internally) |
| Exact string | `'icons-shared.min.js'` | Exact filename match |

### Strategies

#### JavaScript strategies

All JS strategies preserve `type="module"` since Vite/Rollup always outputs ES module syntax.

| Strategy | Output | Behaviour |
|---|---|---|
| *(default)* | `<script type="module">` | Standard ES module, deferred by spec |
| `'defer'` | `<script type="module">` | Same as default — ES modules are already deferred. Semantic alias for readability. |
| `'async'` | `<script type="module" async>` | Non-blocking, executes as soon as available. Overrides the default defer behaviour of modules. |
| `'lazy'` | *(no `<script>` tag)* | Only a `<link rel="modulepreload">` hint is emitted. The chunk is preloaded by the browser but only executes when dynamically imported at runtime by its consuming section. Best for code-split chunks that aren't needed on initial load. |

The `lazy` strategy is ideal for chunks that are pulled in by other modules (e.g. icon category chunks imported by section components). The browser preloads the file so it's ready in the cache, but no JavaScript executes until the parent module requests it — giving you the best of both worlds: fast availability without blocking.

#### CSS strategies

| Strategy | Output | Behaviour |
|---|---|---|
| *(default)* | `stylesheet_tag` | Standard Shopify stylesheet tag, render-blocking |
| `'preload'` | `media="print" onload` swap | Non-render-blocking, swaps to `all` once loaded |
| `'defer'` | Same as `'preload'` | Alias for convenience |
| `'lazy'` | Same as `'preload'` | Alias for convenience |
| `'async'` | Same as `'preload'` | Alias for convenience (CSS has no native async) |

The non-render-blocking CSS pattern uses `media="print"` with an `onload="this.media='all'"` swap, which is the most reliable technique across browsers. A `<noscript>` fallback is included for accessibility:

```html
<link rel="stylesheet" href="..." media="print" onload="this.media='all'" crossorigin="anonymous">
<noscript><link rel="stylesheet" href="..." crossorigin="anonymous"></noscript>
```

### Example: Optimising a Shopify theme with chunked icons

A typical setup where icon chunks are lazy-loaded, numbered Rollup chunks are async, and critical entry points load normally:

```js
import shopify from 'vite-plugin-shopify'

export default {
  plugins: [
    shopify({
      themeRoot: './theme/',
      sourceCodeDir: 'src',
      entrypointsDir: 'src/modules',
      excludeExtensions: ['.vue', '.tsx', '.jsx'],
      excludePaths: ['snippets/icons/'],
      assetLoading: [
        // Lazy-load icon category chunks — preloaded but only
        // execute when their consuming section dynamically imports them
        { match: 'icons-*.min.js', strategy: 'lazy' },

        // Async-load numbered chunk JS (Rollup code-split output)
        { match: /^\d+\.min\.js$/, strategy: 'async' },

        // Non-blocking CSS for numbered chunks
        { match: /^\d+\.min\.css$/, strategy: 'preload' },

        // Non-blocking CSS for icon chunks
        { match: 'icons-*.min.css', strategy: 'preload' },
      ]
    })
  ]
}
```

This ensures only critical entry points (e.g. `themeJsComponent.min.js`, `theme.min.css`) are render-blocking, while secondary chunks either execute on-demand (`lazy`) or as soon as available without blocking (`async`).

### Debugging

Enable debug logging to see which files are matched by `assetLoading` rules:

```bash
DEBUG=vite-plugin-shopify:html pnpm build
```

This outputs lines like:

```
[assetLoading] Matched icons-shared.min.js via glob "icons-*.min.js" → lazy
[assetLoading] Matched 42.min.js via RegExp → async
[assetLoading] Matched 42.min.css via RegExp → preload
```

---

## Snippet chunking

Shopify imposes a **256KB file size limit** on liquid snippets. When a project has many entry points — each with multiple script, preload, and stylesheet tags — the generated `vite-tag.liquid` can exceed this limit.

The plugin automatically handles this by splitting the snippet into smaller sub-files when the content exceeds `snippetMaxSize`.

### How it works

When splitting is triggered:

1. The if/elsif entry-matching logic is divided into numbered sub-snippets (`vite-tag-0.liquid`, `vite-tag-1.liquid`, etc.)
2. The main `vite-tag.liquid` handles path resolution (alias replacement) once, then delegates to each sub-snippet via `{% render %}`
3. Each sub-snippet receives the resolved `path` and `preload_stylesheet` variables

The generated structure looks like:

```
theme/snippets/
├── vite-tag.liquid       ← Main: path resolution + render delegates
├── vite-tag-0.liquid     ← Sub-snippet: entries 1–N
├── vite-tag-1.liquid     ← Sub-snippet: entries N+1–M
└── ...
```

**Main snippet** (`vite-tag.liquid`):
```liquid
{% comment %}...auto-generated{% endcomment %}
{% liquid
  assign entry = entry | default: vite-tag
  assign path = entry | replace: ...
%}
{% render 'vite-tag-0', path: path, preload_stylesheet: preload_stylesheet %}
{% render 'vite-tag-1', path: path, preload_stylesheet: preload_stylesheet %}
```

**Sub-snippet** (`vite-tag-0.liquid`):
```liquid
{% comment %}...auto-generated{% endcomment %}
{% if path == "/src/modules/layout/theme/themeJsComponent.js" or path == "layout/theme/themeJsComponent.js" %}
  <script src="..." type="module" crossorigin="anonymous"></script>
{% elsif path == "..." %}
  ...
{% endif %}
```

### Configuration

```js
shopify({
  // Default: 200KB (leaves ~56KB headroom below Shopify's 256KB limit)
  snippetMaxSize: 200 * 1024,

  // Or set a lower threshold for extra safety
  snippetMaxSize: 150 * 1024,

  // Set to 0 to disable splitting (not recommended)
  snippetMaxSize: 0,
})
```

If the snippet is under the limit, a single `vite-tag.liquid` is generated as normal — no sub-snippets are created.

Stale sub-snippets from previous builds are automatically cleaned up on each build and dev server start.

### No changes to your Liquid templates

The `{% render 'vite-tag', entry: '...' %}` call in your theme layout stays exactly the same regardless of whether splitting is active.

---

## Options reference

| Option | Type | Default | Description |
|---|---|---|---|
| `themeRoot` | `string` | `'./'` | Root path to your Shopify theme directory |
| `sourceCodeDir` | `string` | `'frontend'` | Front-end source code directory |
| `entrypointsDir` | `string` | `'frontend/entrypoints'` | Front-end entry points directory |
| `additionalEntrypoints` | `string[]` | `[]` | Additional entry point file paths or glob patterns |
| `snippetFile` | `string` | `'vite-tag.liquid'` | Filename of the generated snippet |
| `versionNumbers` | `boolean` | `false` | Append version numbers to asset URLs |
| `tunnel` | `boolean \| string` | `false` | Enable Cloudflare tunnel for dev previews |
| `themeHotReload` | `boolean` | `true` | Enable `@shopify/theme-hot-reload` script |
| `excludeExtensions` | `string[]` | `[]` | File extensions to exclude from entry generation |
| `excludePaths` | `string[]` | `[]` | Path patterns to exclude from entry generation |
| `assetLoading` | `AssetLoadingRule[]` | `[]` | Per-file loading strategy overrides |
| `snippetMaxSize` | `number` | `204800` (200KB) | Max bytes per snippet file before auto-splitting |

### `AssetLoadingRule`

| Property | Type | Description |
|---|---|---|
| `match` | `string \| RegExp` | Pattern to match against output filename (supports RegExp, glob `*`, or exact string) |
| `strategy` | `'defer' \| 'async' \| 'preload' \| 'lazy'` | Loading strategy to apply |

---

## Example

See the [vite-shopify-example](https://github.com/barrel/barrel-shopify/tree/main/examples/vite-shopify-example) theme for a basic demonstration of `vite-plugin-shopify` usage.

## Bugs

Please create an issue if you found any bugs, to help us improve this project!

## Thanks

We would like to specifically thank the following projects, for inspiring us and helping guide the implementation for this plugin by example:

- [vite_ruby](https://github.com/ElMassimo/vite_ruby)
- [laravel-vite](https://github.com/innocenzi/laravel-vite)
- [Laravel Vite Plugin](https://github.com/laravel/vite-plugin)