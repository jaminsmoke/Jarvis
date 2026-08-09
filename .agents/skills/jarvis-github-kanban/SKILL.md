---
name: jarvis-github-kanban
description: Flujo completo de gestión de ítems en GitHub Projects. Usar SIEMPRE al crear, mover, debatir, ejecutar o cerrar ítems del kanban. Cubre estados, mutaciones GraphQL, labels, versiones, changelog auto-generado, y el ciclo de vida DraftIssue→Issue→Close. También al crear versiones nuevas, campos nuevos, o auditar el kanban.
---

# GitHub Kanban Workflow — Skill reutilizable

Flujo completo de gestión de ítems en un GitHub Project (kanban). Esta skill **no hardcodea IDs** — el agente debe descubrirlos dinámicamente para cada proyecto.

> 🛠 **Herramienta principal**: `bun kanban ...` (CLI TypeScript). Los IDs se cargan desde `.kanbanrc.json`.
> Usar `@jarvis-github-agentuse` para operaciones complementarias (issues, releases, secrets).

---

## 🔍 Paso 0: Descubrimiento del proyecto (SIEMPRE al iniciar)

Antes de cualquier operación, identificar el proyecto con el que se va a trabajar:

### 0.1 Encontrar el proyecto

```bash
# Listar proyectos del owner (user u org)
gh project list --owner <owner>

# Si ya sabes el número: project #N
gh project view <N> --owner <owner> --json title,url,id
```

### 0.2 Obtener todos los campos y opciones

```bash
# Listar campos con sus IDs
gh project field-list <N> --owner <owner> --format json

# Obtener IDs de opciones (para SingleSelect)
gh api graphql -f query='
query($projectId:ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field { id name }
          ... on ProjectV2SingleSelectField {
            id name
            options { id name }
          }
        }
      }
    }
  }
}' -F projectId=<PROJECT_ID>
```

> ⚠️ **Importante**: los IDs de campos y opciones son específicos de cada Project. NUNCA asumirlos de memoria — siempre consultarlos.

### 0.3 Guardar los IDs descubiertos para la sesión

Una vez obtenidos projectId, fieldIds y optionIds, **memorizarlos para toda la sesión**. Si existe la CLI:

```bash
# Genera/actualiza .kanbanrc.json con todos los IDs
bun kanban config generate --project <PROJECT_ID>
```

Sin CLI, mantener un registro mental o en variable de los IDs clave:
- `PROJECT_ID`, `REPO_ID`
- `STATUS_FIELD_ID` + optionIds de cada estado
- `VERSION_FIELD_ID` + optionIds
- `TIPO_FIELD_ID`, `AREA_FIELD_ID` + sus optionIds

Esto evita re-consultar la API en cada paso.

### 0.4 Consultar la release latest (para versión objetivo)

```bash
gh release list --repo <owner/repo> --limit 1 --json tagName
```

### 0.5 Si existe `.kanbanrc.json`, cargarlo

```bash
cat .kanbanrc.json
```

La CLI (`bun kanban`) lo carga automáticamente si existe en la raíz.

---

## Setup del Project (primera vez, sin CLI)

### 1. Crear el Project

Ir a `https://github.com/users/<owner>/projects` → New project → elegir **"Kanban"** como template.

### 2. Vincular el repositorio

Project Settings → Linked repositories → buscar el repo → Link. Esto habilita convertir Drafts a Issues del repo.

### 3. Crear campos personalizados

Project Settings → Fields → + New field. Estructura recomendada:

| Campo | Tipo | Opciones |
|---|---|---|
| **Status** | SingleSelect | Detectado, Debate, Roadmap, Ejecutando, Verificando, Changelog |
| **Versión** | SingleSelect | Sin asignar, v0.1.0, ... |
| **Prioridad** | SingleSelect | Alta, Media, Baja |
| **Decisión** | SingleSelect | Pendiente, Aprobado, Diferido, Cancelado |
| **Tipo** | SingleSelect | Bug, Feature, Maintenance, Security, Decision |
| **Área principal** | SingleSelect | Adaptar al proyecto — ej: App, Desktop, Core, Server, CI, Infra, Docs, Lint, Dependencies, Release, Governance, Upstream |
| **HighLighted** | SingleSelect | Yes, No |

> 💡 **Las opciones de arriba son ejemplos**. Adaptar Tipo, Área principal y Versión a la estructura real del proyecto.

Campos Date: **Inicio**, **Completado**. Campos Text: **Inicio exacto**, **Completado exacto**.

