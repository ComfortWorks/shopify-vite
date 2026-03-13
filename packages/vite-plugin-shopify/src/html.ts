import fs from 'node:fs'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { Manifest, Plugin, ResolvedConfig, normalizePath } from 'vite'
import createDebugger from 'debug'
import startTunnel from '@shopify/plugin-cloudflare/hooks/tunnel'
import { renderInfo, isTTY } from '@shopify/cli-kit/node/ui'

import { CSS_EXTENSIONS_REGEX, KNOWN_CSS_EXTENSIONS, hotReloadScriptId, hotReloadScriptUrl } from './constants'
import type { Options, AssetLoadingRule, DevServerUrl, FrontendURLResult } from './types'
import type { TunnelClient } from '@shopify/cli-kit/node/plugins/tunnel'

const debug = createDebugger('vite-plugin-shopify:html')

function shouldExcludeEntry(src: string, excludeExtensions: string[], excludePaths: string[]): boolean {
  // Normalize the source path
  const normalizedSrc = normalizePath(src);
  
  // Check if extension matches any excluded extension
  if (excludeExtensions.length > 0) {
    const ext = path.extname(normalizedSrc);
    if (excludeExtensions.some(excludedExt => {
      // Ensure extension starts with a dot
      const normalizedExcludedExt = excludedExt.startsWith('.') ? excludedExt : `.${excludedExt}`;
      return ext === normalizedExcludedExt;
    })) {
      return true;
    }
  }
  
  // Check if path matches any excluded path pattern
  if (excludePaths.length > 0) {
    if (excludePaths.some(excludedPath => {
      const normalizedExcludedPath = normalizePath(excludedPath);
      return normalizedSrc.includes(normalizedExcludedPath);
    })) {
      return true;
    }
  }
  
  return false;
}

/**
 * Convert a glob-style pattern string to a RegExp.
 * Supports `*` as a wildcard for any characters (except path separators).
 *
 * @param {string} pattern - Glob pattern (e.g. 'icons-*.min.js')
 * @returns {RegExp}
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\*/g, '[^/]*')                // Replace * with non-greedy wildcard
  return new RegExp(`^${escaped}$`)
}

/**
 * Match an output filename against the assetLoading rules.
 * Returns the strategy of the first matching rule, or null if no rule matches.
 *
 * Matching order:
 * 1. RegExp — tested directly against the filename
 * 2. String with `*` — converted to glob-style regex
 * 3. Plain string — exact filename match
 *
 * @param {string} fileName - Output asset filename (e.g. 'icons-shared.min.js')
 * @param {AssetLoadingRule[]} rules - Array of loading rules from options
 * @returns {string|null} The matched strategy or null
 */
function matchAssetLoadingRule(
  fileName: string,
  rules: AssetLoadingRule[]
): AssetLoadingRule['strategy'] | null {
  for (const rule of rules) {
    if (rule.match instanceof RegExp) {
      if (rule.match.test(fileName)) {
        debug(`[assetLoading] Matched ${fileName} via RegExp → ${rule.strategy}`)
        return rule.strategy
      }
    } else if (typeof rule.match === 'string') {
      if (rule.match.includes('*')) {
        // Glob-style wildcard match
        if (globToRegExp(rule.match).test(fileName)) {
          debug(`[assetLoading] Matched ${fileName} via glob "${rule.match}" → ${rule.strategy}`)
          return rule.strategy
        }
      } else {
        // Exact filename match
        if (fileName === rule.match) {
          debug(`[assetLoading] Matched ${fileName} via exact → ${rule.strategy}`)
          return rule.strategy
        }
      }
    }
  }
  return null
}

