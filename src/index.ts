import { Plugin } from "@opencode/plugin"

import {
  clampCount,
  fetchPage,
  formatHits,
  mapResults,
  searchHits,
  type CallDeps,
  type SearchHit,
} from "./deepseek.ts"

/**
 * DeepSeek Search & Fetch for OpenCode V2.
 *
 * Registers:
 *  - a websearch provider (`deepseek`) behind the built-in `websearch` tool,
 *  - `deepseek_search`, which can also pass `ori_question` and per-call options,
 *  - `deepseek_fetch`, which turns a URL into Markdown through the Fetch API.
 */

export type Options = {
  /** Results per search, 1..50. Default 8. */
  count?: number
  /** Ask DeepSeek for full page content instead of the model-facing summary. Default false. */
  needContent?: boolean
  /** Truncate result text handed to the model. Default 4000 characters. */
  maxContentChars?: number
  /** Truncate Markdown returned by `deepseek_fetch`. Default 30000 characters. */
  maxFetchChars?: number
  /** Optional IP address that DeepSeek uses to localize results. */
  localization?: string
  /** API key override. Falls back to DEEPSEEK_API_KEY, then the stored DeepSeek credential. */
  apiKey?: string
  /** API origin override, mostly for tests and proxies. Default https://api.deepseek.com */
  baseUrl?: string
}

type Contextish = {
  options: Record<string, unknown>
  integration: {
    connection: {
      active(integrationID: string): Promise<unknown>
      resolve(connection: unknown): Promise<unknown>
    }
  }
}

export type SearchInput = {
  query: string
  ori_question?: string
  count?: number
  need_content?: boolean
  localization?: string
}

export type FetchInput = {
  url: string
  max_chars?: number
}

export async function resolveApiKey(ctx: Contextish, options: Options): Promise<string> {
  if (typeof options.apiKey === "string" && options.apiKey.trim()) return options.apiKey.trim()

  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv) return fromEnv

  try {
    const connection = await ctx.integration.connection.active("deepseek")
    if (connection) {
      const credential = (await ctx.integration.connection.resolve(connection)) as
        | { type?: string; key?: string }
        | undefined
      if (credential?.type === "key" && typeof credential.key === "string" && credential.key) {
        return credential.key
      }
    }
  } catch {
    // fall through to the error below
  }

  throw new Error(
    "DeepSeek: no API key. Set DEEPSEEK_API_KEY, pass the plugin `apiKey` option, or connect DeepSeek in OpenCode.",
  )
}

export default Plugin.define({
  id: "deepseek.search",
  async setup(ctx) {
    const options = ctx.options as Options
    const defaultCount = clampCount(options.count)
    const defaultNeedContent = options.needContent === true
    const maxContentChars = options.maxContentChars ?? 4000
    const maxFetchChars = options.maxFetchChars ?? 30000
    const localization = options.localization?.trim() || undefined

    const deps = async (signal?: AbortSignal): Promise<CallDeps> => {
      const apiKey = await resolveApiKey(ctx as unknown as Contextish, options)
      return {
        apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(signal ? { signal } : {}),
      }
    }

    const pickLocalization = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : localization

    await ctx.websearch.transform((editor) => {
      editor.add({
        id: "deepseek",
        name: "DeepSeek Search",
        execute: async ({ query }, { signal }) => {
          const hits = await searchHits(
            {
              query,
              count: defaultCount,
              needContent: defaultNeedContent,
              ...(localization ? { localization } : {}),
            },
            await deps(signal),
          )
          return mapResults(hits, { needContent: defaultNeedContent, maxContentChars })
        },
      })
      editor.default.set("deepseek")
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "deepseek_search",
        description: [
          "Search the web through DeepSeek's search API.",
          "DeepSeek query operators are passed through: site:, -site:, -word, \"exact phrase\", -\"phrase\",",
          "lang:en,ru, after:2026-01-01, before:2026-06-01, and `site:a.com OR site:b.com`.",
          "Pass `ori_question` (the user's original question, max 128 chars) when `query` is reduced to keywords —",
          "it improves intent understanding.",
          "Search is billed per request, so a larger `count` costs nothing extra but does cost context;",
          "prefer 5-10 results and `need_content` only when a summary is not enough.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query, 1-128 characters: keywords rather than a request. Operators are passed through.",
            },
            ori_question: {
              type: "string",
              description: "The user's original question that triggered this search, 1-128 characters.",
            },
            count: {
              type: "integer",
              description: "Number of results, 1-50. Defaults to the plugin option.",
              minimum: 1,
              maximum: 50,
            },
            need_content: {
              type: "boolean",
              description: "Return full page content instead of the 600-800 character summary.",
            },
            localization: {
              type: "string",
              description: "IP address used to localize results.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { codemode: true, permission: "websearch" },
        execute: async (raw, context) => {
          const input = raw as SearchInput
          const count = clampCount(typeof input.count === "number" ? input.count : defaultCount)
          const needContent = typeof input.need_content === "boolean" ? input.need_content : defaultNeedContent
          const location = pickLocalization(input.localization)
          const oriQuestion =
            typeof input.ori_question === "string" && input.ori_question.trim()
              ? input.ori_question.trim()
              : undefined

          await context.progress?.({ status: "searching", provider: "deepseek", count })

          const hits: SearchHit[] = await searchHits(
            {
              query: input.query,
              count,
              needContent,
              ...(oriQuestion ? { oriQuestion } : {}),
              ...(location ? { localization: location } : {}),
            },
            await deps(context.signal),
          )

          if (hits.length === 0) {
            return { content: "No results. Try a shorter query, fewer operators, or drop `site:`." }
          }

          return {
            content: formatHits(hits),
            metadata: { provider: "deepseek", count: hits.length, needContent },
          }
        },
      })

      editor.add({
        name: "deepseek_fetch",
        description:
          "Fetch one web page through DeepSeek's Fetch API and return it as Markdown. " +
          "Use it for a page found by search when the summary is not enough. " +
          "Returns the page title and body, truncated at `max_chars`.",
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL, at most 8192 characters." },
            max_chars: { type: "integer", description: "Truncate the returned Markdown to this many characters." },
          },
          required: ["url"],
          additionalProperties: false,
        },
        options: { codemode: true, permission: "webfetch" },
        execute: async (raw, context) => {
          const input = raw as FetchInput
          const limit = Math.min(Math.max(Number(input.max_chars) || maxFetchChars, 500), 200000)

          await context.progress?.({ status: "fetching", url: input.url })

          const page = await fetchPage(
            { url: input.url, maxChars: limit },
            await deps(context.signal),
          )

          if (!page.content) {
            return { content: `Fetched ${input.url} but the page produced no usable content.` }
          }

          const heading = page.title && !page.content.trimStart().startsWith("#") ? `# ${page.title}` : undefined

          return {
            content: [heading, page.content, page.truncated ? `\n\n[truncated at ${limit} chars]` : undefined]
              .filter(Boolean)
              .join("\n\n"),
            metadata: { url: input.url, title: page.title, chars: page.chars, truncated: page.truncated },
          }
        },
      })
    })
  },
})
