import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildFetchBody,
  buildSearchBody,
  clampCount,
  describeHttpError,
  fetchPage,
  formatHits,
  httpError,
  mapResults,
  normalizeQuery,
  searchHits,
  toResult,
  unescapeMarkdown,
  MAX_QUERY_LENGTH,
} from "../src/deepseek.ts"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("clampCount", () => {
  it("clamps to 1..50 and rounds", () => {
    assert.equal(clampCount(0), 1)
    assert.equal(clampCount(-10), 1)
    assert.equal(clampCount(51), 50)
    assert.equal(clampCount(7.6), 8)
  })

  it("falls back for non-numbers", () => {
    assert.equal(clampCount(undefined), 8)
    assert.equal(clampCount("12"), 8)
    assert.equal(clampCount(Number.NaN), 8)
    assert.equal(clampCount(Number.NaN, 3), 3)
  })
})

describe("normalizeQuery", () => {
  it("trims", () => {
    assert.equal(normalizeQuery("  nba scores  "), "nba scores")
  })

  it("rejects empty queries", () => {
    assert.throws(() => normalizeQuery("   "), /query` is empty/)
  })

  it("rejects queries longer than the API limit, counting code points", () => {
    assert.equal(MAX_QUERY_LENGTH, 128)
    assert.throws(() => normalizeQuery("a".repeat(129)), /at most 128/)
    assert.equal(normalizeQuery("🚀".repeat(128)), "🚀".repeat(128))
  })
})

describe("buildSearchBody", () => {
  it("keeps the minimal body", () => {
    assert.deepEqual(buildSearchBody({ query: "postgres 18" }), { query: "postgres 18", count: 8 })
  })

  it("passes every optional field", () => {
    assert.deepEqual(
      buildSearchBody({
        query: "postgres 18",
        count: 3,
        needContent: true,
        oriQuestion: "Что нового в PostgreSQL 18?",
        localization: "5.18.0.1",
      }),
      {
        query: "postgres 18",
        count: 3,
        need_content: true,
        ori_question: "Что нового в PostgreSQL 18?",
        localization: "5.18.0.1",
      },
    )
  })

  it("omits need_content when it is not a boolean", () => {
    assert.equal("need_content" in buildSearchBody({ query: "x", needContent: undefined }), false)
    assert.equal(buildSearchBody({ query: "x", needContent: false }).need_content, false)
  })

  it("truncates ori_question to 128 characters", () => {
    const body = buildSearchBody({ query: "x", oriQuestion: "q".repeat(200) }) as { ori_question: string }
    assert.equal([...body.ori_question].length, MAX_QUERY_LENGTH)
  })

  it("ignores blank optional strings", () => {
    const body = buildSearchBody({ query: "x", oriQuestion: "  ", localization: " " })
    assert.equal("ori_question" in body, false)
    assert.equal("localization" in body, false)
  })
})

describe("buildFetchBody", () => {
  it("accepts http(s)", () => {
    assert.deepEqual(buildFetchBody({ url: "https://example.com/a" }), { url: "https://example.com/a" })
  })

  it("rejects relative and non-http urls", () => {
    assert.throws(() => buildFetchBody({ url: "/a" }), /absolute http\(s\) URL/)
    assert.throws(() => buildFetchBody({ url: "ftp://example.com" }), /absolute http\(s\) URL/)
  })
})

describe("errors", () => {
  it("explains statuses", () => {
    assert.match(describeHttpError(402), /balance/)
    assert.match(describeHttpError(429), /rate limited/)
    assert.match(describeHttpError(503), /upstream/)
  })

  it("carries status and body", () => {
    const error = httpError(429, "slow down")
    assert.equal(error.status, 429)
    assert.match(error.message, /HTTP 429/)
    assert.match(error.message, /slow down/)
  })
})

describe("unescapeMarkdown", () => {
  it("removes the escapes DeepSeek adds", () => {
    assert.equal(unescapeMarkdown("\\# Title"), "# Title")
    assert.equal(unescapeMarkdown("a \\| b"), "a | b")
    assert.equal(unescapeMarkdown("Search \\/ Fetch"), "Search / Fetch")
  })

  it("keeps code escapes intact", () => {
    assert.equal(unescapeMarkdown("\\d+ digits"), "\\d+ digits")
  })
})

describe("results", () => {
  const hit = {
    title: "PostgreSQL 18",
    url: "https://example.com/pg18",
    summary: "summary text",
    snippet: "snippet text",
    content: "full content",
    date: "2026-09-25T00:00:00+00:00",
  }

  it("prefers the summary by default", () => {
    assert.deepEqual(toResult(hit), {
      url: "https://example.com/pg18",
      title: "PostgreSQL 18",
      content: "summary text",
      time: { published: Date.parse("2026-09-25T00:00:00+00:00") },
    })
  })

  it("uses the page content when needContent is set", () => {
    assert.equal(toResult(hit, { needContent: true }).content, "full content")
  })

  it("falls back to the snippet", () => {
    assert.equal(toResult({ url: "https://x", snippet: "only snippet" }).content, "only snippet")
  })

  it("omits published when the date is unparseable", () => {
    assert.deepEqual(toResult({ url: "https://x", date: "not a date" }).time, {})
  })

  it("drops hits without a url", () => {
    assert.deepEqual(mapResults([{ url: "https://x" }, { url: "" } as never]), [
      { url: "https://x", time: {} },
    ])
  })

  it("formats hits for the model", () => {
    const text = formatHits([{ ...hit, site_name: "PostgreSQL", rerank_score: 2.4567, authority: 4 }])
    assert.match(text, /^1\. PostgreSQL 18/)
    assert.match(text, /https:\/\/example\.com\/pg18/)
    assert.match(text, /PostgreSQL · 2026-09-25 · score 2\.46 · authority 4/)
  })
})

describe("searchHits", () => {
  it("posts the body and returns hits", async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return jsonResponse({ results: [{ url: "https://a", title: "A" }] })
    }) as unknown as typeof fetch

    const hits = await searchHits(
      { query: "  postgres 18  ", count: 99, needContent: true, oriQuestion: "Что нового?" },
      { apiKey: "sk-test", fetchImpl },
    )

    assert.deepEqual(hits, [{ url: "https://a", title: "A" }])
    assert.equal(captured?.url, "https://api.deepseek.com/v1/tools/search")
    assert.equal(captured?.init.method, "POST")
    const headers = captured?.init.headers as Record<string, string>
    assert.equal(headers.Authorization, "Bearer sk-test")
    assert.equal(headers["Content-Type"], "application/json")
    assert.deepEqual(JSON.parse(String(captured?.init.body)), {
      query: "postgres 18",
      count: 50,
      need_content: true,
      ori_question: "Что нового?",
    })
  })

  it("honours a custom base url", async () => {
    let capturedUrl = ""
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return jsonResponse({ results: [] })
    }) as unknown as typeof fetch

    await searchHits({ query: "x" }, { apiKey: "k", baseUrl: "http://127.0.0.1:8080/", fetchImpl })
    assert.equal(capturedUrl, "http://127.0.0.1:8080/v1/tools/search")
  })

  it("throws a readable error on failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 402 })) as unknown as typeof fetch
    await assert.rejects(() => searchHits({ query: "x" }, { apiKey: "k", fetchImpl }), (error: Error) => {
      assert.match(error.message, /insufficient balance/)
      assert.equal((error as { status?: number }).status, 402)
      return true
    })
  })
})

describe("fetchPage", () => {
  it("unescapes markdown and truncates", async () => {
    const raw = "\\# Example\n\nBody \\| more"
    const expected = "# Example\n\nBody | more"
    const fetchImpl = (async (url: string, init: RequestInit) => {
      assert.equal(url, "https://api.deepseek.com/v1/tools/fetch")
      assert.deepEqual(JSON.parse(String(init.body)), { url: "https://example.com" })
      return jsonResponse({ title: "Example", content: raw })
    }) as unknown as typeof fetch

    const page = await fetchPage({ url: "https://example.com" }, { apiKey: "k", fetchImpl })
    assert.equal(page.title, "Example")
    assert.equal(page.content, expected)
    assert.equal(page.truncated, false)
    assert.equal(page.chars, expected.length)

    const short = await fetchPage({ url: "https://example.com", maxChars: 500 }, { apiKey: "k", fetchImpl })
    assert.equal(short.truncated, false)
  })

  it("reports truncation", async () => {
    const long = "x".repeat(1200)
    const fetchImpl = (async () => jsonResponse({ title: "T", content: long })) as unknown as typeof fetch
    const page = await fetchPage({ url: "https://example.com", maxChars: 600 }, { apiKey: "k", fetchImpl })
    assert.equal(page.truncated, true)
    assert.equal(page.chars, 600)
    assert.equal(page.content.length, 600)
  })
})
