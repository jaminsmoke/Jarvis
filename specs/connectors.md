# Connectors & Integrations

> Arquitectura del sistema de conectores e integraciones de Jarvis. Documenta
> cómo se implementó el conector GitHub (el primero) y cómo extenderlo.

## Términos

- **Conector**: adaptador que autentica una cuenta externa (OAuth device flow
  u otro mecanismo) y guarda las credenciales de forma segura. El renderer
  nunca ve el token. Un conector NO aporta acciones de producto por sí mismo.
  Ejemplo: conector **GitHub** (único hoy).
- **Integración**: funcionalidad de producto construida SOBRE un conector
  (o varios): sincronizar issues, publicar releases, leer repos, etc. Hoy hay
  **0 integraciones** — la UI de Settings → Integraciones es un placeholder
  ("Coming soon") en `app/src/components/settings-v2/integrations.tsx`.

Regla de diseño: un conector es infraestructura de autenticación; una
integración es producto. Primero conectores, después integraciones encima.

## Estado actual

| Sistema | Estado | Dónde vive |
|---|---|---|
| Conector GitHub (desktop) | ✅ Implementado | `packages/desktop/src/main/connectors.ts` |
| Puente de plataforma (IPC) | ✅ | `packages/desktop/src/main/ipc.ts` (`connector-github-*`) |
| Controller SolidJS | ✅ | `packages/app/src/connectors/use-connector.ts` |
| Transporte web (server) | ✅ | `packages/app/src/connectors/web-github.ts` + endpoints server |
| Tipos compartidos | ✅ | `packages/app/src/connectors/types.ts` |
| Integraciones | ⚠️ Placeholder | `packages/app/src/components/settings-v2/integrations.tsx` |

## Arquitectura

```
┌─────────────────────────── renderer (app) ───────────────────────────┐
│  settings → integrations → useGitHubConnector()                      │
│    ├─ desktop: platform.connector.github  (IPC → main process)       │
│    └─ web:     createWebGitHubConnector() (fetch → Jarvis server)    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  main process (desktop) — packages/desktop/src/main/connectors.ts    │
│  • Device Flow OAuth (RFC 8628) — igual que `gh` CLI                 │
│  • device_code SOLO en memoria (Map de sesiones por sessionId)       │
│  • token encriptado con Electron safeStorage → electron-store        │
│  • rechaza guardar si la encriptación no está disponible             │
│    (incluye backend `basic_text` de Linux sin keyring)               │
└───────────────────────────────────────────────────────────────────────┘
```

### Por qué device flow en el main process

Los endpoints de device flow de GitHub (`/login/device/code`,
`/login/oauth/access_token`) **no permiten CORS**. Por eso el flujo vive en el
main process (o en el server para la build web), nunca en el renderer.

### Por qué el token encriptado y en el main process

- El renderer nunca necesita el token: solo muestra `user_code` y el resultado
  del polling.
- `safeStorage` usa el keyring del SO (DPAPI en Windows, Keychain en macOS,
  libsecret en Linux). Si el backend es `basic_text` (Linux sin keyring) la
  encriptación es solo ofuscación → se **rechaza** guardar el token en claro.

### Claves del settings store (`electron-store`)

| Clave | Contenido | Secreto |
|---|---|---|
| `connector.github.enabled` | bool | no |
| `connector.github.token.encrypted` | `base64(safeStorage.encryptString(token))` | **sí** |
| `connector.github.user` | JSON de `GitHubUser` (login, avatar, name) | no |

### Endpoints del server (build web)

| Endpoint | Método | Función |
|---|---|---|
| `/connector/github/status` | GET | estado actual |
| `/connector/github/set-enabled` | POST `{enabled}` | activar/desactivar |
| `/connector/github/device` | POST | iniciar device flow |
| `/connector/github/poll` | POST `{sessionId}` | polling del flujo |
| `/connector/github/disconnect` | POST | revocar token |

## Flujo de autenticación (device flow)

1. `startDeviceFlow()` → POST `/login/device/code` → se guarda el
   `device_code` en memoria (main process) y se devuelve `user_code` +
   `verification_uri` + `interval`.
2. El usuario abre `verification_uri` en su navegador y escribe `user_code`
   (autoriza SU propia cuenta de GitHub).
3. `pollDeviceFlow(sessionId)` → POST `/login/oauth/access_token` cada
   `interval` segundos hasta un estado terminal:
   - `pending` / `slow_down` → seguir esperando
   - `success` → se obtiene el token, se encripta y se guarda, se marca
     `enabled=true`, se devuelve el `GitHubUser`
   - `expired` / `denied` / `error` → estado terminal, se limpia la sesión
4. `disconnect()` → borra token y usuario; NO cambia `enabled`.

## Cómo añadir un conector nuevo

Checklist para `ConectorX`:

1. **Tipos** (`app/src/connectors/types.ts`): estado, resultado de device flow
   (si aplica), y la superficie del puente `XConnectorPlatform`.
2. **Main process** (`desktop/src/main/connectors.ts` o archivo propio):
   endpoints OAuth + storage encriptado (mismo patrón que `github*`).
3. **IPC** (`desktop/src/main/ipc.ts`): handlers `connector-x-*`.
4. **Transporte web** (`app/src/connectors/web-x.ts`): si el server lo proxy.
5. **Controller** (`app/src/connectors/use-x.ts`): resolver puente desktop o
   transporte web.
6. **UI**: nueva sección en `integrations.tsx`.
7. **Tests**: seguir `connectors.test.ts` (main), `web-github.test.ts`
   (transporte) y `use-connector.test.ts` (controller).

## Cobertura de tests

| Archivo | Capa | Cubre |
|---|---|---|
| `packages/desktop/src/main/connectors.test.ts` | main | device flow completo (pending/slow_down/denied/expired/error/success), encriptación disponible vs `basic_text`/no disponible, disconnect, cleanup de sesiones, hook de arranque con token corrupto |
| `packages/app/src/connectors/web-github.test.ts` | transporte | URLs, métodos, body JSON, header Basic, trailing slash, errores HTTP |
| `packages/app/src/connectors/use-connector.test.ts` | controller | resolución desktop vs web, toggle, flujos success/denied/expired, cancel, disconnect, transporte no disponible |

> ⚠️ **Nota**: `solid-js` resuelve al build server bajo bun (condición `node`),
> donde `onMount`/`createEffect` son no-ops — por eso los tests del controller
> cubren las acciones explícitas (toggle/startConnect/cancel/disconnect) y la
> resolución de transporte, no la carga de status al montar (esa ruta se cubre
> en la matriz de pruebas manuales del desktop).
| `packages/opencode/test/server/httpapi-connector.test.ts` | server | endpoints HTTP `/connector/github/*` |

## Roadmap

- Integraciones sobre el conector GitHub (issues, releases, kanban, ...).
- Conectores adicionales (GitLab, Google, ...) cuando una integración lo exija.
