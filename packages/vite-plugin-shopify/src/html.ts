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
        if (globToRegExp(rule.match).test(fileName)) {
          debug(`[assetLoading] Matched ${fileName} via glob "${rule.match}" → ${rule.strategy}`)
          return rule.strategy
        }
      } else {
        if (fileName === rule.match) {
          debug(`[assetLoading] Matched ${fileName} via exact → ${rule.strategy}`)
          return rule.strategy
        }
      }
    }
  }
  return null
}

/**
 * Get the byte length of a string (UTF-8).
 *
 * @param {string} str
 * @returns {number}
 */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8')
}

/**
 * Split an array of asset tag blocks into groups that each fit
 * within the given byte budget when assembled into a liquid snippet.
 *
 * Each group is turned into its own complete if/elsif/endif block.
 *
 * @param {string[]} assetTags - Array of entry tag blocks
 * @param {number} maxBytes - Max byte size per sub-snippet
 * @param {string} disclaimer - Disclaimer comment to prepend to each sub-snippet
 * @returns {string[][]} Array of tag groups
 */
function splitAssetTagsIntoGroups(
  assetTags: string[],
  maxBytes: number,
  disclaimer: string
): string[][] {
  const groups: string[][] = []
  let currentGroup: string[] = []
  // Overhead per sub-snippet: disclaimer + {% endif %} + newlines
  const overhead = byteLength(disclaimer) + byteLength('\n{% endif %}\n') + 50

  let currentSize = overhead

  for (const tag of assetTags) {
    const tagSize = byteLength(tag) + 1 // +1 for newline separator

    if (currentGroup.length > 0 && (currentSize + tagSize) > maxBytes) {
      // Current group is full — start a new one
      groups.push(currentGroup)
      currentGroup = []
      currentSize = overhead
    }

    currentGroup.push(tag)
    currentSize += tagSize
  }

  // Push remaining
  if (currentGroup.length > 0) {
    groups.push(currentGroup)
  }

  return groups
}

/**
 * Convert a group of asset tag blocks into a complete liquid sub-snippet.
 *
 * The first tag in the group may start with `{% elsif` (from the main
 * generation loop), which needs to be rewritten to `{% if` since each
 * sub-snippet is its own independent conditional block.
 *
 * @param {string[]} tags - Asset tag blocks for this group
 * @param {string} disclaimer - Disclaimer comment
 * @returns {string} Complete liquid snippet content
 */
