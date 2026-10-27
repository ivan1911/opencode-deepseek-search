/**
 * Pure DeepSeek Search & Fetch helpers.
 *
 * No OpenCode imports here on purpose: everything in this file is unit-testable
 * with a fake `fetch`.
 *
 * API docs: https://api-docs.deepseek.com/guides/search/
 */

export const DEFAULT_BASE_URL = "https://api.deepseek.com"
export const SEARCH_PATH = "/v1/tools/search"
export const FETCH_PATH = "/v1/tools/fetch"

/** DeepSeek caps the query and `ori_question` at 128 Unicode characters. */
export const MAX_QUERY_LENGTH = 128

export type SearchHit = {
  title?: string
  url: string
  snippet?: string
  summary?: string
  content?: string
  date?: string | null
  rerank_score?: number
  authority?: number
  site_name?: string | null
}

export type SearchResult = {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

export type SearchRequest = {
  query: string
  count?: number
  needContent?: boolean
  oriQuestion?: string
  localization?: string
}

export type CallDeps = {
  apiKey: string
  baseUrl?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export type HttpError = Error & { status: number; body: string }

export function clampCount(value: unknown, fallback = 8): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(Math.max(parsed, 1), 50)
}

export function charLength(value: string): number {
  return [...value].length
}

export function normalizeQuery(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) throw new Error("DeepSeek search: `query` is empty.")
  const length = charLength(trimmed)
  if (length > MAX_QUERY_LENGTH) {
    throw new Error(
      `DeepSeek search: query is ${length} characters, the API accepts at most ${MAX_QUERY_LENGTH}.`,
    )
  }
  return trimmed
}

export function buildSearchBody(request: SearchRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: normalizeQuery(request.query),
    count: clampCount(request.count),
  }

  if (request.needContent !== undefined) body.need_content = request.needContent

  const ori = request.oriQuestion?.trim()
  if (ori) body.ori_question = [...ori].slice(0, MAX_QUERY_LENGTH).join("")

  const localization = request.localization?.trim()
  if (localization) body.localization = localization

  return body
}

export function buildFetchBody(request: { url: string }): Record<string, unknown> {
  const url = request.url.trim()
  if (!url) throw new Error("DeepSeek fetch: `url` is empty.")
  if (!/^https?:\/\//i.test(url)) throw new Error("DeepSeek fetch: `url` must be an absolute http(s) URL.")
  if (url.length > 8192) throw new Error("DeepSeek fetch: `url` is longer than 8192 characters.")
  return { url }
}

export function describeHttpError(status: number): string {
  if (status === 400) return "invalid request (bad query or field)"
  if (status === 401) return "invalid API key"
  if (status === 402) return "insufficient balance"
  if (status === 403) return "rejected by security policy"
  if (status === 404) return "page could not be fetched"
  if (status === 408) return "request timed out"
  if (status === 413) return "request body too large"
  if (status === 429) return "rate limited (QPS exceeded)"
  if (status >= 500) return "upstream error"
  return "request failed"
}

export function httpError(status: number, body: string): HttpError {
  const error = new Error(`DeepSeek ${describeHttpError(status)} (HTTP ${status}): ${body.slice(0, 300)}`) as HttpError
  error.status = status
  error.body = body
  return error
}

/** DeepSeek's Fetch API escapes ASCII punctuation (`\#`, `\|`, `\.`) so the text is safe to quote. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1")
}

export function toResult(
  hit: SearchHit,
  options: { needContent?: boolean; maxContentChars?: number } = {},
): SearchResult {
  const maxContentChars = options.maxContentChars ?? 4000
  const text = options.needContent ? hit.content || hit.summary : hit.summary || hit.snippet
  const published = hit.date ? Date.parse(hit.date) : Number.NaN

  return {
    url: hit.url,
    ...(hit.title ? { title: hit.title } : {}),
    ...(text ? { content: text.slice(0, maxContentChars) } : {}),
    time: Number.isFinite(published) ? { published } : {},
  }
}

export function mapResults(
  hits: readonly SearchHit[],
  options: { needContent?: boolean; maxContentChars?: number } = {},
): SearchResult[] {
  return hits.filter((hit) => Boolean(hit.url)).map((hit) => toResult(hit, options))
}

export function formatHits(hits: readonly SearchHit[]): string {
  return hits
    .map((hit, index) => {
      const meta = [
        hit.site_name || undefined,
        hit.date ? hit.date.slice(0, 10) : undefined,
        typeof hit.rerank_score === "number" ? `score ${hit.rerank_score.toFixed(2)}` : undefined,
        typeof hit.authority === "number" && hit.authority >= 0 ? `authority ${hit.authority}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")

      const body = hit.summary || hit.content || hit.snippet || ""

      return [
        `${index + 1}. ${hit.title ?? "(no title)"}`,
        `   ${hit.url}`,
        meta ? `   ${meta}` : undefined,
        body ? `   ${body.replace(/\s+/g, " ").slice(0, 1200)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n\n")
}

async function requestJson(
  path: string,
  body: unknown,
  deps: CallDeps,
): Promise<unknown> {
  const base = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const fetchImpl = deps.fetchImpl ?? fetch

  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(deps.signal ? { signal: deps.signal } : {}),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw httpError(response.status, text)
  }

  return (await response.json()) as unknown
}

/** Runs one Search request and returns the raw hits. */
export async function searchHits(request: SearchRequest, deps: CallDeps): Promise<SearchHit[]> {
  const payload = (await requestJson(SEARCH_PATH, buildSearchBody(request), deps)) as {
    results?: SearchHit[]
  }
  return payload.results ?? []
}

/** Runs one Fetch request and returns page title plus Markdown content. */
export async function fetchPage(
  request: { url: string; maxChars?: number },
  deps: CallDeps,
): Promise<{ title?: string; content: string; truncated: boolean; chars: number }> {
  const payload = (await requestJson(FETCH_PATH, buildFetchBody(request), deps)) as {
    title?: string
    content?: string
  }

  const title = payload.title?.trim() || undefined
  const content = unescapeMarkdown(payload.content ?? "")
  const limit = Math.min(Math.max(Math.round(request.maxChars ?? 30000), 500), 200000)
  const truncated = content.length > limit

  return {
    ...(title ? { title } : {}),
    content: content.slice(0, limit),
    truncated,
    chars: Math.min(content.length, limit),
  }
}
