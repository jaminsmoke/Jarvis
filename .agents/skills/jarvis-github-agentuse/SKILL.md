---
name: jarvis-github-agentuse
description: "Guía de uso de herramientas GitHub para agentes (kanban CLI, gh CLI, GitHub MCP, GraphQL API, REST API). Usar cuando se necesite interactuar con GitHub: kanban items, issues, PRs, projects, releases, actions, secrets, labels. Cubre qué herramienta usar según el caso, limitaciones de GITHUB_TOKEN, diferencias classic vs fine-grained PAT, y patrones comunes."
---

# Jarvis — GitHub Agent Use

Qué herramienta de GitHub usar en cada situación y cómo sortear sus limitaciones.

## Herramientas disponibles

| Herramienta | Acceso | Ideal para |
|---|---|---|
| **kanban CLI** (`bun kanban ...`) | Projects V2, items, bodies | 90% del flujo kanban |
| **gh CLI** (`gh api`, `gh issue`, `gh release`, etc.) | Todo (con token) | Issues, releases, secrets, labels |
| **GitHub MCP** | Issues, PRs, repos, users | Issues/PRs con formato rico |
| **GraphQL API** (`gh api graphql`) | Projects V2, mutations complejas | Kanban (si CLI no alcanza) |
| **REST API** (`gh api --method`) | Secrets, alerts | CRUD directo |

## Regla general

1. **kanban CLI** para el flujo kanban completo: `bun kanban create`, `body`, `move`, `archive`, `convert-draft`, `create-field`, `add-option`, etc.
2. **gh CLI** para el resto: `gh issue view`, `gh release list`, `gh secret set`, `gh label list`
3. **GraphQL** para Projects V2 cuando la CLI no cubre la operación
4. **REST** para operaciones no cubiertas: `gh api --method PATCH /repos/...`
5. **MCP** cuando gh CLI no llega o se necesita formato enriquecido

## Kanban CLI (`bun kanban`)

El toolkit TypeScript en `jaminsmoke/jarvis-skills/packages/kanban-cli` es la herramienta principal para el flujo kanban. Carga automáticamente los IDs desde `.kanbanrc.json`.

```bash
# Items — ciclo de vida completo
bun kanban create --title "Titulo" --tipo Bug --area Desktop --priority Alta
bun kanban list [--status X] [--tipo X] [--area X]
bun kanban body <itemId>                       # leer body
bun kanban body <itemId> --set "..."           # reemplazar body
bun kanban body <itemId> --append "Plan" "..." # añadir sección
bun kanban move <itemId> [--after <afterId>]   # mover posición
bun kanban archive <itemId>                    # archivar (soft delete)
bun kanban unarchive <itemId>                  # desarchivar
bun kanban delete <itemId> [más IDs...] [--yes]  # ⚠️ borrar definitivo (IRREVERSIBLE, requiere --yes)
bun kanban delete --status <estado> [--yes]    # ⚠️ borrar todos los items de un status
bun kanban clear-field <itemId> --field-id "..."  # limpiar campo
bun kanban convert-draft <itemId>              # DraftIssue → Issue

# Campos — gestión completa
bun kanban create-field --name "..." --data-type SINGLE_SELECT --options "A:BLUE,B:GREEN"
bun kanban update-field --field-id "..." --options "A:BLUE,B:GREEN,C:PURPLE"
bun kanban add-option --field-id "..." --name "..." --color BLUE --desc "..."
bun kanban delete-field --field-id "..."

# Vistas
bun kanban create-view --name "..." [--layout BOARD_LAYOUT] [--visible-fields "Status,Versión,..."]

# Config
bun kanban config generate --project PVT_...   # regenerar .kanbanrc.json
bun kanban config validate                     # validar contra el Project
```

Si la CLI no está disponible (otro proyecto sin `.kanbanrc.json`), usar las mutaciones GraphQL documentadas en `@jarvis-github-kanban`.

## Autenticación

### Tokens

| Tipo | Prefijo | Accede a Projects V2 | Scope |
|---|---|---|---|
| **Classic PAT** | `ghp_...` | ✅ Sí | `read:project`, `repo` |
| **Fine-grained PAT** | `github_pat_...` | ❌ No (solo org projects) | Repos específicos |
| **GITHUB_TOKEN** | `ghs_...` (Actions) | ❌ No | `contents: read/write`, `metadata: read` |

**Conclusión**: para CI que necesita Projects V2, usar **classic PAT** (`ghp_...`) como secreto `GH_PAT`.

### En CI

```yaml
env:
  GH_TOKEN: ${{ secrets.GH_PAT }}  # classic PAT con read:project
```