// Plugin for generating vite-tag liquid theme snippet with entry points for JS and CSS assets
export default function shopifyHTML (options: Required<Options>): Plugin {
  let config: ResolvedConfig
  let viteDevServerUrl: DevServerUrl
  let tunnelClient: TunnelClient | undefined
  let tunnelUrl: string | undefined

  const viteTagSnippetPath = path.resolve(options.themeRoot, `snippets/${options.snippetFile}`)
  const viteTagSnippetName = options.snippetFile.replace(/\.[^.]+$/, '')
  const viteTagSnippetPrefix = (config: ResolvedConfig): string =>
    viteTagDisclaimer + viteTagEntryPath(config.resolve.alias, options.entrypointsDir, viteTagSnippetName)

  return {
    name: 'vite-plugin-shopify-html',
    enforce: 'post',
    configResolved (resolvedConfig) {
      // Store reference to resolved config
      config = resolvedConfig
    },
    transform (code) {
      if (config.command === 'serve') {
        return code.replace(/__shopify_vite_placeholder__/g, tunnelUrl ?? viteDevServerUrl)
      }
    },
    configureServer ({ config, middlewares, httpServer }) {
      const { frontendUrl, frontendPort, usingLocalhost } = generateFrontendURL(options)

      httpServer?.once('listening', () => {
        const address = httpServer?.address()

        const isAddressInfo = (x: string | AddressInfo | null | undefined): x is AddressInfo => typeof x === 'object'

        if (isAddressInfo(address)) {
          viteDevServerUrl = resolveDevServerUrl(address, config)
          const reactPlugin = config.plugins.find(plugin =>
            plugin.name === 'vite:react-babel' || plugin.name === 'vite:react-refresh'
          )

          debug({ address, viteDevServerUrl, frontendUrl, frontendPort, usingLocalhost })

          setTimeout(() => {
            void (async (): Promise<void> => {
              if (options.tunnel === false) {
                return
              }

              if (frontendUrl !== '') {
                tunnelUrl = frontendUrl
                isTTY() && renderInfo({ body: `${viteDevServerUrl} is tunneled to ${tunnelUrl}` })
                return
              }

              const hook = await startTunnel({
                config: null,
                provider: 'cloudflare',
                port: address.port
              })
              tunnelClient = hook.valueOrAbort()
              tunnelUrl = await pollTunnelUrl(tunnelClient)
              isTTY() && renderInfo({ body: `${viteDevServerUrl} is tunneled to ${tunnelUrl}` })
              const viteTagSnippetContent = viteTagSnippetPrefix(config) + viteTagSnippetDev(
                tunnelUrl, options.entrypointsDir, reactPlugin, options.themeHotReload
              )

              // Write vite-tag with a Cloudflare Tunnel URL
              fs.writeFileSync(viteTagSnippetPath, viteTagSnippetContent)
            })()
          }, 100)

          const viteTagSnippetContent = viteTagSnippetPrefix(config) + viteTagSnippetDev(
            frontendUrl !== ''
              ? frontendUrl
              : viteDevServerUrl, options.entrypointsDir, reactPlugin, options.themeHotReload
          )

          // Write vite-tag snippet for development server
          fs.writeFileSync(viteTagSnippetPath, viteTagSnippetContent)
        }
      })

      httpServer?.on('close', () => {
        tunnelClient?.stopTunnel()
      })

      // Serve the dev-server-index.html page
      return () => middlewares.use((req, res, next) => {
        if (req.url === '/index.html') {
          res.statusCode = 404

          res.end(
            fs.readFileSync(path.join(__dirname, 'dev-server-index.html')).toString()
          )
        }

        next()
      })
    },
    closeBundle () {
      if (config.command === 'serve') {
        return
      }

      const manifestOption = config.build?.manifest
      const manifestFilePath = path.resolve(
        options.themeRoot,
        `assets/${typeof manifestOption === 'string' ? manifestOption : '.vite/manifest.json'}`
      )

      if (!fs.existsSync(manifestFilePath)) {
        return
      }

      debug('Processing manifest with exclusions:', {
        excludeExtensions: options.excludeExtensions,
        excludePaths: options.excludePaths
      })

      debug('Asset loading rules:', options.assetLoading)

      const assetTags: string[] = []
      const manifest = JSON.parse(
        fs.readFileSync(manifestFilePath, 'utf8')
      ) as Manifest

      Object.keys(manifest).forEach((src) => {
        const { file, isEntry, css, imports } = manifest[src]

        if (shouldExcludeEntry(src, options.excludeExtensions, options.excludePaths)) {
          debug(`Excluding entry: ${src}`)
          return
        }
        
        const ext = path.extname(src)

        // Generate tags for JS and CSS entry points
        if (isEntry === true) {
          const entryName = normalizePath(path.relative(options.entrypointsDir, src))
          const entryPaths = [`/${src}`, entryName]
          const tagsForEntry: string[] = []

          if (ext.match(CSS_EXTENSIONS_REGEX) !== null) {
            // Render style tag for CSS entry — check for loading strategy override
            const strategy = matchAssetLoadingRule(file, options.assetLoading)
            tagsForEntry.push(stylesheetTag(file, options.versionNumbers, strategy))
          } else {
            // Render script tag for JS entry — check for loading strategy override
            const jsStrategy = matchAssetLoadingRule(file, options.assetLoading)
            const jsTag = scriptTag(file, options.versionNumbers, jsStrategy)
            if (jsTag !== '') {
              tagsForEntry.push(jsTag)
            }

            if (typeof imports !== 'undefined' && imports.length > 0) {
              imports.forEach((importFilename: string) => {
                const chunk = manifest[importFilename]
                const { css: chunkCss } = chunk

                // Check loading strategy for the imported chunk
                const chunkStrategy = matchAssetLoadingRule(chunk.file, options.assetLoading)

                if (config.build.modulePreload !== false) {
                  // Render modulepreload hint for JS imports
                  tagsForEntry.push(preloadScriptTag(chunk.file, options.versionNumbers))
                }

                // Render style tag for JS imports
                if (typeof chunkCss !== 'undefined' && chunkCss.length > 0) {
                  chunkCss.forEach((cssFileName: string) => {
                    const cssStrategy = matchAssetLoadingRule(cssFileName, options.assetLoading)
                    tagsForEntry.push(stylesheetTag(cssFileName, options.versionNumbers, cssStrategy))
                  })
                }
              })
            }

            if (typeof css !== 'undefined' && css.length > 0) {
              css.forEach((cssFileName: string) => {
                const cssStrategy = matchAssetLoadingRule(cssFileName, options.assetLoading)
                tagsForEntry.push(stylesheetTag(cssFileName, options.versionNumbers, cssStrategy))
              })
            }
          }

          assetTags.push(viteEntryTag(entryPaths, tagsForEntry.join('\n  '), assetTags.length === 0))
        }

        // Generate entry tag for bundled "style.css" file when cssCodeSplit is false
        if (src === 'style.css' && !config.build.cssCodeSplit) {
          const strategy = matchAssetLoadingRule(file, options.assetLoading)
          assetTags.push(viteEntryTag([src], stylesheetTag(file, options.versionNumbers, strategy), false))
        }
      })

      const viteTagSnippetContent = viteTagSnippetPrefix(config) + assetTags.join('\n') + '\n{% endif %}\n'

      // Write vite-tag snippet for production build
      fs.writeFileSync(viteTagSnippetPath, viteTagSnippetContent)
    }
  }
}

