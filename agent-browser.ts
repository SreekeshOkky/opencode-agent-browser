import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

const BIN = "agent-browser"

/** Minimum structural type for opencode's BunShell instance. */
export type Shell = (strings: TemplateStringsArray, ...expr: any[]) => ShellResult
export type ShellResult = Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> & {
  nothrow(): ShellResult
  quiet(): ShellResult
  cwd(dir: string): ShellResult
}

export type AgentBrowserPluginOptions = {
  /**
   * Install the agent-browser CLI (via `agent-browser install`) automatically
   * when it is missing on PATH. Defaults to `true`.
   */
  autoInstall?: boolean
  /**
   * Command used to install the agent-browser CLI when it is missing.
   * Defaults to `npm install -g agent-browser`.
   */
  installCommand?: string[]
  /**
   * Register the official agent-browser MCP server (typed `agent_browser_*`
   * tools) in opencode's config. Requires the CLI to be installed.
   * Defaults to `true`.
   */
  enableMcp?: boolean
  /**
   * MCP tools profile: `core`, `network`, `state`, `debug`, `tabs`, `react`,
   * `mobile`, `all`, or comma-separated profiles. Defaults to `all`.
   */
  mcpTools?: string
  /**
   * Default agent-browser session used by tools when no `session` argument is
   * passed. Defaults to agent-browser's own `default` session.
   */
  defaultSession?: string
}

type Opts = Required<Pick<AgentBrowserPluginOptions, "autoInstall" | "enableMcp" | "mcpTools">> &
  Pick<AgentBrowserPluginOptions, "installCommand" | "defaultSession">

const DEFAULTS: Opts = {
  autoInstall: true,
  enableMcp: true,
  mcpTools: "all",
  installCommand: ["npm", "install", "-g", "agent-browser"],
}

type RawResult = { code: number; out: string; err: string }