## Patrones GraphQL (solo si la CLI no cubre el caso)

**Query/mutación corta** — inline:
```bash
gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input: {projectId: "...", itemId: "...", fieldId: "...", value: {singleSelectOptionId: "..."}}) { clientMutationId } }'
```

**Query larga o con body** — por stdin (sin archivos):
```bash
gh api graphql -F query=@- <<'GQL'
query { node(id: "...") { ... on ProjectV2Item { content { ... on DraftIssue { body } } } } }
GQL
```

**Body largo en Python inline** — `json.dumps` para escapar:
```python
import subprocess, json, tempfile, os
fd, fn = tempfile.mkstemp(suffix='.gql')
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(query)
r = subprocess.run(['gh', 'api', 'graphql', '-F', f'query=@{fn}'],
                   capture_output=True, encoding='utf-8', timeout=30)
os.remove(fn)
```

> ⚠️ **Nunca crear archivos script one-shot**. Usar `python -c "..."` inline. Si una operación se repite, convertirla a comando de la CLI kanban.

## Operaciones comunes

### Issues
```bash
gh issue view 4 --repo jaminsmoke/Jarvis --json title,body,state
gh issue edit 4 --repo jaminsmoke/Jarvis --title "nuevo titulo" --add-label security
```

### Releases
```bash
gh release list --repo jaminsmoke/Jarvis
gh release view v0.1.0 --repo jaminsmoke/Jarvis --json tagName,isLatest
```

### Secrets
```bash
echo "token_value" | gh secret set GH_PAT --repo jaminsmoke/Jarvis
```

### Labels
```bash
gh label list --repo jaminsmoke/Jarvis --json name,id
gh label create v0.1.5 --repo jaminsmoke/Jarvis --color 0E8A16
```

### Actions / CI
```bash
gh run list --repo jaminsmoke/Jarvis --workflow ci-quality --limit 5
gh run view 31208918303 --repo jaminsmoke/Jarvis --log --job 92947871728
```

## Limitaciones conocidas

1. **Añadir opciones a SingleSelect**: usar `updateProjectV2Field` (GraphQL) con `singleSelectOptions` pasando TODAS las opciones existentes + la nueva (reemplazo completo). Los IDs de opciones cambian → re-query post-mutación.
2. **Crear campos nuevos**: usar `createProjectV2Field` (GraphQL) o `gh project field-create`. Soporta TEXT, SINGLE_SELECT (con opciones iniciales), MULTI_SELECT, NUMBER, DATE, ITERATION.
3. **Fine-grained PAT**: no accede a user projects (solo org projects).
4. **GITHUB_TOKEN**: no accede a Projects V2.
5. **groupBy / sortBy del Kanban**: existen como campos `groupByFields`/`sortByFields` en el schema pero siempre vacíos — se configuran en la UI. Layout, nombre y campos visibles SÍ son gestionables por API (`createProjectV2View`/`updateProjectV2View`).
6. **updateProjectV2Field con singleSelectOptions**: hace reemplazo completo de opciones. Pasar TODAS (existentes + nuevas). Re-consultar IDs después.

## Mutaciones GraphQL disponibles (Projects V2)

Todas confirmadas contra la API real (2026-08):
- `addProjectV2DraftIssue` → retorna `projectItem { id }` ✅
- `createProjectV2Field` → `dataType`: TEXT, SINGLE_SELECT, MULTI_SELECT, NUMBER, DATE, ITERATION ✅
- `updateProjectV2Field` → `singleSelectOptions`, `multiSelectOptions`, `name` ✅
- `deleteProjectV2Field` ✅
- `convertProjectV2DraftIssueItemToIssue` → requiere `itemId` + `repositoryId` ✅
- `archiveProjectV2Item` / `unarchiveProjectV2Item` ✅
- `deleteProjectV2Item` ✅ (⚠️ irreversible; desvincula el item pero no cierra/borra el Issue subyacente — CLI: `bun kanban delete ... --yes`)
- `clearProjectV2ItemFieldValue` ✅
- `updateProjectV2ItemPosition` ✅
- `copyProjectV2` ✅
- `createProjectV2View` ✅: crea vista con layout + `visibleFieldIds`
- `updateProjectV2View` ✅: renombrar, layout, visible fields
- `deleteProjectV2View` ✅: borrar vista (no la última)
- `updateProjectV2` (title, public, readme, shortDescription) ✅

### SingleSelect option colors
GRAY, BLUE, GREEN, YELLOW, ORANGE, RED, PINK, PURPLE

### ProjectV2SingleSelectFieldOptionInput
`{ name!, color!, description! }` — id es opcional (solo para referenciar opciones existentes)