> ⚠️ Tras crear campos, obtener sus IDs con el paso 0.2 y generar `.kanbanrc.json` con `bun kanban config generate --project <PROJECT_ID>`.

### 4. Configurar la vista Kanban

En la vista principal — **solo UI, no hay API**:
- **Layout**: Board
- **Group by**: Status
- **Sort**: manual (drag & drop)
- **Visible fields**: Title, Status, Versión, Prioridad, Tipo, Área principal

### 5. Workflow de estados

Project Settings → Workflows → Status → Changelog → Set item to "Done" (close issue).

---

## CLI kanban — referencia rápida

```bash
# Crear item con plantilla completa
bun kanban create --title "Titulo" --tipo Bug --area Desktop --priority Alta

# Leer/editar body
bun kanban body <itemId>                    # leer
bun kanban body <itemId> --set "..."        # reemplazar
bun kanban body <itemId> --append "Plan" "contenido"  # añadir sección

# Gestionar campos
bun kanban create-field --name "Nuevo Campo" --data-type SINGLE_SELECT --options "A:BLUE,B:GREEN"
bun kanban add-option --field-id "<FIELD_ID>" --name "Opcion C" --color PURPLE --desc "Descripción"
bun kanban update-field --field-id "<FIELD_ID>" --options "A:BLUE,B:GREEN,C:PURPLE"
bun kanban delete-field --field-id "<FIELD_ID>"

# Convertir Draft a Issue
bun kanban convert-draft <itemId>

# Mover / archivar items
bun kanban move <itemId> [--after <afterId>]
bun kanban archive <itemId>
bun kanban unarchive <itemId>
bun kanban clear-field <itemId> --field-id "<FIELD_ID>"

# Generar .kanbanrc.json con los IDs del proyecto
bun kanban config generate --project <PROJECT_ID>
```

Si la CLI no está disponible, usar `gh api graphql` con las queries documentadas abajo.

---

## Ciclo de vida de un item

```
Detectado → Debate → Roadmap → Ejecutando → Verificando → Changelog
  Draft      Draft     Draft     Issue OPEN    Issue OPEN    Issue CLOSED
```

### Reglas generales

- **0 Drafts en Changelog**: todos los items en Changelog deben ser Issues reales cerrados.
- **Sin saltos**: cada item avanza en orden. Excepción: Cancelado va directo a Changelog.
- **Versión objetivo móvil**: siguiente versión posterior a la release `latest`. Consultar siempre con `gh release list`.
- **Body acumulativo**: el cuerpo empieza en Detectado y evoluciona sin perder secciones.
- **1 Tipo + 1 Área**: exactamente una label de cada al convertir a Issue.
- **`Sin asignar`** en Versión es inconsistencia — siempre corregir.

### 1. Detectado → Crear item

```bash
bun kanban create \
  --title "Título descriptivo" \
  --tipo Bug --area Desktop --priority Alta
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
2. <pregunta>

## Criterio para avanzar
<evidencia mínima para pasar a Roadmap>

## Clasificación preliminar
- Tipo: <bug|feature|maintenance|security|decision>
- Área: <app|desktop|core|server|CI|infra|docs|lint|dependencies|release|governance|upstream>
- Labels esperadas: <label1>, <label2>
- Prioridad: <Alta|Media|Baja>
- Versión objetivo: <siguiente a latest>
```

**Bajo nivel (GraphQL)**:
```graphql
mutation($projectId:ID!, $title:String!, $body:String!) {
  addProjectV2DraftIssue(input: {projectId: $projectId, title: $title, body: $body}) {
    projectV2Item { id }
  }
}
```

### 2. Debate → Discutir y decidir

Mover a Debate. Obtener el optionId correcto del paso 0.2:

```bash
# Con GraphQL (reemplazar fieldId y optionId con los valores descubiertos)
gh api graphql -f query='
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: {singleSelectOptionId: $optionId}
  }) { clientMutationId }
}' -F projectId=<PROJECT_ID> -F itemId=<ITEM_ID> \
   -F fieldId=<STATUS_FIELD_ID> -F optionId=<DEBATE_OPTION_ID>
```

Actualizar el cuerpo con alternativas y trade-offs:
```bash
bun kanban body <itemId> --append "Alternativas" "1. Opción A: ...\n2. Opción B: ..."
```