const viteTagDisclaimer = '{% comment %}\n  IMPORTANT: This snippet is automatically generated by vite-plugin-shopify.\n  Do not attempt to modify this file directly, as any changes will be overwritten by the next build.\n{% endcomment %}\n'

// Generate liquid variable with resolved path by replacing aliases
const viteTagEntryPath = (
  resolveAlias: Array<{ find: string | RegExp, replacement: string }>,
  entrypointsDir: string,
  snippetName: string
): string => {
  const replacements: Array<[string, string]> = []

  resolveAlias.forEach((alias) => {
    if (typeof alias.find === 'string') {
      replacements.push([alias.find, normalizePath(path.relative(entrypointsDir, alias.replacement))])
    }
  })

  // Support both 'entry' (new, strict parser) and snippetName (old, backward compat)
  const paramName = 'entry' // Fixed semantic name for new syntax

  const replaceChain = replacements
    .map(([from, to]) => `replace: '${from}/', '${to}/'`)
    .join(' | ')

  // Generate liquid that uses default filter for backward compatibility
  return `{% liquid
  assign ${paramName} = ${paramName} | default: ${snippetName}
  assign path = ${paramName}${replaceChain ? ' | ' + replaceChain : ''}
%}
`
}

// Generate the asset's url with or without version numbers
const assetUrl = (fileName: string, versionNumbers: boolean): string => {
  if (!versionNumbers) {
    return `'${fileName}' | asset_url | split: '?' | first`
  }
  return `'${fileName}' | asset_url`
}

