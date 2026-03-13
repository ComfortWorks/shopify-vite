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

### Configuration

`assetLoading` accepts an array of rules. Each rule has a `match` pattern and a `strategy`. The **first matching rule wins** — subsequent matches are ignored.

```js
shopify({
  assetLoading: [
    { match: /^\d+\.min\.js$/,    strategy: 'defer' },
    { match: 'icons-*.min.js',    strategy: 'defer' },
    { match: /^\d+\.min\.css$/,   strategy: 'preload' },
    { match: 'icons-*.min.css',   strategy: 'preload' },
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

| Strategy | Output | Behaviour |
|---|---|---|
| *(default)* | `<script type="module">` | Standard ES module, render-blocking |
| `'defer'` | `<script defer>` | Downloaded in parallel, executed after HTML parsing |
| `'async'` | `<script async>` | Downloaded in parallel, executed as soon as available |

When `defer` or `async` is applied, associated preload hints are also adjusted from `<link rel="modulepreload">` to `<link rel="preload" as="script">` to match the non-module loading behaviour.

#### CSS strategies

| Strategy | Output | Behaviour |
|---|---|---|
| *(default)* | `stylesheet_tag` | Standard Shopify stylesheet tag, render-blocking |
| `'preload'` | `media="print" onload` swap | Non-render-blocking, swaps to `all` once loaded |
| `'defer'` | Same as `'preload'` | Alias for convenience |
| `'async'` | Same as `'preload'` | Alias for convenience |

The non-render-blocking CSS pattern uses `media="print"` with an `onload="this.media='all'"` swap, which is the most reliable technique across browsers. A `<noscript>` fallback is included for accessibility:

```html
<link rel="stylesheet" href="..." media="print" onload="this.media='all'" crossorigin="anonymous">
<noscript><link rel="stylesheet" href="..." crossorigin="anonymous"></noscript>
```

### Example: Optimising a Shopify theme with chunked icons

A typical setup where icon chunks and numbered Rollup chunks are deferred, while critical entry points load normally:

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
        // Defer all numbered chunk JS (Rollup code-split output)
        { match: /^\d+\.min\.js$/, strategy: 'defer' },

        // Defer all icon category chunks
        { match: 'icons-*.min.js', strategy: 'defer' },

        // Non-blocking CSS for numbered chunks
        { match: /^\d+\.min\.css$/, strategy: 'preload' },

        // Non-blocking CSS for icon chunks
        { match: 'icons-*.min.css', strategy: 'preload' },
      ]
    })
  ]
}
```

This ensures only critical entry points (e.g. `themeJsComponent.min.js`, `theme.min.css`) are render-blocking, while secondary chunks load without impacting FCP or LCP.

### Debugging

Enable debug logging to see which files are matched by `assetLoading` rules:

```bash
DEBUG=vite-plugin-shopify:html pnpm build
```

This outputs lines like:

```
[assetLoading] Matched 42.min.js via RegExp → defer
[assetLoading] Matched icons-shared.min.js via glob "icons-*.min.js" → defer
[assetLoading] Matched 42.min.css via RegExp → preload
```

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

### `AssetLoadingRule`

| Property | Type | Description |
|---|---|---|
| `match` | `string \| RegExp` | Pattern to match against output filename (supports RegExp, glob `*`, or exact string) |
| `strategy` | `'defer' \| 'async' \| 'preload'` | Loading strategy to apply |

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