function assembleSubSnippet(tags: string[], disclaimer: string): string {
  const rewritten = tags.map((tag, index) => {
    if (index === 0) {
      // Ensure the first tag starts with {% if, not {% elsif
      return tag.replace(/^\{% elsif /, '{% if ')
    }
    return tag
  })

  return disclaimer + rewritten.join('\n') + '\n{% endif %}\n'
}

/**
 * Remove stale sub-snippet files from previous builds.
 *
 * Cleans up files matching `{baseName}-{n}.liquid` in the snippets directory.
 *
 * @param {string} snippetsDir - Path to the snippets directory
 * @param {string} baseName - Base snippet name (e.g. 'vite-tag')
 */
function cleanupStaleSubSnippets(snippetsDir: string, baseName: string): void {
  if (!fs.existsSync(snippetsDir)) return

  const files = fs.readdirSync(snippetsDir)
  const pattern = new RegExp(`^${baseName}-\\d+\\.liquid$`)

  files.forEach((file) => {
    if (pattern.test(file)) {
      const filePath = path.resolve(snippetsDir, file)
      fs.unlinkSync(filePath)
      debug(`[snippet-chunking] Deleted stale sub-snippet: ${file}`)
    }
  })
}

// Plugin for generating vite-tag liquid theme snippet with entry points for JS and CSS assets
export default function shopifyHTML (options: Required<Options>): Plugin {
  let config: ResolvedConfig
  let viteDevServerUrl: DevServerUrl
  let tunnelClient: TunnelClient | undefined
  let tunnelUrl: string | undefined

  const viteTagSnippetPath = path.resolve(options.themeRoot, `snippets/${options.snippetFile}`)
  const viteTagSnippetName = options.snippetFile.replace(/\.[^.]+$/, '')
  const snippetsDir = path.resolve(options.themeRoot, 'snippets')
  const viteTagSnippetPrefix = (config: ResolvedConfig): string =>
    viteTagDisclaimer + viteTagEntryPath(config.resolve.alias, options.entrypointsDir, viteTagSnippetName)

  return {
    name: 'vite-plugin-shopify-html',
    enforce: 'post',
    configResolved (resolvedConfig) {
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

              fs.writeFileSync(viteTagSnippetPath, viteTagSnippetContent)
            })()
          }, 100)

          const viteTagSnippetContent = viteTagSnippetPrefix(config) + viteTagSnippetDev(
            frontendUrl !== ''
              ? frontendUrl
              : viteDevServerUrl, options.entrypointsDir, reactPlugin, options.themeHotReload
          )

          // Clean up any stale sub-snippets from previous production builds
          cleanupStaleSubSnippets(snippetsDir, viteTagSnippetName)

          fs.writeFileSync(viteTagSnippetPath, viteTagSnippetContent)
        }
      })

      httpServer?.on('close', () => {
        tunnelClient?.stopTunnel()
      })

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
      debug('Snippet max size:', options.snippetMaxSize)

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

        if (isEntry === true) {
          const entryName = normalizePath(path.relative(options.entrypointsDir, src))
          const entryPaths = [`/${src}`, entryName]
          const tagsForEntry: string[] = []

          if (ext.match(CSS_EXTENSIONS_REGEX) !== null) {
            const strategy = matchAssetLoadingRule(file, options.assetLoading)
            tagsForEntry.push(stylesheetTag(file, options.versionNumbers, strategy))
          } else {
            const jsStrategy = matchAssetLoadingRule(file, options.assetLoading)
            const jsTag = scriptTag(file, options.versionNumbers, jsStrategy)
            if (jsTag !== '') {
              tagsForEntry.push(jsTag)
            }

            if (typeof imports !== 'undefined' && imports.length > 0) {
              imports.forEach((importFilename: string) => {
                const chunk = manifest[importFilename]
                const { css: chunkCss } = chunk

                if (config.build.modulePreload !== false) {
                  tagsForEntry.push(preloadScriptTag(chunk.file, options.versionNumbers))
                }

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

        if (src === 'style.css' && !config.build.cssCodeSplit) {
          const strategy = matchAssetLoadingRule(file, options.assetLoading)
          assetTags.push(viteEntryTag([src], stylesheetTag(file, options.versionNumbers, strategy), false))
        }
      })

      // ── Clean up stale sub-snippets from previous builds ─────────────────
      cleanupStaleSubSnippets(snippetsDir, viteTagSnippetName)

      // ── Build the full snippet content ───────────────────────────────────
      const prefix = viteTagSnippetPrefix(config)
      const fullContent = prefix + assetTags.join('\n') + '\n{% endif %}\n'
      const fullSize = byteLength(fullContent)

      // ── Check if splitting is needed ─────────────────────────────────────
      if (options.snippetMaxSize > 0 && fullSize > options.snippetMaxSize) {
        debug(`[snippet-chunking] Snippet size ${(fullSize / 1024).toFixed(1)}KB exceeds limit ${(options.snippetMaxSize / 1024).toFixed(1)}KB — splitting`)

        // Calculate byte budget per sub-snippet
        // Leave room for the main snippet's render tags
        const subSnippetMaxSize = options.snippetMaxSize - 512 // 512B headroom

        const groups = splitAssetTagsIntoGroups(assetTags, subSnippetMaxSize, viteTagSubSnippetDisclaimer)

        // Write each sub-snippet
        groups.forEach((group, index) => {
          const subSnippetName = `${viteTagSnippetName}-${index}`
          const subSnippetPath = path.resolve(snippetsDir, `${subSnippetName}.liquid`)
          const subSnippetContent = assembleSubSnippet(group, viteTagSubSnippetDisclaimer)

          fs.writeFileSync(subSnippetPath, subSnippetContent)

          const subSize = byteLength(subSnippetContent)
          debug(`[snippet-chunking] Wrote ${subSnippetName}.liquid (${(subSize / 1024).toFixed(1)}KB, ${group.length} entries)`)
        })

        // Build the main delegator snippet
        const renderTags = groups.map((_, index) => {
          const subSnippetName = `${viteTagSnippetName}-${index}`
          return `{% render '${subSnippetName}', path: path, preload_stylesheet: preload_stylesheet %}`
        }).join('\n')

        const mainContent = prefix + renderTags + '\n'

        fs.writeFileSync(viteTagSnippetPath, mainContent)

        const mainSize = byteLength(mainContent)
        console.log(
          `[snippet-chunking] Split vite-tag into ${groups.length} sub-snippets ` +
          `(main: ${(mainSize / 1024).toFixed(1)}KB, ` +
          `original would have been: ${(fullSize / 1024).toFixed(1)}KB)`
        )
      } else {
        // Single file — no splitting needed
        fs.writeFileSync(viteTagSnippetPath, fullContent)

        debug(`[snippet-chunking] Snippet size ${(fullSize / 1024).toFixed(1)}KB — within limit, no split needed`)
      }
    }
  }
}

