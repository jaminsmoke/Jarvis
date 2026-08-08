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

1. **kanban CLI** para el flujo kanban: `bun kanban create`, `bun kanban body`
2. **gh CLI** para el resto: `gh issue view`, `gh release list`, `gh secret set`, `gh label list`
3. **GraphQL** para Projects V2 cuando la CLI no cubre la operación
4. **REST** para operaciones no cubiertas: `gh api --method PATCH /repos/...`
5. **MCP** cuando gh CLI no llega o se necesita formato enriquecido

## Kanban CLI (`bun kanban`)

El toolkit TypeScript en `jaminsmoke/jarvis-skills/packages/kanban-cli` es la herramienta principal para el flujo kanban. Carga automáticamente los IDs desde `.kanbanrc.json`.

```bash
# Crear item con plantilla completa
bun kanban create --title "Titulo" --tipo Bug --area Desktop --priority Alta

# Leer/editar body
bun kanban body <itemId>                    # leer
bun kanban body <itemId> --set "..."        # reemplazar
bun kanban body <itemId> --append "Plan" "..."  # añadir sección
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
gh release view v0.1.4 --repo jaminsmoke/Jarvis --json tagName,isLatest
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

1. **Crear opciones en campo SingleSelect**: NO hay API. Solo UI.
2. **Crear campos nuevos en Project**: NO hay API. Solo UI.
3. **Fine-grained PAT**: no accede a user projects (solo org projects).
4. **GITHUB_TOKEN**: no accede a Projects V2.
5. **groupBy del Kanban**: no hay API — se configura en la UI.
6. **addProjectV2DraftIssue**: no devuelve el item ID (API limitation). La CLI usa retry para encontrarlo por título.