/** Run an arbitrary command; first array element is the executable. */
async function runRaw($: Shell, argv: (string | number)[], cwd?: string): Promise<RawResult> {
  try {
    const result = await $`${argv}`.nothrow().quiet().cwd(cwd ?? process.cwd())
    const out = String(result.stdout ?? "").toString()
    const err = String(result.stderr ?? "").toString()
    return { code: Number(result.exitCode ?? 0), out, err }
  } catch (error) {
    return {
      code: -1,
      out: "",
      err: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Run an `agent-browser` subcommand and render its result for tool output. */
async function runCli($: Shell, args: (string | number)[], cwd?: string): Promise<string> {
  const { code, out, err } = await runRaw($, [BIN, ...args], cwd)
  const body = out.trim() || err.trim()
  if (code !== 0) {
    const detail = body || "(no output)"
    return `agent-browser exited with code ${code}.\n${detail}`
  }
  return body || "(no output)"
}

async function binaryAvailable($: Shell): Promise<boolean> {
  try {
    const result = await $`command -v ${BIN}`.nothrow().quiet()
    return Boolean(String(result.stdout ?? "").trim())
  } catch {
    return false
  }
}

function boolOf(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (["true", "1", "yes"].includes(v)) return true
  if (["false", "0", "no"].includes(v)) return false
  return null
}

function installNotice(manual: string): string {
  return [
    `${BIN} is required by the agent-browser plugin but was not found on PATH.`,
    ``,
    `Install it once and restart opencode:`,
    `  npm install -g agent-browser`,
    `  agent-browser install   # downloads Chrome for Testing (first run only)`,
    ``,
    manual,
  ].join("\n")
}

export const BrowserTools: Plugin = async ({ client, $ }, options) => {
  const opts: Opts = { ...DEFAULTS, ...(options ?? {}) }
  const flags = (session?: string): (string | number)[] => {
    const name = session ?? opts.defaultSession
    return name ? ["--session", name] : []
  }

  let binaryReady = false
  let installStarted = false
  let installFinished = false

  const ensureBinary = async (): Promise<string | null> => {
    if (binaryReady) return null
    if (installFinished) {
      binaryReady = true
      return null
    }
    if (await binaryAvailable($)) {
      binaryReady = true
      return null
    }
    if (opts.autoInstall && !installStarted) {
      installStarted = true
      void (async () => {
        await client.app.log({
          body: {
            service: "agent-browser",
            level: "info",
            message: `agent-browser not found. Auto-installing: ${(opts.installCommand ?? []).join(" ")}`,
          },
        })
        const npm = await runRaw($, opts.installCommand ?? [])
        if (npm.code !== 0) {
          await client.app.log({
            body: {
              service: "agent-browser",
              level: "error",
              message: "agent-browser install failed",
              extra: { stderr: npm.err, stdout: npm.out },
            },
          })
          installFinished = true
          return
        }
        await client.app.log({
          body: { service: "agent-browser", level: "info", message: "agent-browser installed. Downloading Chrome (Chrome for Testing)..." },
        })
        const chrome = await runRaw($, [BIN, "install"])
        if (chrome.code !== 0) {
          await client.app.log({
            body: {
              service: "agent-browser",
              level: "error",
              message: "agent-browser install (Chrome) failed",
              extra: { stderr: chrome.err, stdout: chrome.out },
            },
          })
          installFinished = true
          return
        }
        binaryReady = true
        installFinished = true
        await client.app.log({
          body: { service: "agent-browser", level: "info", message: "agent-browser ready." },
        })
      })()
      return installNotice(`Auto-install of ${BIN} started in the background (${(opts.installCommand ?? []).join(" ")}). Retry this operation in a few seconds.`)
    }
    if (installStarted) {
      return installNotice(`${BIN} is still being installed in the background. Retry this operation in a few seconds.`)
    }
    return installNotice(
      opts.autoInstall
        ? `autoInstall: true was unable to find ${BIN}. Please install it manually as above.`
        : `autoInstall is off; install ${BIN} manually as above.`,
    )
  }

  const workflowRules = [
    "## agent-browser workflow rules",
    "- After `browser_open` or any navigation or page change, always call `browser_snapshot` to get fresh `@eN` refs before clicking/filling.",
    "- Refs go stale whenever the page changes; reset them with a new `browser_snapshot` before the next interaction.",
    "- `browser_console` / `browser_errors` / cookie / storage / network tools return JSON; prefer them for assertions over guessing page output.",
    "- Prefer structured browser_* tools over running the agent-browser CLI directly via bash.",
    "- `browser_close` ends a browser session. It may destroy cookies/localStorage for that session, requiring a fresh login or state afterwards.",
    "",
  ].join("\n")

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(workflowRules)
    },

    config: async (cfg) => {
      if (!opts.enableMcp) return
      try {
        if (!(await binaryAvailable($))) return
      } catch {
        return
      }
      const mcp = cfg.mcp ?? (cfg.mcp = {})
      if ((mcp as Record<string, unknown>)["agent-browser"]) return
      ;(mcp as Record<string, unknown>)["agent-browser"] = {
        type: "local",
        command: ["agent-browser", "mcp", ...(opts.mcpTools ? ["--tools", opts.mcpTools] : [])],
        enabled: true,
      }
    },

    tool: {
      browser_open: tool({
        description:
          "Launch the agent-browser controlled browser and navigate to `url`. Omit `url` to just launch. " +
          "After navigation, call browser_snapshot to get element refs for the page. " +
          "A separate browser session is kept per `session` name.",
        args: {
          url: tool.schema.string().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const out = await runCli($, [...flags(args.session), "open", ...(args.url ? [args.url] : [])])
          return out
        },
      }),

      browser_read: tool({
        description:
          "Read a page as clean, agent-friendly text. Pass `url` to fetch an external page without the browser; " +
          "omit `url` to read the current active tab (includes auth state and client-side updates). " +
          "`filter` narrows output to sections containing the text.",
        args: {
          url: tool.schema.string().optional(),
          filter: tool.schema.string().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts: (string | number)[] = [...flags(args.session), "read"]
          if (args.url) parts.push(args.url)
          if (args.filter) parts.push("--filter", args.filter)
          return await runCli($, parts)
        },
      }),

      browser_snapshot: tool({
        description:
          "Get the accessibility tree of the current page with stable element refs like @e1, @e2. This is the primary " +
          "way to inspect and validate the page: pass an `@eN` ref (or a CSS selector) to browser_click, browser_fill, " +
          "browser_get_text, etc. Take a fresh snapshot whenever the page changes or after interactive steps.",
        args: {
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "snapshot"])
        },
      }),

      browser_wait: tool({
        description:
          "Wait for a UI condition before validating. Pass exactly one of: a CSS selector to wait until visible, " +
          "`timeoutMs` to pause, `url` (glob, e.g. \"/dashboard\") for URL change, or `text` for a substring to appear.",
        args: {
          selector: tool.schema.string().optional(),
          text: tool.schema.string().optional(),
          url: tool.schema.string().optional(),
          timeoutMs: tool.schema.number().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts: (string | number)[] = [...flags(args.session), "wait"]
          if (args.selector) parts.push(args.selector)
          else if (args.timeoutMs) parts.push(args.timeoutMs)
          else if (args.url) parts.push("--url", args.url)
          else if (args.text) parts.push("--text", args.text)
          else return "Provide one of: selector, timeoutMs, url, or text."
          return await runCli($, parts)
        },
      }),

      browser_click: tool({
        description:
          "Click an element by `@eN` ref from the last snapshot or by CSS selector. Fails early if another element " +
          "covers the target (e.g. a modal): dismiss the blocker, take a fresh snapshot, then retry.",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "click", args.selector])
        },
      }),

      browser_fill: tool({
        description:
          "Clear an input and fill it with `text`. Use `@eN` ref or CSS selector.",
        args: {
          selector: tool.schema.string(),
          text: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "fill", args.selector, args.text])
        },
      }),

      browser_type: tool({
        description: "Type `text` into a focused element (does not clear existing content). Use `@eN` ref or CSS selector.",
        args: {
          selector: tool.schema.string(),
          text: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "type", args.selector, args.text])
        },
      }),

      browser_press: tool({
        description: "Press a keyboard key in the active tab, e.g. Enter, Tab, Escape, ArrowDown, Control+a.",
        args: {
          key: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "press", args.key])
        },
      }),

      browser_select: tool({
        description: "Select a `<select>` dropdown option by value/option text. Use `@eN` ref or CSS selector.",
        args: {
          selector: tool.schema.string(),
          value: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "select", args.selector, args.value])
        },
      }),

      browser_set_checked: tool({
        description: "Check or uncheck a checkbox/radio. Use `@eN` ref or CSS selector.",
        args: {
          selector: tool.schema.string(),
          checked: tool.schema.boolean(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const action = args.checked ? "check" : "uncheck"
          return await runCli($, [...flags(args.session), action, args.selector])
        },
      }),

      browser_hover: tool({
        description: "Hover an element to expose menus/tooltips. Use `@eN` ref or CSS selector.",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "hover", args.selector])
        },
      }),

      browser_get_url: tool({
        description: "Return the current URL of the active page.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "url"])
        },
      }),

      browser_get_title: tool({
        description: "Return the document title of the active page.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "title"])
        },
      }),

      browser_get_text: tool({
        description: "Return the text content of an element (`@eN` ref or CSS selector).",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "text", args.selector])
        },
      }),

      browser_get_html: tool({
        description: "Return the innerHTML of an element (`@eN` ref or CSS selector).",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "html", args.selector])
        },
      }),

      browser_get_value: tool({
        description: "Return an input's current value (`@eN` ref or CSS selector). Handy to verify a form was filled.",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "value", args.selector])
        },
      }),

      browser_get_attribute: tool({
        description: "Return a single attribute of an element, e.g. href, src, aria-label (`@eN` ref or CSS selector).",
        args: {
          selector: tool.schema.string(),
          name: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "attr", args.selector, args.name])
        },
      }),

      browser_count: tool({
        description: "Count how many elements match a CSS selector. Great for UI assertions (e.g. \"3 nav links\").",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "get", "count", args.selector])
        },
      }),

      browser_state: tool({
        description:
          "Validate the rendered state of an element: visibility, enabledness, checkedness, and how many match. " +
          "Returns a JSON object. Use to assert a UI element is in the expected state before/after an action.",
        args: {
          selector: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const calls: Array<[string, string]> = [
            ["is", "visible"],
            ["is", "enabled"],
            ["is", "checked"],
            ["get", "count"],
          ]
          const results = await Promise.all(
            calls.map(([verb, noun]) => runRaw($, [BIN, ...flags(args.session), verb, noun, args.selector])),
          )
          const [visible, enabled, checked, count] = results
          const state: Record<string, unknown> = { selector: args.selector }
          const rawState: Record<string, string> = {}

          const track = (key: string, r: RawResult) => {
            const v = r.out.trim()
            if (v) rawState[key] = v
          }
          track("is visible", visible)
          track("is enabled", enabled)
          track("is checked", checked)
          track("get count", count)

          const vis = boolOf(rawState["is visible"] ?? "")
          const ena = boolOf(rawState["is enabled"] ?? "")
          const chk = boolOf(rawState["is checked"] ?? "")
          const cnt = /^-?\d+$/.test((rawState["get count"] ?? "").trim())
            ? Number(rawState["get count"].trim())
            : undefined

          if (vis !== null && ena !== null && chk !== null) {
            state.visible = vis
            state.enabled = ena
            state.checked = chk
          } else {
            state.raw = rawState
          }
          if (cnt !== undefined) state.count = cnt
          const failures = []
          for (const r of [visible, enabled, checked, count]) {
            if (r.code !== 0 && !r.out.trim() && r.err.trim()) failures.push(r.err.trim())
          }
          if (failures.length) state.errors = failures
          return JSON.stringify(state, null, 2)
        },
      }),

      browser_screenshot: tool({
        description:
          "Screenshot the current page and attach the image so it can be visually inspected. " +
          "`full` captures the whole page. The file is written to `path` (default screenshot.png in the current " +
          "project directory) and returned to you as a viewable image.",
        args: {
          path: tool.schema.string().optional(),
          full: tool.schema.boolean().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const guard = await ensureBinary()
          if (guard) return guard
          const cwd = context.directory
          const name = args.path || "screenshot.png"
          const parts: (string | number)[] = [...flags(args.session), "screenshot"]
          if (args.full) parts.push("--full")
          parts.push(name)
          const out = await runCli($, parts, cwd)
          const fullPath = path.isAbsolute(name) ? name : path.join(cwd, name)
          let attached = false
          try {
            const bytes = await readFile(fullPath)
            if (bytes.byteLength > 0 && bytes.byteLength < 20_000_000) {
              const mime = /\.jpe?g$/i.test(name)
                ? "image/jpeg"
                : /\.webp$/i.test(name)
                  ? "image/webp"
                  : "image/png"
              attached = true
              return {
                output: `${out}\nScreenshot: ${fullPath}`,
                attachments: [
                  {
                    type: "file",
                    mime,
                    url: `data:${mime};base64,${bytes.toString("base64")}`,
                    filename: name,
                  },
                ],
              }
            }
          } catch {
            // image unavailable for attachment; path is still returned in output
          }
          return attached ? out : `${out}${fullPath.endsWith(".png") ? `\n(Screenshot file not found at: ${fullPath})` : ""}`
        },
      }),

      browser_a11y: tool({
        description:
          "Run an axe-core accessibility audit against the current page (or after navigating to `url`) and report " +
          "violations (impact, rule, fix URL, failing selectors). Pass comma-separated `tags` like wcag2a,wcag2aa to " +
          "scope. Use to validate UI accessibility.",
        args: {
          url: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts: (string | number)[] = [...flags(args.session), "a11y"]
          if (args.tags) parts.push("--tags", args.tags)
          if (args.url) parts.push(args.url)
          return await runCli($, parts)
        },
      }),

      browser_console: tool({
        description: "List console messages (log/warn/error) from the active page. Use to validate there are no runtime warnings.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "console", "--json"])
        },
      }),

      browser_errors: tool({
        description: "List uncaught JavaScript errors from the active page. Use to validate a page renders without exceptions.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "errors", "--json"])
        },
      }),

      browser_cookies: tool({
        description: "Get cookies for the active page (JSON). Use to validate/confirm session or auth state.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "cookies", "get", "--json"])
        },
      }),

      browser_storage_local: tool({
        description: "Get localStorage of the active page (JSON).",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "storage", "local", "--json"])
        },
      }),

      browser_storage_session: tool({
        description: "Get sessionStorage of the active page (JSON).",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "storage", "session", "--json"])
        },
      }),

      browser_network_requests: tool({
        description: "List captured network requests for the active page (JSON). `filter` narrows by URL/type substring.",
        args: {
          filter: tool.schema.string().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts: (string | number)[] = [...flags(args.session), "network", "requests"]
          if (args.filter) parts.push("--filter", args.filter)
          parts.push("--json")
          return await runCli($, parts)
        },
      }),

      browser_network_route: tool({
        description:
          "Intercept network requests. Pass `pattern` (URL glob, e.g. \"*/api/*\") plus one of: `abort` to block, " +
          "or `body` to mock the response JSON. Use `browser_network_unroute` to stop.",
        args: {
          pattern: tool.schema.string(),
          abort: tool.schema.boolean().optional(),
          body: tool.schema.string().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts: (string | number)[] = [...flags(args.session), "network", "route", args.pattern]
          if (args.abort) parts.push("--abort")
          else if (args.body) parts.push("--body", args.body)
          else return "Provide either `abort: true` or a `body` to mock."
          return await runCli($, parts)
        },
      }),

      browser_network_unroute: tool({
        description: "Remove all network request routes previously added with browser_network_route.",
        args: { session: tool.schema.string().optional() },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "network", "unroute"])
        },
      }),

      browser_eval: tool({
        description:
          "Evaluate arbitrary JavaScript in the active page and return the result. Use for custom UI assertions " +
          "(e.g. check computed styles, DOM structure, or a widget's public state).",
        args: {
          js: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          return await runCli($, [...flags(args.session), "eval", args.js])
        },
      }),

      browser_close: tool({
        description: "Close the browser (and optionally all sessions), freeing resources when you are done validating.",
        args: {
          all: tool.schema.boolean().optional(),
          session: tool.schema.string().optional(),
        },
        async execute(args) {
          const guard = await ensureBinary()
          if (guard) return guard
          const parts = [...flags(args.session), "close"]
          if (args.all) parts.push("--all")
          return await runCli($, parts)
        },
      }),
    },
  }
}

export default BrowserTools