// Generate conditional statement for entry tag
const viteEntryTag = (entryPaths: string[], tag: string, isFirstEntry = false): string =>
  `{% ${!isFirstEntry ? 'els' : ''}if ${entryPaths.map((entryName) => `path == "${entryName}"`).join(' or ')} %}\n  ${tag}`

/**
 * Generate a modulepreload link tag for a script asset.
 *
 * All Vite/Rollup output is ES module format, so modulepreload is always
 * the correct hint type regardless of loading strategy.
 *
 * @param {string} fileName - Output asset filename
 * @param {boolean} versionNumbers - Whether to append version numbers
 * @returns {string} Liquid/HTML tag string
 */
const preloadScriptTag = (
  fileName: string,
  versionNumbers: boolean
): string => {
  return `<link rel="modulepreload" href="{{ ${assetUrl(fileName, versionNumbers)} }}" crossorigin="anonymous">`
}

/**
 * Generate a production script tag for a JS asset.
 *
 * All Vite/Rollup output uses ES module syntax (import/export),
 * so `type="module"` is always required. ES module scripts are
 * deferred by spec, so `defer` is a no-op — kept as an alias
 * for semantic clarity in config.
 *
 * Supported strategies:
 * - null (default) → `<script type="module">` (standard, deferred by spec)
 * - 'defer'        → Same as default (ES modules are already deferred)
 * - 'async'        → `<script type="module" async>` (non-blocking, runs ASAP)
 * - 'lazy'         → Returns empty string. No `<script>` tag emitted.
 *                     The chunk is only fetched via `<link rel="modulepreload">`
 *                     and executes when dynamically imported at runtime.
 *
 * @param {string} fileName - Output asset filename
 * @param {boolean} versionNumbers - Whether to append version numbers
 * @param {string|null} strategy - Loading strategy override
 * @returns {string} Liquid/HTML tag string, or empty string for 'lazy'
 */
const scriptTag = (
  fileName: string,
  versionNumbers: boolean,
  strategy: AssetLoadingRule['strategy'] | null = null
): string => {
  const url = `{{ ${assetUrl(fileName, versionNumbers)} }}`

  switch (strategy) {
    case 'lazy':
      // No script tag — chunk is modulepreloaded and executes
      // only when dynamically imported by its consuming section
      return ''
    case 'async':
      return `<script src="${url}" type="module" async crossorigin="anonymous"></script>`
    case 'defer':
    default:
      // ES modules are deferred by spec — no extra attribute needed
      return `<script src="${url}" type="module" crossorigin="anonymous"></script>`
  }
}

/**
 * Generate a production stylesheet tag for a CSS asset.
 *
 * Supports loading strategy overrides:
 * - null (default)                       → Blocking `stylesheet_tag` (Shopify default)
 * - 'preload', 'defer', 'lazy', 'async' → Non-render-blocking via
 *                                          `media="print"` + `onload` swap.
 *                                          Includes `<noscript>` fallback for accessibility.
 *
 * The `media="print" onload` technique is the most reliable non-blocking
 * CSS pattern across browsers and works within Shopify's Liquid environment
 * without requiring inline JavaScript.
 *
 * @param {string} fileName - Output asset filename
 * @param {boolean} versionNumbers - Whether to append version numbers
 * @param {string|null} strategy - Loading strategy override
 * @returns {string} Liquid/HTML tag string
 */
const stylesheetTag = (
  fileName: string,
  versionNumbers: boolean,
  strategy: AssetLoadingRule['strategy'] | null = null
): string => {
  if (strategy === 'preload' || strategy === 'defer' || strategy === 'async' || strategy === 'lazy') {
    // Non-render-blocking CSS via media="print" onload swap
    // See: https://web.dev/defer-non-critical-css/
    const url = `{{ ${assetUrl(fileName, versionNumbers)} }}`
    return (
      `<link rel="stylesheet" href="${url}" media="print" onload="this.media='all'" crossorigin="anonymous">` +
      `\n  <noscript><link rel="stylesheet" href="${url}" crossorigin="anonymous"></noscript>`
    )
  }
  return `{{ ${assetUrl(fileName, versionNumbers)} | stylesheet_tag: preload: preload_stylesheet }}`
}

