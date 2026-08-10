#!/usr/bin/env bun
/**
 * Smoke test del artefacto Windows empaquetado (Issue #40).
 *
 * Gate de release: ninguna release de Jarvis Desktop debe publicarse sin
 * superar estas 5 pruebas sobre el artefacto real (no solo el código fuente).
 *
 * Uso:
 *   bun scripts/smoke.ts --exe dist/jarvis-desktop-win-x64.exe --version 0.1.5
 *
 * Pruebas:
 *   1. Config crítica: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET no vacíos
 *      (evita el incidente v0.1.4: build verde con secret vacío).
 *   2. Static asar: el server empaquetado (rutas /global/health y sidecar)
 *      está presente en app.asar (detecta la clase de error v0.1.0:
 *      módulo virtual ausente que solo aparece al empaquetar).
 *   3. Versión: dist/latest.yml reporta la versión esperada del tag.
 *   4. Arranque + alive: el exe empaquetado arranca y el proceso sigue vivo.
 *   5. Health del server local: GET http://localhost:4096/global/health
 *      responde healthy (el server escucha 4096 primero, luego puerto libre).
 *
 * Exit code 0 = gate superado. Cualquier fallo imprime un mensaje claro y
 * conserva el artefacto en disco para diagnóstico.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// 127.0.0.1 en vez de localhost: en Windows/Node, localhost puede resolver a ::1
// primero y el fetch fallaría aunque el server (en 127.0.0.1) esté sano.
const HEALTH_URL = "http://127.0.0.1:4096/global/health"
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 2_000

type Options = {
  exe: string
  version: string
  distDir: string
}

function parseArgs(argv: string[]): Options {
  const opts: Partial<Options> = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--exe") opts.exe = argv[++i]
    else if (arg === "--version") opts.version = argv[++i]
    else if (arg === "--dist") opts.distDir = argv[++i]
  }
  if (!opts.exe || !opts.version) {
    console.error("Uso: bun scripts/smoke.ts --exe <ruta.exe> --version <vX.Y.Z> [--dist <dir>]")
    process.exit(2)
  }
  opts.distDir ??= join(process.cwd(), "dist")
  return opts as Options
}

let failures: string[] = []

function fail(message: string) {
  failures.push(message)
  console.error(`✗ ${message}`)
}

function pass(message: string) {
  console.log(`✓ ${message}`)
}

/** Prueba 1: configuración crítica no vacía (GOOGLE_CLIENT_ID/SECRET). */
function checkConfig() {
  const id = process.env.GOOGLE_CLIENT_ID ?? ""
  const secret = process.env.GOOGLE_CLIENT_SECRET ?? ""
  if (!id || !secret) {
    fail(
      `Config crítica vacía (GOOGLE_CLIENT_ID=${id ? "set" : "EMPTY"}, GOOGLE_CLIENT_SECRET=${secret ? "set" : "EMPTY"}). ` +
        "Un secret vacío se empaqueta sin error y la app sale con OAuth roto (incidente v0.1.4).",
    )
    return
  }
  pass(`Config crítica presente (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET seteados)`)
}

/** Prueba 2: el server empaquetado está en app.asar (módulo virtual resuelto). */
function checkAsar(asarPath: string) {
  if (!existsSync(asarPath)) {
    fail(`No existe ${asarPath} — el empaquetado no produjo app.asar`)
    return
  }
  const raw = readFileSync(asarPath)
  const hasHealthRoute = raw.includes("global/health")
  // "sidecar.js" (nombre del utility process del server) es un marcador más
  // específico que "sidecar", que podría aparecer en librerías empaquetadas.
  const hasSidecar = raw.includes("sidecar.js")
  if (!hasHealthRoute || !hasSidecar) {
    fail(
      `app.asar incompleto: healthRoute=${hasHealthRoute}, sidecar.js=${hasSidecar}. ` +
        "El server no quedó empaquetado (clase de error v0.1.0: virtual:opencode-server).",
    )
    return
  }
  pass(`app.asar contiene el server empaquetado (health route + sidecar)`)
}

/** Prueba 3: latest.yml reporta la versión del tag. */
function checkVersion(latestYmlPath: string, expected: string) {
  if (!existsSync(latestYmlPath)) {
    fail(`No existe ${latestYmlPath}`)
    return
  }
  const content = readFileSync(latestYmlPath, "utf8")
  const match = content.match(/^version:\s*([^\s]+)/m)
  const actual = match?.[1] ?? ""
  if (actual !== expected) {
    fail(`Versión en latest.yml (${actual || "?"}) != versión del tag (${expected})`)
    return
  }
  pass(`latest.yml reporta versión ${actual} (coincide con el tag)`)
}

/** Pruebas 4 y 5: arranque del exe, proceso vivo y health del server local. */
async function checkLaunch(exePath: string) {
  if (!existsSync(exePath)) {
    fail(`No existe el ejecutable ${exePath}`)
    return
  }
  const proc = Bun.spawn([exePath, "--disable-gpu", "--no-sandbox"], { stdout: "pipe", stderr: "pipe" })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  proc.stdout?.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        stdout.push(Buffer.from(chunk))
      },
    }),
  )
  proc.stderr?.pipeTo(
    new WritableStream({
      write(chunk: Uint8Array) {
        stderr.push(Buffer.from(chunk))
      },
    }),
  )

  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let healthy = false
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean }
        if (body.healthy === true) {
          healthy = true
          break
        }
      }
    } catch {
      // El server aún no escucha; reintentar.
    }
    await Bun.sleep(HEALTH_POLL_INTERVAL_MS)
  }

  // Espera de estabilidad: si arrancó, que siga vivo unos segundos más.
  if (healthy) await Bun.sleep(5_000)
  const alive = proc.exitCode === null

  if (!healthy) {
    const stderrTail = Buffer.concat(stderr).toString("utf8").slice(-800)
    const stdoutTail = Buffer.concat(stdout).toString("utf8").slice(-800)
    const reason = alive
      ? "proceso vivo pero el server local no responde en " + HEALTH_URL
      : `proceso terminó con exit code ${proc.exitCode}`
    fail(`Smoke de arranque falló: ${reason}.\n  stdout tail: ${stdoutTail || "(vacío)"}\n  stderr tail: ${stderrTail || "(vacío)"}`)
  } else {
    pass(`Server local healthy en ${HEALTH_URL}`)
    if (alive) pass("Proceso vivo tras arranque (sin crash)")
    else fail(`El proceso terminó después de responder healthy (exit ${proc.exitCode})`)
  }

  // Limpieza: matar el árbol de procesos del exe lanzado.
  if (proc.pid) {
    Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
  }
}

async function main() {
  const opts = parseArgs(process.argv)
  console.log(`--- Smoke test del artefacto (${opts.exe}, versión ${opts.version}) ---`)

  checkConfig()
  checkAsar(join(opts.distDir, "win-unpacked", "resources", "app.asar"))
  checkVersion(join(opts.distDir, "latest.yml"), opts.version)
  await checkLaunch(opts.exe)

  if (failures.length > 0) {
    console.error(`\nGATE FAILED (${failures.length} fallo(s)):`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log("\nGATE PASSED: artefacto listo para publicar.")
}

main().catch((error) => {
  console.error("Smoke test terminó con error:", error)
  process.exit(1)
})
