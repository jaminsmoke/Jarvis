#!/usr/bin/env python3
"""Guard de CI: verifica que la sección "Workflows activos" de AGENTS.md
coincide con los workflows reales de `.github/workflows/`.

Uso: python scripts/check-ci-docs.py
Exit 0 si coincide; exit 1 con el diff si hay drift (para ci-quality).

Sin red ni permisos extra: compara archivos locales. Casos especiales:
- `pages-build-deployment` es gestionado por GitHub (no tiene `.yml` en el repo).
- Los `*.disabled` no se ejecutan y no matchean el glob `*.yml`.
"""

import glob
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ROOT / "AGENTS.md"
WORKFLOWS_DIR = ROOT / ".github" / "workflows"

# Workflows gestionados por GitHub: activos pero sin archivo .yml en el repo.
GITHUB_MANAGED = {"pages-build-deployment"}


def agents_workflows() -> set:
    """Workflows documentados en AGENTS.md (sección '### Workflows activos')."""
    text = AGENTS.read_text(encoding="utf-8")
    m = re.search(r"### Workflows activos\n(.*?)\n### ", text, re.S)
    if not m:
        sys.exit("ERROR: no encuentro la sección '### Workflows activos' en AGENTS.md")
    names = re.findall(r"^\- `([^`]+)`", m.group(1), re.M)
    return set(names)


def actual_workflows() -> set:
    """Workflows realmente activos: archivos *.yml locales + gestionados por GitHub."""
    local = {Path(p).stem for p in glob.glob(str(WORKFLOWS_DIR / "*.yml"))}
    return local | GITHUB_MANAGED


def main() -> int:
    expected = agents_workflows()
    actual = actual_workflows()

    if expected == actual:
        print(
            f"OK: AGENTS.md coincide con los {len(actual)} workflows activos "
            f"({', '.join(sorted(actual))})"
        )
        return 0

    print("DRIFT: AGENTS.md no coincide con los workflows activos de .github/workflows/")
    missing = sorted(actual - expected)
    extra = sorted(expected - actual)
    if missing:
        print(f"  En AGENTS.md FALTA(n) (activos pero no documentados): {', '.join(missing)}")
    if extra:
        print(f"  En AGENTS.md SOBRA(n) (documentados pero no activos): {', '.join(extra)}")
    print("  Corrige la sección '### Workflows activos' de AGENTS.md")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