// Generate vite-tag snippet for development
const viteTagSnippetDev = (assetHost: string, entrypointsDir: string, reactPlugin: Plugin | undefined, themeHotReload: boolean): string =>
  `{% liquid
  assign path_prefix = path | slice: 0
  if path_prefix == '/'
    assign file_url_prefix = '${assetHost}'
  else
    assign file_url_prefix = '${assetHost}/${entrypointsDir}/'
  endif
  assign file_url = path | prepend: file_url_prefix
  assign file_name = path | split: '/' | last
  if file_name contains '.'
    assign file_extension = file_name | split: '.' | last
  endif
  assign css_extensions = '${KNOWN_CSS_EXTENSIONS.join('|')}' | split: '|'
  assign is_css = false
  if css_extensions contains file_extension
    assign is_css = true
  endif
%}${reactPlugin === undefined
    ? ''
    : `
<script src="${assetHost}/@id/__x00__vite-plugin-shopify:react-refresh" type="module"></script>`}
<script src="${assetHost}/@vite/client" type="module"></script>${!themeHotReload
  ? ''
  : `
<script id="${hotReloadScriptId}" src="${hotReloadScriptUrl}" type="module"></script>`}
{% if is_css == true %}
  <link rel="stylesheet" href="{{ file_url }}" crossorigin="anonymous">
{% else %}
  <script src="{{ file_url }}" type="module"></script>
{% endif %}
`

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl (address: AddressInfo, config: ResolvedConfig): DevServerUrl {
  const configHmrProtocol = typeof config.server.hmr === 'object' ? config.server.hmr.protocol : null
  const clientProtocol = configHmrProtocol ? (configHmrProtocol === 'wss' ? 'https' : 'http') : null
  const serverProtocol = config.server.https ? 'https' : 'http'
  const protocol = clientProtocol ?? serverProtocol

  const configHmrHost = typeof config.server.hmr === 'object' ? config.server.hmr.host : null
  const configHost = typeof config.server.host === 'string' ? config.server.host : null
  const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address
  const host = configHmrHost ?? configHost ?? serverAddress

  const configHmrClientPort = typeof config.server.hmr === 'object' ? config.server.hmr.clientPort : null
  const port = configHmrClientPort ?? address.port

  return `${protocol}://${host}:${port}`
}

function isIpv6 (address: AddressInfo): boolean {
  return address.family === 'IPv6' ||
    // In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
    // See: https://github.com/laravel/vite-plugin/issues/103
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error-next-line
    address.family === 6
}

/**
 * The tunnel creation logic depends on the tunnel option:
 * - If tunnel is false, uses localhost
 * - If tunnel is a string (custom URL), uses that URL
 * - If tunnel is true, a tunnel is created (by default using cloudflare)
 */
function generateFrontendURL (options: Required<Options>): FrontendURLResult {
  const frontendPort = -1
  let frontendUrl = ''
  let usingLocalhost = false

  if (options.tunnel === false) {
    usingLocalhost = true
    return { frontendUrl, frontendPort, usingLocalhost }
  }

  if (options.tunnel === true) {
    return { frontendUrl, frontendPort, usingLocalhost }
  }

  frontendUrl = options.tunnel
  return { frontendUrl, frontendPort, usingLocalhost }
}

/**
 * Poll the tunnel provider every 0.5 until an URL or error is returned.
 */
async function pollTunnelUrl (tunnelClient: TunnelClient): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let retries = 0
    const pollTunnelStatus = async (): Promise<void> => {
      const result = tunnelClient.getTunnelStatus()
      debug(`Polling tunnel status for ${tunnelClient.provider} (attempt ${retries}): ${result.status}`)
      if (result.status === 'error') {
        return reject(result.message)
      }
      if (result.status === 'connected') {
        resolve(result.url)
      } else {
        retries += 1
        startPolling()
      }
    }

    const startPolling = (): void => {
      setTimeout(() => {
        void pollTunnelStatus()
      }, 500)
    }

    void pollTunnelStatus()
  })
}