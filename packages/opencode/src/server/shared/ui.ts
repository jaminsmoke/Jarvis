import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

// Jarvis never proxies to the upstream OpenCode UI. When no embedded UI bundle
// is available (dev builds), serve a branded notice pointing to the local app
// instead of whatever the upstream serves.
const JARVIS_NOTICE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jarvis</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1c2733 0%, #0b0f14 60%);
    color: #e6edf3;
  }
  main { max-width: 600px; padding: 3rem 1.5rem; text-align: center; }
  .logo { margin: 0; font-size: 2.4rem; font-weight: 800; letter-spacing: 0.08em; }
  .logo b { color: #58a6ff; }
  .tag { color: #8b949e; margin: 0.25rem 0 0; }
  h1 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
  p { color: #9da7b3; line-height: 1.7; margin: 0; }
  code { background: #161b22; border: 1px solid #2d333b; border-radius: 6px; padding: 0.15rem 0.45rem; color: #7ee787; }
</style>
</head>
<body>
<main>
  <p class="logo">Jar<b>vis</b></p>
  <p class="tag">API server</p>
  <h1>Web interface</h1>
  <p>
    The Jarvis web UI is not served from this server. Run the app with
    <code>bun dev:web</code> from <code>packages/app</code>, or install the
    desktop app.
  </p>
</main>
</body>
</html>`

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    return HttpServerResponse.text(JARVIS_NOTICE, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": DEFAULT_CSP },
    })
  })
}
