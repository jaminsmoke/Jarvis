#!/usr/bin/env python3
"""Informe reproducible de sincronización con upstream (Issue #41).

Genera un reporte de ahead/behind y de commits candidatos entre `dev` y
`upstream/dev`, marcando los commits que la política del proyecto excluye de
cada sync (chore:generate, cambios de workflows y bumps de dependencias).

Uso:
    python scripts/upstream-report.py [--no-fetch]

El script NO mergea nada: solo informa. La sincronización se decide en el
kanban (item dedicado) y se ejecuta con cherry-picks seleccionados en una
rama/PR separada, nunca directamente sobre dev.

Salida: markdown a stdout, listo para publicar como issue/comentario.
"""

import subprocess
import sys
from dataclasses import dataclass, field

# Categorías excluidas por política (decisión acordada 2026-08-10, Issue #41).
EXCLUDED_SUBJECT_MARKERS = (
    "generate",  # chore:generate / chore: regenerate — sobrescribe artefactos rebrandeado
)
EXCLUDED_FILE_PREFIXES = (
    ".github/workflows",  # nunca reactivar workflows heredados
)
EXCLUDED_FILE_NAMES = (
    "package.json",
    "bun.lock",
    "bunfig.toml",  # bumps de dependencias requieren decisión explícita
)
GENERATED_ARTIFACTS = (
    "packages/sdk/openapi.json",
    "packages/sdk/js/src/v2/gen",
    "packages/protocol/src/groups",
)


@dataclass
class UpstreamCommit:
    sha: str
    subject: str
    files: list[str] = field(default_factory=list)
    excludable: bool = False
    exclude_reason: str = ""


def parse_rev_list_count(output: str) -> tuple[int, int]:
    """Parsea la salida de `git rev-list --left-right --count a...b`.

    Devuelve (solo_en_a, solo_en_b). Con `upstream/dev...HEAD`, el primer
    número son los commits de upstream que no tenemos (behind) y el segundo
    los que tenemos y upstream no (ahead).
    """
    parts = output.strip().split()
    if len(parts) != 2:
        raise ValueError(f"Salida inesperada de rev-list --count: {output!r}")
    try:
        return int(parts[0]), int(parts[1])
    except ValueError as exc:  # pragma: no cover - solo falla con git corrupto
        raise ValueError(f"No se pudieron parsear los conteos: {output!r}") from exc


def parse_commits(raw: str) -> list[tuple[str, str]]:
    """Parsea `git log --oneline` en (sha, subject)."""
    commits = []
    for line in raw.strip().splitlines():
        if not line.strip():
            continue
        sha, _, subject = line.partition(" ")
        commits.append((sha, subject))
    return commits


def classify_commit(sha: str, subject: str, files: list[str]) -> UpstreamCommit:
    """Determina si un commit es excluible según la política de sync."""
    commit = UpstreamCommit(sha=sha, subject=subject, files=files)
    low = subject.lower()
    if any(marker in low for marker in EXCLUDED_SUBJECT_MARKERS):
        commit.excludable = True
        commit.exclude_reason = "subject con 'generate' (regenera artefactos rebrandeado)"
        return commit
    for f in files:
        if f.startswith(EXCLUDED_FILE_PREFIXES):
            commit.excludable = True
            commit.exclude_reason = f"toca workflows ({f})"
            return commit
        if f.split("/")[-1] in EXCLUDED_FILE_NAMES:
            commit.excludable = True
            commit.exclude_reason = f"toca dependencias ({f})"
            return commit
    return commit


def files_for_commit(sha: str) -> list[str]:
    """Archivos tocados por un commit (git diff-tree)."""
    out = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", sha],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [line for line in out.strip().splitlines() if line.strip()]


def build_report(behind: int, ahead: int, commits: list[UpstreamCommit]) -> str:
    """Renderiza el informe markdown."""
    lines = [
        "# Informe de sincronización upstream",
        "",
        f"- **Behind** (commits de upstream que no tenemos): `{behind}`",
        f"- **Ahead** (commits nuestros que upstream no tiene): `{ahead}`",
        f"- **Candidatos**: {len([c for c in commits if not c.excludable])} "
        f"de {len(commits)} commits de upstream",
        "",
        "## Commits de upstream pendientes",
        "",
    ]
    if not commits:
        lines.append("_Sin commits pendientes._")
    for commit in commits:
        marker = "[EXCLUIDO]" if commit.excludable else "[candidato]"
        files = ", ".join(commit.files[:6]) or "(sin archivos)"
        reason = f" — {commit.exclude_reason}" if commit.exclude_reason else ""
        lines.append(f"- `{commit.sha[:8]}` {marker}: {commit.subject}{reason}")
        lines.append(f"  - Archivos: {files}")
    lines.append("")
    lines.append("> El informe NO mergea nada. La sync se decide en el kanban y se")
    lines.append("> ejecuta con cherry-picks seleccionados en rama/PR separada.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    no_fetch = "--no-fetch" in argv

    try:
        if not no_fetch:
            subprocess.run(["git", "fetch", "upstream", "dev"], check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: falló `git fetch upstream dev`: {exc.stderr.decode(errors='replace')}", file=sys.stderr)
        return 1

    try:
        count_out = subprocess.run(
            ["git", "rev-list", "--left-right", "--count", "upstream/dev...HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        behind, ahead = parse_rev_list_count(count_out)

        log_out = subprocess.run(
            ["git", "log", "--oneline", "upstream/dev", "^HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        commits = []
        for sha, subject in parse_commits(log_out):
            files = files_for_commit(sha)
            commits.append(classify_commit(sha, subject, files))
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: comando git falló: {exc}", file=sys.stderr)
        return 1

    print(build_report(behind, ahead, commits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
