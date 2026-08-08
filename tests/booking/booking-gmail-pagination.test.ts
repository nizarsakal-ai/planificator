/**
 * PLAN-BOOKING-FINAL LOT 2C — Pagination Gmail progressive + budgets.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"
import {
  BOOKING_GMAIL_LIST_QUERY,
  BOOKING_GMAIL_LIST_PAGE_SIZE_DEFAULT,
  BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_DEFAULT,
  BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_DEFAULT,
  BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_DEFAULT,
  BookingGmailListError,
  buildBookingGmailListUrl,
  canAdmitFullFetch,
  consumeFullFetchAdmission,
  formatBookingGmailListErrorLog,
  BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX,
  getBookingGmailListPageSize,
  getBookingGmailMaxFullFetchesPerConnection,
  getBookingGmailMaxFullFetchesPerRun,
  getBookingGmailMaxPagesPerConnection,
  iterateBookingGmailMessagePages,
  runBookingGmailClaimLoop,
} from "@/lib/booking/booking-gmail-pagination"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function mockFetchSequence(
  handlers: Array<(url: string) => Response | Promise<Response>>
): typeof fetch {
  let i = 0
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const handler = handlers[i++]
    if (!handler) throw new Error(`Unexpected fetch #${i} url=${url}`)
    return handler(url)
  }) as typeof fetch
}

async function collectPages(
  gen: AsyncIterable<{ messageIds: string[]; pageIndex: number; stopHint: string }>
) {
  const pages = []
  for await (const p of gen) pages.push(p)
  return pages
}

describe("config bornée", () => {
  const keys = [
    "BOOKING_GMAIL_LIST_PAGE_SIZE",
    "BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION",
    "BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION",
    "BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN",
  ] as const
  const prev: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })

  it("page size / max pages / budgets : absent → défaut ; invalide → défaut", () => {
    for (const k of keys) {
      prev[k] = process.env[k]
      delete process.env[k]
    }
    assert.equal(getBookingGmailListPageSize(), BOOKING_GMAIL_LIST_PAGE_SIZE_DEFAULT)
    assert.equal(
      getBookingGmailMaxPagesPerConnection(),
      BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_DEFAULT
    )
    assert.equal(
      getBookingGmailMaxFullFetchesPerConnection(),
      BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_DEFAULT
    )
    assert.equal(
      getBookingGmailMaxFullFetchesPerRun(),
      BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_DEFAULT
    )

    process.env.BOOKING_GMAIL_LIST_PAGE_SIZE = "0"
    process.env.BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION = "abc"
    process.env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION = "101"
    process.env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN = "-1"
    assert.equal(getBookingGmailListPageSize(), 50)
    assert.equal(getBookingGmailMaxPagesPerConnection(), 10)
    assert.equal(getBookingGmailMaxFullFetchesPerConnection(), 25)
    assert.equal(getBookingGmailMaxFullFetchesPerRun(), 40)
  })

  it("valeurs valides respectées", () => {
    process.env.BOOKING_GMAIL_LIST_PAGE_SIZE = "75"
    process.env.BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION = "3"
    process.env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION = "10"
    process.env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN = "15"
    assert.equal(getBookingGmailListPageSize(), 75)
    assert.equal(getBookingGmailMaxPagesPerConnection(), 3)
    assert.equal(getBookingGmailMaxFullFetchesPerConnection(), 10)
    assert.equal(getBookingGmailMaxFullFetchesPerRun(), 15)
  })
})

describe("buildBookingGmailListUrl", () => {
  it("query exacte from:noreply@booking.com + maxResults + pageToken", () => {
    const url = buildBookingGmailListUrl({ pageSize: 50, pageToken: "tok1" })
    assert.match(url, /maxResults=50/)
    assert.match(url, /pageToken=tok1/)
    assert.equal(BOOKING_GMAIL_LIST_QUERY, "from:noreply@booking.com")
    assert.ok(url.includes(encodeURIComponent(BOOKING_GMAIL_LIST_QUERY)) || url.includes("from%3Anoreply"))
  })
})

describe("iterateBookingGmailMessagePages", () => {
  it("1. une page sans nextPageToken", async () => {
    const fetchImpl = mockFetchSequence([
      () => jsonResponse({ messages: [{ id: "a" }, { id: "b" }] }),
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        pageSize: 50,
        maxPages: 10,
      })
    )
    assert.equal(pages.length, 1)
    assert.deepEqual(pages[0].messageIds, ["a", "b"])
    assert.equal(pages[0].stopHint, "exhausted")
  })

  it("2. plusieurs pages", async () => {
    const fetchImpl = mockFetchSequence([
      (url) => {
        assert.equal(url.includes("pageToken"), false)
        return jsonResponse({
          messages: [{ id: "1" }],
          nextPageToken: "p2",
        })
      },
      (url) => {
        assert.ok(url.includes("pageToken=p2"))
        return jsonResponse({ messages: [{ id: "2" }] })
      },
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        pageSize: 50,
        maxPages: 10,
      })
    )
    assert.equal(pages.length, 2)
    assert.deepEqual(pages[0].messageIds, ["1"])
    assert.deepEqual(pages[1].messageIds, ["2"])
  })

  it("3–5. page vide / messages absent / ids vides filtrés", async () => {
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse({
          messages: [{ id: "" }, { id: "  " }, { noid: true }, { id: "ok" }],
          nextPageToken: "n",
        }),
      () => jsonResponse({}),
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 10,
      })
    )
    assert.equal(pages[0].messageIds.length, 1)
    assert.equal(pages[0].messageIds[0], "ok")
    assert.deepEqual(pages[1].messageIds, [])
    assert.equal(pages[1].stopHint, "exhausted")
  })

  it("6–7. doublon inter-pages + ordre première apparition", async () => {
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse({
          messages: [{ id: "a" }, { id: "b" }],
          nextPageToken: "p2",
        }),
      () =>
        jsonResponse({
          messages: [{ id: "b" }, { id: "c" }, { id: "a" }],
        }),
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 10,
      })
    )
    assert.deepEqual(pages[0].messageIds, ["a", "b"])
    assert.deepEqual(pages[1].messageIds, ["c"])
  })

  it("8. token identique répété → stop avant 3ᵉ fetch", async () => {
    let calls = 0
    const fetchImpl = mockFetchSequence([
      () => {
        calls++
        return jsonResponse({ messages: [{ id: "1" }], nextPageToken: "same" })
      },
      () => {
        calls++
        return jsonResponse({ messages: [{ id: "2" }], nextPageToken: "same" })
      },
      () => {
        calls++
        throw new Error("ne doit pas fetch une 3ᵉ fois")
      },
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 10,
      })
    )
    assert.equal(pages.length, 2)
    assert.equal(calls, 2)
  })

  it("9. cycle A → B → A", async () => {
    let calls = 0
    const fetchImpl = mockFetchSequence([
      () => {
        calls++
        return jsonResponse({ messages: [{ id: "1" }], nextPageToken: "A" })
      },
      () => {
        calls++
        return jsonResponse({ messages: [{ id: "2" }], nextPageToken: "B" })
      },
      () => {
        calls++
        return jsonResponse({ messages: [{ id: "3" }], nextPageToken: "A" })
      },
      () => {
        calls++
        throw new Error("cycle: pas de 4ᵉ fetch")
      },
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 10,
      })
    )
    assert.equal(pages.length, 3)
    assert.equal(calls, 3)
  })

  it("10. limite max pages", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return jsonResponse({
        messages: [{ id: `m${calls}` }],
        nextPageToken: `t${calls}`,
      })
    }) as typeof fetch
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 2,
      })
    )
    assert.equal(pages.length, 2)
    assert.equal(calls, 2)
    assert.equal(pages[1].stopHint, "max_pages")
  })

  it("11. HTTP non-OK", async () => {
    const fetchImpl = mockFetchSequence([() => jsonResponse({}, 500)])
    await assert.rejects(
      () =>
        collectPages(
          iterateBookingGmailMessagePages({
            accessToken: "t",
            fetchImpl,
            maxPages: 5,
          })
        ),
      (err: unknown) =>
        err instanceof BookingGmailListError && err.kind === "http" && err.httpStatus === 500
    )
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 cas1: 403 JSON Google → extraction code/status/message", async () => {
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
            },
          },
          403
        ),
    ])
    await assert.rejects(
      () =>
        collectPages(
          iterateBookingGmailMessagePages({
            accessToken: "t",
            fetchImpl,
            maxPages: 5,
          })
        ),
      (err: unknown) =>
        err instanceof BookingGmailListError &&
        err.kind === "http" &&
        err.httpStatus === 403 &&
        err.googleErrorCode === 403 &&
        err.googleErrorStatus === "PERMISSION_DENIED" &&
        err.googleErrorMessage ===
          "Request had insufficient authentication scopes."
    )
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 cas2: 403 body non JSON → fallback sans crash", async () => {
    const fetchImpl = mockFetchSequence([
      () => new Response("forbidden plain text", { status: 403 }),
    ])
    await assert.rejects(
      () =>
        collectPages(
          iterateBookingGmailMessagePages({
            accessToken: "t",
            fetchImpl,
            maxPages: 5,
          })
        ),
      (err: unknown) =>
        err instanceof BookingGmailListError &&
        err.kind === "http" &&
        err.httpStatus === 403 &&
        err.googleErrorCode === undefined &&
        err.googleErrorStatus === undefined &&
        err.googleErrorMessage === undefined
    )
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 cas3: 500 JSON incomplet → httpStatus seul", async () => {
    const fetchImpl = mockFetchSequence([
      () => jsonResponse({ error: { details: [{ reason: "backendError" }] } }, 500),
    ])
    await assert.rejects(
      () =>
        collectPages(
          iterateBookingGmailMessagePages({
            accessToken: "t",
            fetchImpl,
            maxPages: 5,
          })
        ),
      (err: unknown) =>
        err instanceof BookingGmailListError &&
        err.kind === "http" &&
        err.httpStatus === 500 &&
        err.googleErrorCode === undefined &&
        err.googleErrorStatus === undefined &&
        err.googleErrorMessage === undefined
    )
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 cas4: log sans tokens / Authorization / body brut", async () => {
    const secretAccess = "ya29.a0AfH6SMC_ACCESS_TOKEN_SECRET"
    const secretRefresh = "1//0gREFRESH_TOKEN_SECRET"
    const rawBodySnippet = '"access_token":"leak-me-please"'
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Insufficient Permission",
              status: "PERMISSION_DENIED",
              details: [
                {
                  access_token: secretAccess,
                  refresh_token: secretRefresh,
                  Authorization: `Bearer ${secretAccess}`,
                },
              ],
            },
            access_token: secretAccess,
            refresh_token: secretRefresh,
          },
          403
        ),
    ])

    let caught: BookingGmailListError | undefined
    try {
      await collectPages(
        iterateBookingGmailMessagePages({
          accessToken: secretAccess,
          fetchImpl,
          maxPages: 5,
        })
      )
    } catch (err) {
      assert.ok(err instanceof BookingGmailListError)
      caught = err
    }
    assert.ok(caught)

    const logLine = formatBookingGmailListErrorLog(caught, "company-diag-001")
    assert.match(logLine, /httpStatus=403/)
    assert.match(logLine, /googleErrorCode=403/)
    assert.match(logLine, /googleErrorStatus=PERMISSION_DENIED/)
    assert.match(logLine, /googleErrorMessage=Insufficient Permission/)
    assert.equal(logLine.includes(secretAccess), false)
    assert.equal(logLine.includes(secretRefresh), false)
    assert.equal(logLine.includes("Authorization"), false)
    assert.equal(logLine.includes("Bearer "), false)
    assert.equal(logLine.includes(rawBodySnippet), false)
    assert.equal(logLine.includes("leak-me-please"), false)
    assert.equal(JSON.stringify(caught).includes(secretAccess), false)
    assert.equal(JSON.stringify(caught).includes(secretRefresh), false)

    const routeSrc = readFileSync(
      join(ROOT, "src/app/api/cron/gmail-scan/route.ts"),
      "utf8"
    )
    assert.ok(routeSrc.includes("formatBookingGmailListErrorLog"))
    const listErrBlock = routeSrc.match(
      /catch \(listErr\) \{[\s\S]*?throw listErr[\s\S]*?\}/
    )?.[0]
    assert.ok(listErrBlock)
    assert.ok(listErrBlock.includes("formatBookingGmailListErrorLog"))
    assert.equal(listErrBlock.includes("access_token"), false)
    assert.equal(listErrBlock.includes("refresh_token"), false)
    assert.equal(listErrBlock.includes("Authorization"), false)
    assert.equal(listErrBlock.includes(".json()"), false)
    assert.equal(listErrBlock.includes(".text()"), false)
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 R1: email dans message → [REDACTED_EMAIL], absent du log", async () => {
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "Denied for user@example.com — insufficient scopes",
              status: "PERMISSION_DENIED",
            },
          },
          403
        ),
    ])
    let caught: BookingGmailListError | undefined
    try {
      await collectPages(
        iterateBookingGmailMessagePages({
          accessToken: "t",
          fetchImpl,
          maxPages: 5,
        })
      )
    } catch (err) {
      assert.ok(err instanceof BookingGmailListError)
      caught = err
    }
    assert.ok(caught)
    assert.equal(caught.googleErrorMessage?.includes("user@example.com"), false)
    assert.ok(caught.googleErrorMessage?.includes("[REDACTED_EMAIL]"))
    const logLine = formatBookingGmailListErrorLog(caught, "company-r1")
    assert.equal(logLine.includes("user@example.com"), false)
    assert.ok(logLine.includes("[REDACTED_EMAIL]"))
  })

  it("PLAN-BOOKING-DIAG-HTTP403-001 R1: message > 500 → valeur bornée", async () => {
    const longMsg = `PREFIX-${"x".repeat(600)}-SUFFIX`
    assert.ok(longMsg.length > BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX)
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: longMsg,
              status: "PERMISSION_DENIED",
            },
          },
          403
        ),
    ])
    let caught: BookingGmailListError | undefined
    try {
      await collectPages(
        iterateBookingGmailMessagePages({
          accessToken: "t",
          fetchImpl,
          maxPages: 5,
        })
      )
    } catch (err) {
      assert.ok(err instanceof BookingGmailListError)
      caught = err
    }
    assert.ok(caught)
    assert.equal(caught.googleErrorMessage?.length, BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX)
    assert.ok(caught.googleErrorMessage?.startsWith("PREFIX-"))
    assert.equal(caught.googleErrorMessage?.includes("SUFFIX"), false)
    const logLine = formatBookingGmailListErrorLog(caught, "company-r1")
    assert.ok(logLine.includes(`googleErrorMessage=${caught.googleErrorMessage}`))
    assert.equal(logLine.includes("SUFFIX"), false)
  })

  it("12. JSON invalide", async () => {
    const fetchImpl = mockFetchSequence([
      () => new Response("not-json", { status: 200 }),
    ])
    await assert.rejects(
      () =>
        collectPages(
          iterateBookingGmailMessagePages({
            accessToken: "t",
            fetchImpl,
            maxPages: 5,
          })
        ),
      (err: unknown) =>
        err instanceof BookingGmailListError && err.kind === "invalid_json"
    )
  })

  it("no_new_ids : page sans nouvel id + token → stop (pas de fetch suivant)", async () => {
    let calls = 0
    const fetchImpl = mockFetchSequence([
      () => {
        calls++
        return jsonResponse({
          messages: [{ id: "x" }],
          nextPageToken: "p2",
        })
      },
      () => {
        calls++
        return jsonResponse({
          messages: [{ id: "x" }],
          nextPageToken: "p3",
        })
      },
      () => {
        calls++
        throw new Error("no_new_ids ne doit pas continuer")
      },
    ])
    const pages = await collectPages(
      iterateBookingGmailMessagePages({
        accessToken: "t",
        fetchImpl,
        maxPages: 10,
      })
    )
    assert.equal(pages.length, 2)
    assert.deepEqual(pages[1].messageIds, [])
    assert.equal(pages[1].stopHint, "no_new_ids")
    assert.equal(calls, 2)
  })
})

describe("budgets + claim loop", () => {
  it("canAdmit / consume", () => {
    assert.equal(canAdmitFullFetch({ connectionRemaining: 0, globalRemaining: 5 }), false)
    assert.equal(canAdmitFullFetch({ connectionRemaining: 5, globalRemaining: 0 }), false)
    const next = consumeFullFetchAdmission({
      connectionRemaining: 2,
      globalRemaining: 3,
    })
    assert.deepEqual(next, { connectionRemaining: 1, globalRemaining: 2 })
  })

  it("17–18. pages SKIP puis page admissible ; SKIP ne consomme pas", async () => {
    async function* pages() {
      yield { messageIds: ["s1", "s2"], pageIndex: 1 }
      yield { messageIds: ["s3"], pageIndex: 2 }
      yield { messageIds: ["new"], pageIndex: 3 }
    }
    const claims: string[] = []
    const processed: string[] = []
    const result = await runBookingGmailClaimLoop({
      pages: pages(),
      budget: { connectionRemaining: 5, globalRemaining: 5 },
      claim: async (id) => {
        claims.push(id)
        return id === "new" ? "CLAIMED" : "SKIP"
      },
      onClaimed: async (id) => {
        processed.push(id)
      },
    })
    assert.deepEqual(claims, ["s1", "s2", "s3", "new"])
    assert.deepEqual(processed, ["new"])
    assert.equal(result.skipped, 3)
    assert.equal(result.claimed, 1)
    assert.equal(result.budget.connectionRemaining, 4)
    assert.equal(result.budget.globalRemaining, 4)
    assert.equal(result.pagesFetched, 3)
  })

  it("19–20. CLAIMED consomme 1 ; budget connexion milieu de page → pas de claim suivant", async () => {
    async function* pages() {
      yield { messageIds: ["a", "b", "c"], pageIndex: 1 }
    }
    const claims: string[] = []
    const result = await runBookingGmailClaimLoop({
      pages: pages(),
      budget: { connectionRemaining: 1, globalRemaining: 10 },
      claim: async (id) => {
        claims.push(id)
        return "CLAIMED"
      },
      onClaimed: async () => {},
    })
    assert.deepEqual(claims, ["a"])
    assert.equal(result.claimed, 1)
    assert.equal(result.stopReason, "budget")
    assert.equal(result.budget.connectionRemaining, 0)
  })

  it("21. budget global atteint → stop (simulation multi-connexion via budget restant)", async () => {
    async function* pages() {
      yield { messageIds: ["x", "y"], pageIndex: 1 }
    }
    const claims: string[] = []
    const result = await runBookingGmailClaimLoop({
      pages: pages(),
      budget: { connectionRemaining: 10, globalRemaining: 1 },
      claim: async (id) => {
        claims.push(id)
        return "CLAIMED"
      },
      onClaimed: async () => {},
    })
    assert.deepEqual(claims, ["x"])
    assert.equal(result.budget.globalRemaining, 0)
    assert.equal(result.stopReason, "budget")
  })

  it("22. erreur page 2 : travail page 1 déjà onClaimed conservé", async () => {
    const processed: string[] = []
    const fetchImpl = mockFetchSequence([
      () =>
        jsonResponse({
          messages: [{ id: "keep" }],
          nextPageToken: "p2",
        }),
      () => jsonResponse({}, 503),
    ])

    await assert.rejects(async () => {
      await runBookingGmailClaimLoop({
        pages: iterateBookingGmailMessagePages({
          accessToken: "t",
          fetchImpl,
          maxPages: 10,
        }),
        budget: { connectionRemaining: 10, globalRemaining: 10 },
        claim: async () => "CLAIMED",
        onClaimed: async (id) => {
          processed.push(id)
        },
      })
    }, BookingGmailListError)

    assert.deepEqual(processed, ["keep"])
  })

  it("Codex : budget 0 avant claim → aucun claim", async () => {
    async function* pages() {
      yield { messageIds: ["z"], pageIndex: 1 }
    }
    const claims: string[] = []
    const result = await runBookingGmailClaimLoop({
      pages: pages(),
      budget: { connectionRemaining: 0, globalRemaining: 5 },
      claim: async (id) => {
        claims.push(id)
        return "CLAIMED"
      },
      onClaimed: async () => {},
    })
    assert.deepEqual(claims, [])
    assert.equal(result.stopReason, "budget")
  })
})

describe("wiring / imports LOT2C", () => {
  it("23. helper sans Prisma/lifecycle/extract/persist", () => {
    const src = readFileSync(
      join(ROOT, "src/lib/booking/booking-gmail-pagination.ts"),
      "utf8"
    )
    assert.equal(src.includes("@/lib/prisma"), false)
    assert.equal(src.includes("gmail-message-lifecycle"), false)
    assert.equal(src.includes("booking-scan-result"), false)
    assert.equal(src.includes("extract-booking-fields"), false)
    assert.equal(src.includes("logement.actions"), false)
  })

  it("24–26. route : helper + query inchangée + pas de list mono-page hardcodé", () => {
    const src = readFileSync(join(ROOT, "src/app/api/cron/gmail-scan/route.ts"), "utf8")
    assert.match(src, /iterateBookingGmailMessagePages/)
    assert.match(src, /runBookingGmailClaimLoop/)
    assert.equal(src.includes("maxResults=50"), false)
    assert.equal(
      /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\?q=from:noreply@booking\.com&maxResults=50/.test(
        src
      ),
      false
    )
    assert.ok(src.includes("claimForProcessing"))
    assert.ok(src.includes("extractBookingFields"))
    assert.ok(src.includes("createOrGetBookingScanResult"))
    const pagSrc = readFileSync(
      join(ROOT, "src/lib/booking/booking-gmail-pagination.ts"),
      "utf8"
    )
    assert.ok(pagSrc.includes('from:noreply@booking.com'))
    assert.equal(pagSrc.includes("extractBookingFields"), false)
  })
})