Al cerrar el debate:
- `Decisión: Aprobado` → avanza a Roadmap
- `Decisión: Cancelado` → documentar motivo, convertir a Issue, cerrar, Changelog
- `Decisión: Diferido` → documentar motivo y condición, devolver a Detectado

### 3. Roadmap → Planificar

Mover a Roadmap. Añadir al cuerpo:
```bash
bun kanban body <itemId> --append "Plan aprobado" "1. Crear branch feature/x\n2. Implementar..."
bun kanban body <itemId> --append "Criterios de aceptación" "- [ ] typecheck limpio\n- [ ] test manual OK"
```

Secciones requeridas en el body:
```markdown
## Decisión acordada
<opción elegida y razones>

## Plan aprobado
1. <cambio concreto>
2. <siguiente paso>

## Criterios de aceptación
- [ ] <resultado observable>

## Plan de verificación
- <typecheck/lint/tests>

## Riesgos y recuperación
<riesgos y forma de revertir>
```

### 4. Ejecutando → Convertir a Issue (ANTES de escribir código)

```bash
# 1. Convertir DraftIssue → Issue
bun kanban convert-draft <ITEM_ID>
# Output: { itemId, issueNumber, issueUrl }

# 2. Añadir labels según Tipo + Área
gh issue edit <N> --repo <owner/repo> --add-label "feature,infra"

# 3. Mover Status a Ejecutando (GraphQL o CLI)
```

**Bajo nivel (sin CLI) — conversión Draft → Issue**:
```graphql
mutation($itemId:ID!, $repoId:ID!) {
  convertProjectV2DraftIssueItemToIssue(input: {
    itemId: $itemId,
    repositoryId: $repoId
  }) {
    item {
      content {
        ... on Issue { number title }
      }
    }
  }
}
```
- `repositoryId` es el **node id del repo** (obtener con `gh api graphql -f query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id}}' -F owner=<owner> -F repo=<repo>`).
- Verificar después que el content es `Issue` y que title/body se preservaron.
- **Nunca reemplazar** el cuerpo por plantilla vacía.
- Aplicar labels según Tipo + Área.
- Verificar que title, body, labels, Status son coherentes.

### 5. Verificando → Documentar implementación

Mover a Verificando. Añadir al cuerpo SIN borrar contexto:
```bash
bun kanban body <itemId> --append "Implementación" "Commit: <sha>\nArchivos: <lista>\n<decisiones técnicas>"
bun kanban body <itemId> --append "Verificación" "- [x] typecheck ✅\n- [x] tests ✅"
```

### 6. Changelog → Cerrar

```bash
# 1. Añadir verificación final al body
gh issue edit <N> --repo <owner/repo> --body "..."

# 2. Añadir ✅ al título
gh issue edit <N> --repo <owner/repo> --title "✅ Título original"

# 3. Cerrar Issue
gh issue close <N> --repo <owner/repo> -r completed

# 4. Mover Status a Changelog (GraphQL o UI)

# 5. Setear campos de fecha (SIEMPRE el tipo correcto)
#    Inicio, Completado → Date   → value: {date: "YYYY-MM-DD"}
#    Inicio exacto, Completado exacto → Text → value: {text: "<ISO-8601 UTC>"}
#    ⚠️ Usar el tipo equivocado falla silenciosamente.

# 6. Regenerar changelog
python scripts/kanban-sync.py changelog
```

---

## Mutaciones GraphQL clave (bajo nivel)

| Mutación | Input | Uso |
|---|---|---|
| `addProjectV2DraftIssue` | projectId, title, body | Crear Draft |
| `updateProjectV2DraftIssue` | draftIssueId, title, body | Editar Draft |
| `updateProjectV2ItemFieldValue` | projectId, itemId, fieldId, value | Setear cualquier campo |
| `convertProjectV2DraftIssueItemToIssue` | itemId, repositoryId | Draft → Issue |
| `addLabelsToLabelable` | labelableId, labelIds | Añadir labels |
| `closeIssue` | issueId | Cerrar Issue |
| `deleteProjectV2Item` | projectId, itemId | Eliminar item |

---

## Gestión de campos y opciones (API completa)

Todas las operaciones de campos se pueden hacer por API (GraphQL) y CLI:

```bash
# Crear campo nuevo (con opciones iniciales si es SINGLE_SELECT)
bun kanban create-field --name "Estimación" --data-type SINGLE_SELECT \
  --options "Small:BLUE,Medium:YELLOW,Large:RED"

# Añadir una opción a un campo SingleSelect existente
bun kanban add-option --field-id "<FIELD_ID>" --name "XL" --color PURPLE --desc "Extra Large"

# Actualizar todas las opciones de golpe (reemplazo completo)
bun kanban update-field --field-id "<FIELD_ID>" --options "S:BLUE,M:YELLOW,L:RED,XL:PURPLE"

# Eliminar campo
bun kanban delete-field --field-id "<FIELD_ID>"
```

**⚠️ Importante**: `add-option` y `update-field` con `--options` hacen un **reemplazo completo** de opciones. Todos los IDs de opciones cambian. Después de cualquier cambio, regenerar `.kanbanrc.json`:
```bash
bun kanban config generate --project <PROJECT_ID>
```

### DataTypes soportados
`TEXT`, `SINGLE_SELECT`, `MULTI_SELECT`, `NUMBER`, `DATE`, `ITERATION`

### Colores válidos para opciones
`GRAY`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `RED`, `PINK`, `PURPLE`

---

## Versión objetivo móvil

1. **Consultar release `latest`** → `gh release list --repo <owner/repo> --limit 1 --json tagName`
2. Derivar siguiente patch: `vX.Y.(Z+1)`.
3. Si el alcance exige minor/major, decidirlo en Debate.
4. **Crear nueva versión (opción en campo Versión)**:
```bash
bun kanban add-option --field-id "<VERSION_FIELD_ID>" \
  --name "v0.1.6" --color BLUE --desc "Versión v0.1.6"
# ⚠️ Todos los IDs de opciones cambian. Regenerar .kanbanrc.json:
bun kanban config generate --project <PROJECT_ID>
```
5. Al publicar la versión, crear preventivamente la siguiente opción.
6. `Sin asignar` es siempre inconsistencia — corregir.

---

## Labels canónicas

> 💡 **Ejemplo para un monorepo desktop**. Las labels deben reflejar la estructura real del proyecto. Consultar las existentes con `gh label list --repo <owner/repo>` y adaptar esta tabla. La regla de oro: **1 Tipo + 1 Área** por issue.

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
| `upstream` | Sincronización con upstream |
| `bug` | Comportamiento incorrecto |
| `feature` | Capacidad nueva observable |
| `maintenance` | Refactor, mejora de proceso |
| `security` | Vulnerabilidad, secreto, hardening |
| `decision` | Decisiones |

- Elegir exactamente 1 Tipo + 1 Área antes de Ejecutando.
- No usar `feature` para bugs, CI, docs, seguridad.
- No mezclar aliases heredados: `documentation` → `docs`, `enhancement` → `feature`.

---

## Changelog auto-generado

> 🛠 **Parte del ecosistema kanban-cli**. `scripts/kanban-sync.py` y `docs/changelog.*` son herramientas que acompañan a esta skill. Si el proyecto no las tiene, adoptarlas del repo de referencia o crear equivalentes.

- **`docs/changelog.html`**: todos los Issues cerrados agrupados por versión.
- **`docs/changelog.json`**: solo items con `HighLighted: Yes` (3-5 por versión).
- Ambos se regeneran con `python scripts/kanban-sync.py changelog`.
- El HTML es determinista (sin timestamp) — solo cambia si el kanban cambió.

### Script kanban-sync

```bash
python scripts/kanban-sync.py changelog  # Regenera HTML + JSON
python scripts/kanban-sync.py audit      # Verifica campos correctos
```

---

## CI: job changelog

> 🛠 **Parte del ecosistema kanban-cli**. El workflow de CI que regenera el changelog es específico de cada proyecto. Abajo un patrón típico.

Workflow de ejemplo:
- Ejecuta `python scripts/kanban-sync.py changelog`
- Si hay diff en `docs/`, commitea y pushea
- Usa `GH_PAT` (classic PAT con `read:project`) — `GITHUB_TOKEN` no accede a Projects

> ⚠️ **GH_PAT inválido (401)**: actualizar el secreto:
> ```bash
> gh auth token | gh secret set GH_PAT --repo <owner/repo>
> gh run rerun <RUN_ID> --repo <owner/repo> --failed
> ```

---

## Regla: operaciones one-shot SIN scripts temporales

- Ejecutar operaciones puntuales **directamente con `gh` o `bun kanban`**: inline, por stdin, o `python -c` con la lógica inline.
- **NUNCA** crear `_*.py` / `_*.gql` / `.tmp*` / `.sh` para operaciones one-shot.
- **Solo versionar scripts** reutilizables, con docstring y tests.
