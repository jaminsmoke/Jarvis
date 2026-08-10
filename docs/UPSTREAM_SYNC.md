# Sincronización con upstream (OpenCode)

Jarvis es un fork de [sst/opencode](https://github.com/sst/opencode). Este
documento define el flujo seguro para incorporar mejoras de upstream sin
perder identidad ni reactivar infraestructura ajena (Issue #41).

## Decisiones acordadas (2026-08-10)

| Decisión | Valor |
|---|---|
| Cadencia | **Informe semanal automático** (solo reporte) + **sync bajo demanda** como item de kanban |
| Integración | **Cherry-pick de commits seleccionados** por lote pequeño, nunca merge periódico |
| Revisión | **4 categorías obligatorias** de revisión manual (checklist abajo) |
| Regla de oro | La sync **nunca va directo sobre `dev`**: siempre rama/PR separada |

## Procedimiento

1. **Informe**: `python scripts/upstream-report.py` (o el cron semanal
   `upstream-report.yml`) — muestra ahead/behind y commits candidatos con los
   excluibles marcados `[EXCLUIDO]`.
2. **Decisión**: si hay candidatos de valor, crear un item en el kanban
   (Detectado) referenciando el informe.
3. **Rama/PR**: crear rama corta (`sync-upstream-YYYYMMDD`), cherry-pick los
   commits seleccionados **uno a uno**.
4. **Checklist obligatoria** (4 categorías, ver abajo) + gates (typecheck,
   tests, ci-quality).
5. **Merge a `dev`** tras pasar la checklist y los gates.

## Checklist de revisión manual (4 categorías)

> Debe pasarse en CADA sync, sin excepciones.

### 1. Workflows (allowlist)

- [ ] Ningún workflow heredado se reactivó: `.github/workflows/` solo debe
      contener `ci-quality.yml`, `release-desktop.yml` y `upstream-report.yml`.
- [ ] Nada nuevo en `.github/workflows/` que no esté aprobado.
- [ ] `upstream-workflows/` intacto (carpeta inerte, no se toca).

### 2. Contratos generados (regresión de branding)

- [ ] `packages/sdk/openapi.json` y `packages/sdk/js/src/v2/gen/` **sin
      cambios** en la sync (el `chore: generate` de upstream se excluye).
- [ ] `packages/protocol/src/groups/` sin strings "OpenCode" nuevos.
- [ ] Si algo tocó artefactos generados: revertirlo y regenerar con
      `script/generate.ts` si fuera necesario.

### 3. Strings visibles (branding)

- [ ] `grep -rn "OpenCode"` en user-facing (providers, descripciones, UI):
      solo deben quedar identificadores técnicos permitidos
      (`OpenCodeHttpApi`, `OpenCodeEvent`, UAs lowercase, comandos).
- [ ] Sin nombres visibles "OpenCode" en mensajes, tooltips o docs del producto.

### 4. Dependencias

- [ ] `package.json` / `bun.lock`: cualquier bump requiere decisión explícita
      en el item de kanban; no se arrastra en silencio.
- [ ] Sin nuevas dependencias no deseadas.

## Exclusiones automáticas (script)

El script marca como `[EXCLUIDO]` los commits que tocan:

- subjects con "generate" (`chore: generate`, regeneraciones)
- `.github/workflows/**`
- `package.json`, `bun.lock`, `bunfig.toml`

## Primeros auxilios

- **Cherry-pick con conflictos**: resolver commit a commit; `git cherry-pick
  --abort` si uno no aplica limpio y evaluar si vale la pena.
- **Algo indeseado entró en la PR**: revertir el archivo/cambio antes del
  merge; nunca mergear una PR con la checklist incompleta.
- **El cron falla** (upstream cambió refs): el script reporta el error sin
  romper; abrir issue de aviso si es recurrente.
