---
name: jarvis-github-kanban
description: Flujo completo de gestión de ítems en GitHub Projects (Jarvis · Interno). Usar SIEMPRE al crear, mover, debatir, ejecutar o cerrar ítems del kanban. Cubre estados, la CLI kanban, IDs de campos/opciones, labels, versiones, changelog auto-generado, y el ciclo de vida DraftIssue→Issue→Close. También al crear versiones nuevas, campos nuevos, o auditar el kanban.
---

# Jarvis — GitHub Kanban Workflow

Flujo completo de gestión de ítems en el proyecto `Jarvis · Interno` (Project #6 de jaminsmoke).

> 🛠 **Herramienta principal**: `bun kanban ...` (CLI TypeScript en `jaminsmoke/jarvis-skills/packages/kanban-cli`).
> Los IDs de esta skill están en `.kanbanrc.json`. La CLI los carga automáticamente — no necesitas memorizarlos.
> Usar `@jarvis-github-agentuse` para operaciones complementarias (issues, releases, secrets).

## Datos del proyecto

| Dato | Valor |
|---|---|
| Project ID | `PVT_kwHOBM87Yc4Bfu74` |
| Repo ID | `R_kgDOTxw4Iw` |
| Repo | `jaminsmoke/Jarvis` |
| Rama default | `dev` |
| URL kanban | https://github.com/users/jaminsmoke/projects/6 |
| .kanbanrc.json | Raíz del proyecto — cargado automáticamente por la CLI |

## CLI kanban — referencia rápida

```bash
# Crear item con plantilla completa
bun kanban create --title "Titulo" --tipo Bug --area Desktop --priority Alta

# Leer/editar body
bun kanban body <itemId>                    # leer
bun kanban body <itemId> --set "..."        # reemplazar
bun kanban body <itemId> --append "Plan" "contenido"  # añadir sección

# Transicionar entre estados
# (próximo comando: bun kanban move)

# Auditoría + changelog
# (próximo: bun kanban audit, bun kanban changelog)
```

Si la CLI no está disponible, usar los comandos de bajo nivel descritos abajo con `gh api graphql`.

## Setup del Project (primera vez)

### 1. Crear el Project

Ir a https://github.com/users/jaminsmoke/projects → New project → elegir "Kanban" como template. Nombre: `Jarvis · Interno`.

### 2. Vincular el repositorio

Project Settings → Linked repositories → buscar `jaminsmoke/Jarvis` → Link. Esto habilita convertir Drafts a Issues del repo.

### 3. Crear campos personalizados

En Project Settings → Fields → + New field (SingleSelect para todos):

| Campo | Opciones iniciales | Nota |
|---|---|---|
| **Status** | Detectado, Debate, Roadmap, Ejecutando, Verificando, Changelog | Marcar "Changelog" como "Done" en la UI |
| **Versión** | Sin asignar, v0.1.0 | Añadir versiones según releases |
| **Prioridad** | Alta, Media, Baja | |
| **Decisión** | Pendiente, Aprobado, Diferido, Cancelado | |
| **Tipo** | Bug, Feature, Maintenance, Security, Decision | |
| **Área principal** | App, Desktop, Core, Server, CI, Infra, Docs, Lint, Dependencies, Release, Governance, Upstream | |
| **HighLighted** | Yes, No | |

Campos Date: **Inicio**, **Completado**. Campos Text: **Inicio exacto**, **Completado exacto**.

> ⚠️ Los IDs de campos y opciones cambian en cada Project. Generar `.kanbanrc.json` consultando con `gh project field-list` + `gh api graphql`.

### 4. Configurar la vista Kanban

En la vista principal (tab "Kanban") — **solo UI, no hay API**:
- **Layout**: Board
- **Group by**: Status
- **Sort**: manual (drag & drop)
- **Visible fields**: Title, Status, Versión, Prioridad, Tipo, Área principal

### 5. Workflow de estados

Project Settings → Workflows → Status → Changelog → Set item to "Done" (close issue).

## Ciclo de vida de un item

```
Detectado → Debate → Roadmap → Ejecutando → Verificando → Changelog
  Draft      Draft     Draft     Issue OPEN    Issue OPEN    Issue CLOSED
```

### Reglas generales

- **0 Drafts en Changelog**: todos los items en Changelog deben ser Issues reales cerrados.
- **Sin saltos**: cada item avanza en orden. Excepción: Cancelado va directo a Changelog.
- **Versión objetivo móvil**: siguiente versión posterior a la release `latest`.
- **Body acumulativo**: el cuerpo empieza en Detectado y evoluciona sin perder secciones.

### 1. Detectado → Crear item

```bash
bun kanban create \
  --title "Rebranding runtime desktop/src/main" \
  --tipo Maintenance --area Desktop --priority Alta
```

**Obligatorio**: título concreto, cuerpo con plantilla completa, Versión, Prioridad, Inicio e Inicio exacto.

**Plantilla del cuerpo** (la CLI la genera automáticamente):
```markdown
## Contexto
<situación, objetivo, por qué importa ahora>

## Hallazgo y evidencia
<hechos verificables, rutas, versiones, métricas>

## Impacto
<consecuencias técnicas, producto, seguridad>

## Alcance a debatir
<qué decidir, límites>

## Preguntas para Debate
1. <pregunta>

## Criterio para avanzar
<evidencia mínima para pasar a Roadmap>

## Clasificación preliminar
- Tipo: <bug|feature|maintenance|security|decision>
- Área: <app|desktop|core|server|CI|infra|docs|lint|dependencies|release|governance|upstream>
- Labels esperadas: <label1>, <label2>
- Prioridad: <Alta|Media|Baja>
- Versión objetivo: <siguiente a latest>
```

### 2. Debate → Discutir y decidir

Mover a Debate desde la UI (drag & drop) o con GraphQL:
```bash
gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input: {projectId: "PVT_kwHOBM87Yc4Bfu74", itemId: "<ITEM_ID>", fieldId: "PVTSSF_lAHOBM87Yc4Bfu74zhZ_v1g", value: {singleSelectOptionId: "ddac116a"}}) { clientMutationId } }'
```

Actualizar el cuerpo con alternativas y trade-offs:
```bash
bun kanban body <itemId> --append "Alternativas" "1. Opción A: ... 2. Opción B: ..."
```

Al cerrar el debate:
- `Decisión: Aprobado` → avanza a Roadmap
- `Decisión: Cancelado` → documentar motivo, convertir a Issue, cerrar, Changelog
- `Decisión: Diferido` → documentar motivo y condición, devolver a Detectado

### 3. Roadmap → Planificar

Mover a Roadmap (UI o GraphQL). Añadir al cuerpo:
```bash
bun kanban body <itemId> --append "Plan aprobado" "1. Crear branch feature/x\n2. Implementar..."
bun kanban body <itemId> --append "Criterios de aceptación" "- [ ] typecheck limpio\n- [ ] test manual OK"
```

### 4. Ejecutando → Convertir a Issue (ANTES de escribir código)

```bash
# 1. Convertir DraftIssue → Issue (GraphQL)
gh api graphql -f query='mutation { convertProjectV2DraftIssueItemToIssue(input: {itemId: "<ITEM_ID>", repositoryId: "R_kgDOTxw4Iw"}) { clientMutationId } }'

# 2. Verificar que el Issue se creó
gh project item-list 6 --owner jaminsmoke --limit 5 | grep "<title>"

# 3. Añadir labels según Tipo + Área
gh issue edit <N> --repo jaminsmoke/Jarvis --add-label "feature,infra"

# 4. Mover a Ejecutando (UI o GraphQL)
```

- **Nunca reemplazar** el cuerpo por plantilla vacía.
- Aplicar labels según Tipo + Área.
- Verificar que title, body, labels, Status son coherentes.

### 5. Verificando → Documentar implementación

Mover a Verificando. Añadir al cuerpo SIN borrar contexto:
```bash
bun kanban body <itemId> --append "Implementación" "Commit: <sha>\nArchivos: <lista>\n<decisiones técnicas>"
```

### 6. Changelog → Cerrar

```bash
# 1. Añadir verificación final al body
gh issue edit <N> --repo jaminsmoke/Jarvis --body "..."

# 2. Añadir ✅ al título
gh issue edit <N> --repo jaminsmoke/Jarvis --title "✅ Título original"

# 3. Cerrar Issue
gh issue close <N> --repo jaminsmoke/Jarvis -r completed

# 4. Mover a Changelog (UI o GraphQL)

# 5. Regenerar changelog
python scripts/kanban-sync.py changelog
```

## IDs de campos y opciones (Project #6)

> 🔧 **No memorizar** — la CLI los carga de `.kanbanrc.json`. Esta tabla es referencia para operaciones manuales.

### Campos

| Campo | Field ID |
|---|---|
| Status | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_v1g` |
| Versión | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_weA` |
| Prioridad | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_wb4` |
| Decisión | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_wb0` |
| Tipo | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_wbw` |
| Área principal | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_wwc` |
| HighLighted | `PVTSSF_lAHOBM87Yc4Bfu74zhZ_wbs` |

### Status

| Opción | ID |
|---|---|
| Detectado | `ef2fdff4` |
| Debate | `ddac116a` |
| Roadmap | `0ca99905` |
| Ejecutando | `79f82a08` |
| Verificando | `741a25fa` |
| Changelog | `f9a1286b` |

### Resto de opciones

Consultar `.kanbanrc.json` en la raíz del proyecto para Prioridad, Decisión, Tipo, Área, Versión, HighLighted.

## Versión objetivo móvil

1. Consultar release `latest` en GitHub. No asumirla.
2. Derivar siguiente patch: `vX.Y.(Z+1)`.
3. Si el alcance exige minor/major, decidirlo en Debate.
4. **Crear nueva versión**: NO hay API. Ir a Project Settings → Fields → Versión → Add option. Luego regenerar `.kanbanrc.json`.
5. Al publicar la versión, crear preventivamente la siguiente opción.
6. `Sin asignar` es siempre inconsistencia — corregir.

## Labels canónicas

| Label | Cuándo usarla |
|---|---|
| `app` | Cambios en `packages/app/` o experiencia web |
| `desktop` | Cambios en `packages/desktop/`, Electron o updater |
| `docs` | Documentación, AGENTS.md, GitHub Pages |
| `CI` | Workflows, checks, runners |
| `infra` | Releases, signing, automatización del Kanban |
| `lint` | Deuda o reglas de lint |
| `dependencies` | Actualizaciones de dependencias |
| `core` | Runtime central |
| `server` | Servidor, API |
| `release` | Proceso de release, artefactos |
| `governance` | Ownership, políticas |
| `upstream` | Sincronización con OpenCode |
| `bug` | Comportamiento incorrecto |
| `feature` | Capacidad nueva observable |
| `maintenance` | Refactor, mejora de proceso |
| `security` | Vulnerabilidad, secreto, hardening |
| `decision` | Decisiones D-XXX |

## Changelog auto-generado

- **`docs/changelog.html`**: todos los Issues cerrados agrupados por versión.
- **`docs/changelog.json`**: solo items con `HighLighted: Yes`.
- Ambos se regeneran en CI (`ci-quality.yml` job `changelog`).
- Se ejecutan con `python scripts/kanban-sync.py changelog`.

## CI: job changelog

En `ci-quality.yml`:
- Ejecuta `python scripts/kanban-sync.py changelog`
- Si hay diff en `docs/`, commitea y pushea
- Usa `GH_PAT` (classic PAT con `read:project`)

## Regla: operaciones one-shot SIN scripts temporales

- Ejecutar operaciones puntuales **directamente con `gh` o `bun kanban`**: inline, por stdin, o `python -c` con la lógica inline.
- **NUNCA** crear `_*.py` / `_*.gql` / `.tmp*` / `.sh` para operaciones one-shot.
- **Solo versionar scripts** reutilizables (`kanban-sync.py`, `generate-changelog-json.py`), con docstring y tests en `scripts/tests/`.
