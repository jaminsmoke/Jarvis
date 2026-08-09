# Connectors & Integrations

> Arquitectura del sistema de conectores e integraciones de Jarvis. Documenta
> cómo funciona el framework config-driven (registry) y cómo añadir un
> conector nuevo.

## Términos

- **Conector**: adaptador que autentica una cuenta externa (OAuth device flow,
  RFC 8628) y guarda las credenciales de forma segura. El renderer nunca ve el
  token. Un conector NO aporta acciones de producto por sí mismo.
  Conectores hoy: **GitHub**, **Google (Drive/Docs)**, **Microsoft (OneDrive)**.
- **Integración**: funcionalidad de producto construida SOBRE un conector
  (o varios): sincronizar issues, publicar releases, leer repos, etc. Hoy hay
  **0 integraciones** — la UI de Settings → Integraciones es un placeholder
  ("Coming soon") en `app/src/components/settings-v2/integrations.tsx`.

Regla de diseño: un conector es infraestructura de autenticación; una
integración es producto. Primero conectores, después integraciones encima.

## Estado actual

| Sistema | Estado | Dónde vive |
|---|---|---|
| Registry config-driven (3 conectores) | ✅ | `packages/schema/src/connector.ts` |
| Conectores (desktop main, fábrica genérica) | ✅ | `packages/desktop/src/main/connectors.ts` |
| Puente de plataforma (IPC) | ✅ | `packages/desktop/src/main/ipc.ts` (`connector-{id}-*`) |
| Controller SolidJS genérico | ✅ | `packages/app/src/connectors/use-connector.ts` (`useConnector(def)`) |
| Transporte web genérico | ✅ | `packages/app/src/connectors/web-connector.ts` |
| Server proxy (Effect, por conector) | ✅ | `packages/opencode/.../httpapi/handlers/connector.ts` |
| UI (tarjetas + modal genéricos) | ✅ | `packages/app/src/components/settings-v2/` |
| Integraciones | ⚠️ Placeholder | `packages/app/src/components/settings-v2/integrations.tsx` |

> 🔑 **Client IDs pendientes**: Google y Microsoft usan placeholders
> (`REPLACE_WITH_...`) en el registry hasta que se registren sus OAuth Apps.
> GitLab quedó **descartado** (su OAuth NO soporta device flow — verificado:
> `POST /oauth/device/code` → 404).

## Arquitectura

```
┌─────────────────────────── renderer (app) ───────────────────────────┐
│  settings → connectors → useConnector(def) por cada definición      │
│    ├─ desktop: platform.connector[def.id]  (IPC → main process)     │
│    └─ web:     createWebConnector(def)     (fetch → Jarvis server)  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  main process (desktop) — packages/desktop/src/main/connectors.ts    │
│  createConnector(def) — fábrica sobre el registry:                   │
│  • Device Flow OAuth (RFC 8628) — igual que `gh` CLI                 │
│  • device_code SOLO en memoria (Map de sesiones por sessionId)       │
│  • token encriptado con Electron safeStorage → electron-store        │
│  • rechaza guardar si la encriptación no está disponible             │
│    (incluye backend `basic_text` de Linux sin keyring)               │
└───────────────────────────────────────────────────────────────────────┘
```

### Registry (fuente de verdad)

Cada conector es una entrada de `ConnectorDefinition` en
`packages/schema/src/connector.ts` (compartido por desktop, server y app):

```ts
{
  id: "google",                    // IPC/store/server route namespace
  clientId: "...apps.googleusercontent.com",  // público por diseño
  scopes: "https://www.googleapis.com/auth/drive.readonly",
  deviceCodeUrl: "https://oauth2.googleapis.com/device/code",
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBaseUrl: "https://www.googleapis.com",
  userPath: "/oauth2/v2/userinfo",
  deniedErrorCode: "access_denied",   // difiere por provider
  storePrefix: "connector.google",    // claves del settings store
  apiHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  mapUser: (data) => ({ login: data.email, avatar: data.picture, ... }),
  icon / providerIcon / i18nPrefix / permissions,  // UI
}
```

### Por qué device flow en el main process

Los endpoints de device flow de los providers (`/device/code`,
`/token`, ...) **no permiten CORS**. Por eso el flujo vive en el main process
(o en el server para la build web), nunca en el renderer.

### Por qué el token encriptado y en el main process

- El renderer nunca necesita el token: solo muestra `user_code` y el resultado
  del polling.
- `safeStorage` usa el keyring del SO (DPAPI en Windows, Keychain en macOS,
  libsecret en Linux). Si el backend es `basic_text` (Linux sin keyring) la
  encriptación es solo ofuscación → se **rechaza** guardar el token en claro.

### Claves del settings store (`electron-store`)

Por conector, con el prefijo `storePrefix` (ej. `connector.google`):