const viteTagDisclaimer = '{% comment %}\n  IMPORTANT: This snippet is automatically generated by vite-plugin-shopify.\n  Do not attempt to modify this file directly, as any changes will be overwritten by the next build.\n{% endcomment %}\n'

const viteTagSubSnippetDisclaimer = '{% comment %}\n  Auto-generated sub-snippet. Do not edit — overwritten on every build.\n  See the main vite-tag.liquid for usage.\n{% endcomment %}\n'

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

  const paramName = 'entry'

  const replaceChain = replacements
    .map(([from, to]) => `replace: '${from}/', '${to}/'`)
    .join(' | ')

  return `{% liquid
  assign ${paramName} = ${paramName} | default: ${snippetName}
  assign path = ${paramName}${replaceChain ? ' | ' + replaceChain : ''}
%}
`
}

const assetUrl = (fileName: string, versionNumbers: boolean): string => {
  if (!versionNumbers) {
    return `'${fileName}' | asset_url | split: '?' | first`
  }
  return `'${fileName}' | asset_url`
}

const viteEntryTag = (entryPaths: string[], tag: string, isFirstEntry = false): string =>
  `{% ${!isFirstEntry ? 'els' : ''}if ${entryPaths.map((entryName) => `path == "${entryName}"`).join(' or ')} %}\n  ${tag}`

/**
 * Generate a modulepreload link tag for a script asset.
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
 * - null (default) → `<script type="module">`
 * - 'defer'        → Same as default (ES modules are deferred by spec)
 * - 'async'        → `<script type="module" async>`
 * - 'lazy'         → Returns empty string (no script tag)
 */
const scriptTag = (
  fileName: string,
  versionNumbers: boolean,
  strategy: AssetLoadingRule['strategy'] | null = null
): string => {
  const url = `{{ ${assetUrl(fileName, versionNumbers)} }}`

  switch (strategy) {
    case 'lazy':
      return ''
    case 'async':
      return `<script src="${url}" type="module" async crossorigin="anonymous"></script>`
    case 'defer':
    default:
      return `<script src="${url}" type="module" crossorigin="anonymous"></script>`
  }
}

/**
 * Generate a production stylesheet tag for a CSS asset.
 *
 * - null (default)                       → Blocking stylesheet_tag
 * - 'preload', 'defer', 'lazy', 'async' → Non-render-blocking media swap
 */
const stylesheetTag = (
  fileName: string,
  versionNumbers: boolean,
  strategy: AssetLoadingRule['strategy'] | null = null
): string => {
  if (strategy === 'preload' || strategy === 'defer' || strategy === 'async' || strategy === 'lazy') {
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
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error-next-line
    address.family === 6
}

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