| Clave | Contenido | Secreto |
|---|---|---|
| `connector.<id>.enabled` | bool | no |
| `connector.<id>.token.encrypted` | `base64(safeStorage.encryptString(token))` | **sí** |
| `connector.<id>.user` | JSON de `ConnectorUser` (login, avatar, name) | no |

### Endpoints del server (build web)

Por conector (`{id}` = github | google | microsoft):

| Endpoint | Método | Función |
|---|---|---|
| `/connector/{id}/status` | GET | estado actual |
| `/connector/{id}/set-enabled` | POST `{enabled}` | activar/desactivar |
| `/connector/{id}/device` | POST | iniciar device flow |
| `/connector/{id}/poll` | POST `{sessionId}` | polling del flujo |
| `/connector/{id}/disconnect` | POST | revocar token |

## Flujo de autenticación (device flow)

1. `startDeviceFlow()` → POST `deviceCodeUrl` → se guarda el `device_code` en
   memoria (main process) y se devuelve `user_code` + `verification_uri` +
   `interval`.
2. El usuario abre `verification_uri` en su navegador y escribe `user_code`
   (autoriza SU propia cuenta del provider).
3. `pollDeviceFlow(sessionId)` → POST `tokenUrl` cada `interval` segundos
   hasta un estado terminal:
   - `pending` / `slow_down` → seguir esperando
   - `success` → se obtiene el token, se encripta y se guarda, se marca
     `enabled=true`, se devuelve el `ConnectorUser`
   - `expired` / `denied` / `error` → estado terminal, se limpia la sesión
4. `disconnect()` → borra token y usuario; NO cambia `enabled`.

**Diferencias por provider** (todo en el registry):
- GitHub: `deniedErrorCode=access_denied`, headers `Accept:
  application/vnd.github+json`, user = `/user` → login.
- Google: `deniedErrorCode=access_denied`, user = `/oauth2/v2/userinfo` →
  email (login), picture (avatar). No necesita `client_secret` (cliente
  público "Desktop app").
- Microsoft: `deniedErrorCode=authorization_declined` (¡distinto!), user =
  Graph `/me` → `userPrincipalName` (login), `displayName` (name). No
  necesita `client_secret` (cliente público con public client flows).

## Cómo añadir un conector nuevo

1. **Registry** (`packages/schema/src/connector.ts`): añadir la entrada
   `ConnectorDefinition` (clientId, scopes, endpoints, deniedErrorCode,
   apiHeaders, mapUser, i18nPrefix, permissions). Registrar la OAuth App del
   provider (por UI; el client_id es público) y rellenar `clientId`.
2. **Nada más en main process**: la fábrica `createConnector(def)` ya expone
   el conector; solo añadir los wrappers `{id}Status`/`{id}SetEnabled`/...
   y los handlers IPC `connector-{id}-*` (o generalizar el registro de IPC).
3. **Server** (`handlers/connector.ts` + `groups/connector.ts`): añadir el
   `buildConnectorHandlers(def)` + endpoints del provider si se quiere web.
4. **UI**: la lista renderiza `CONNECTOR_LIST` automáticamente; solo hace
   falta el i18n (`settings.connectors.<id>.*` en los 26 idiomas).
5. **Tests**: añadir casos al patrón existente (main `connectors.test.ts`,
   web `web-connector.test.ts`, controller `use-connector.test.ts`, server
   `httpapi-connector.test.ts`).

## Cobertura de tests

| Archivo | Capa | Cubre |
|---|---|---|
| `packages/desktop/src/main/connectors.test.ts` | main | device flow completo (pending/slow_down/denied/expired/error/success) para github + google + microsoft, deniedErrorCode por provider, encriptación disponible vs `basic_text`/no disponible, disconnect, cleanup de sesiones, hook de arranque con token corrupto |
| `packages/app/src/connectors/web-connector.test.ts` | transporte | rutas `/connector/{id}/*` para los 3, URLs, métodos, body JSON, header Basic, trailing slash, errores HTTP |
| `packages/app/src/connectors/use-connector.test.ts` | controller | resolución por id (desktop bridge / web fallback / none), toggle, flujos success/denied/expired, cancel, disconnect |
| `packages/opencode/test/server/httpapi-connector.test.ts` | server | endpoints HTTP `/connector/{id}/*` para los 3 (status + disconnect) |

> ⚠️ **Nota**: `solid-js` resuelve al build server bajo bun (condición `node`),
> donde `onMount`/`createEffect` son no-ops — por eso los tests del controller
> cubren las acciones explícitas (toggle/startConnect/cancel/disconnect) y la
> resolución de transporte, no la carga de status al montar (esa ruta se cubre
> en la matriz de pruebas manuales del desktop).

## Roadmap

- Integraciones sobre el conector GitHub (issues, releases, kanban, ...).
- Registrar las OAuth Apps de Google y Microsoft y rellenar sus client ids en
  el registry.
- Conectores adicionales (Notion, Slack, ...) requieren redirect localhost +
  PKCE (no device flow) — fase 2 del framework.
