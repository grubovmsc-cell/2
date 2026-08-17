#!/usr/bin/env python3
"""
Repository audit snapshot generator.

Run from the repository root:
    python3 repo_audit.py

Output:
    REPO_AUDIT.md

The report intentionally avoids printing detected secret VALUES.
"""

import os
import re
import subprocess
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime

ROOT = Path.cwd()
OUTPUT = ROOT / "REPO_AUDIT.md"

IGNORE_DIRS = {
    ".git", ".idea", ".vscode",
    "node_modules", "vendor",
    ".next", "dist", "build", "out",
    ".cache", ".turbo",
    "__pycache__", ".pytest_cache",
    ".venv", "venv", "env",
    "coverage", ".coverage",
    "tmp", "temp",
    "uploads",
}

TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx",
    ".java", ".kt", ".go", ".rs",
    ".php", ".rb",
    ".cs", ".cpp", ".c", ".h", ".hpp",
    ".vue", ".svelte",
    ".sql", ".graphql",
    ".sh", ".bash",
    ".yaml", ".yml", ".json", ".toml",
    ".md", ".html", ".css", ".scss",
}

CODE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx",
    ".java", ".kt", ".go", ".rs",
    ".php", ".rb",
    ".cs", ".cpp", ".c",
    ".vue", ".svelte",
}

IMPORTANT_FILES = {
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "Pipfile",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "composer.json",
    "Gemfile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".env.example",
    "README.md",
    "Makefile",
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "eslint.config.js",
    "eslint.config.mjs",
}


def ignored(path: Path) -> bool:
    try:
        rel = path.relative_to(ROOT)
    except ValueError:
        return True

    parts = rel.parts
    if any(part in IGNORE_DIRS for part in parts):
        return True

    rel_str = str(rel).replace("\\", "/")
    return any(rel_str.startswith(ignore + "/") for ignore in IGNORE_DIRS)


def all_files():
    return [p for p in ROOT.rglob("*") if p.is_file() and not ignored(p)]


def safe_read(path: Path, max_chars=30000):
    try:
        data = path.read_text(encoding="utf-8", errors="ignore")
        if len(data) > max_chars:
            return data[:max_chars] + "\n\n...[TRUNCATED]..."
        return data
    except Exception:
        return ""


def line_count(path: Path):
    try:
        return len(path.read_text(encoding="utf-8", errors="ignore").splitlines())
    except Exception:
        return 0


def run_git(args):
    try:
        return subprocess.check_output(
            ["git"] + args,
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return ""


def tree(files):
    lines = []
    for path in sorted(files):
        rel = path.relative_to(ROOT)
        depth = len(rel.parts) - 1
        if depth <= 6:
            lines.append("  " * depth + "└── " + rel.name)
    return "\n".join(lines[:3500])


def detect_languages(files):
    counter = Counter()
    for p in files:
        counter[p.suffix.lower() or "(none)"] += 1
    return counter


def largest_code_files(files):
    result = []
    for p in files:
        if p.suffix.lower() in CODE_EXTENSIONS:
            result.append((line_count(p), str(p.relative_to(ROOT))))
    return sorted(result, reverse=True)[:80]


def important_file_contents(files):
    result = {}
    for p in files:
        if p.name in IMPORTANT_FILES:
            result[str(p.relative_to(ROOT))] = safe_read(p, 50000)
    return result


def scan_todos(files):
    patterns = [r"\bTODO\b", r"\bFIXME\b", r"\bHACK\b", r"\bXXX\b"]
    results = []

    for p in files:
        if p.suffix.lower() not in TEXT_EXTENSIONS:
            continue

        content = safe_read(p, 250000)
        for number, line in enumerate(content.splitlines(), 1):
            if any(re.search(pattern, line, re.I) for pattern in patterns):
                results.append(
                    (str(p.relative_to(ROOT)), number, line.strip()[:300])
                )
    return results[:500]


def scan_tests(files):
    tests = []
    for p in files:
        name = p.name.lower()
        rel = "/" + str(p.relative_to(ROOT)).replace("\\", "/").lower() + "/"
        if (
            "test" in name
            or "spec" in name
            or "/tests/" in rel
            or "/__tests__/" in rel
        ):
            tests.append(str(p.relative_to(ROOT)))
    return sorted(set(tests))


def scan_possible_entrypoints(files):
    candidates = []
    exact = {
        "main.py", "app.py", "server.py", "manage.py",
        "index.js", "index.ts", "server.js", "server.ts",
        "main.js", "main.ts", "main.go", "Program.cs",
    }

    for p in files:
        rel = str(p.relative_to(ROOT)).replace("\\", "/")
        if p.name in exact:
            candidates.append(rel)

        if rel.startswith(("src/", "app/", "pages/", "api/", "routes/", "controllers/")):
            if len(Path(rel).parts) <= 4:
                candidates.append(rel)

    return sorted(set(candidates))[:300]


def git_churn():
    log = run_git(["log", "--pretty=format:", "--name-only", "-n", "500"])
    if not log:
        return []

    counts = Counter(
        line.strip()
        for line in log.splitlines()
        if line.strip()
    )
    return counts.most_common(80)


def git_authors():
    return run_git(["shortlog", "-sne", "HEAD"])


def imports_summary(files):
    imports = Counter()

    patterns = [
        re.compile(r'import\s+.*?from\s+[\'"]([^\'"]+)'),
        re.compile(r'require\([\'"]([^\'"]+)'),
        re.compile(r'^from\s+([\w\.]+)\s+import', re.M),
        re.compile(r'^import\s+([\w\.]+)', re.M),
    ]

    for p in files:
        if p.suffix.lower() not in {".py", ".js", ".jsx", ".ts", ".tsx"}:
            continue

        content = safe_read(p, 200000)
        for pattern in patterns:
            for match in pattern.findall(content):
                root = str(match).split("/")[0].split(".")[0]
                if root:
                    imports[root] += 1

    return imports.most_common(150)


def directory_stats(files):
    stats = defaultdict(lambda: {"files": 0, "code_lines": 0})

    for p in files:
        rel = p.relative_to(ROOT)
        top = rel.parts[0] if len(rel.parts) > 1 else "(root)"
        stats[top]["files"] += 1

        if p.suffix.lower() in CODE_EXTENSIONS:
            stats[top]["code_lines"] += line_count(p)

    return sorted(
        stats.items(),
        key=lambda x: x[1]["code_lines"],
        reverse=True,
    )


def detect_secret_locations(files):
    patterns = [
        r"api[_-]?key\s*[=:]",
        r"secret[_-]?key\s*[=:]",
        r"access[_-]?token\s*[=:]",
        r"private[_-]?key",
        r"password\s*[=:]",
        r"BEGIN RSA PRIVATE KEY",
        r"BEGIN PRIVATE KEY",
    ]

    findings = []
    for p in files:
        if p.suffix.lower() not in TEXT_EXTENSIONS and not p.name.startswith(".env"):
            continue

        content = safe_read(p, 150000)
        if any(re.search(pattern, content, re.I) for pattern in patterns):
            findings.append(str(p.relative_to(ROOT)))

    return sorted(set(findings))


def detect_env_files(files):
    return sorted(
        str(p.relative_to(ROOT))
        for p in files
        if p.name.startswith(".env")
    )


def markdown_table(rows, headers):
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join(["---"] * len(headers)) + "|",
    ]

    for row in rows:
        lines.append(
            "| "
            + " | ".join(
                str(x).replace("|", "\\|").replace("\n", " ")
                for x in row
            )
            + " |"
        )
    return "\n".join(lines)


def main():
    files = all_files()

    languages = detect_languages(files)
    large_files = largest_code_files(files)
    manifests = important_file_contents(files)
    todos = scan_todos(files)
    tests = scan_tests(files)
    entrypoints = scan_possible_entrypoints(files)
    churn = git_churn()
    imports = imports_summary(files)
    dirs = directory_stats(files)
    secret_locations = detect_secret_locations(files)
    env_files = detect_env_files(files)

    total_code_lines = sum(
        line_count(p)
        for p in files
        if p.suffix.lower() in CODE_EXTENSIONS
    )

    report = []

    report += [
        "# Repository Audit Snapshot",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        "",
        f"Repository: `{ROOT.name}`",
        f"Files scanned: **{len(files)}**",
        f"Approx. code lines: **{total_code_lines:,}**",
        "",
        "## 1. Repository structure",
        "",
        "```text",
        tree(files),
        "```",
        "",
        "## 2. Languages / file types",
        "",
        markdown_table(
            [(ext, count) for ext, count in languages.most_common(70)],
            ["Extension", "Files"],
        ),
        "",
        "## 3. Top-level module sizes",
        "",
        markdown_table(
            [(name, data["files"], data["code_lines"]) for name, data in dirs],
            ["Directory", "Files", "Code lines"],
        ),
        "",
        "## 4. Largest source files",
        "",
        markdown_table(large_files, ["Lines", "File"]),
        "",
        "## 5. Possible application entry points",
        "",
    ]

    if entrypoints:
        report += [f"- `{item}`" for item in entrypoints]
    else:
        report.append("_No obvious entry points detected._")

    report += [
        "",
        "## 6. Tests",
        "",
        f"Detected test/spec files: **{len(tests)}**",
        "",
    ]

    report += [f"- `{test}`" for test in tests[:500]] or ["_No test files detected._"]

    report += [
        "",
        "## 7. Frequently imported modules/packages",
        "",
        markdown_table(imports, ["Module / package", "Import occurrences"]),
        "",
        "## 8. Git change hotspots",
        "",
        "Files changed most frequently in the last ~500 commits.",
        "",
    ]

    if churn:
        report.append(markdown_table(churn, ["Changes", "File"]))
    else:
        report.append("_Git history unavailable or this directory is not a Git repository._")

    report += [
        "",
        "## 9. TODO / FIXME / HACK",
        "",
    ]

    if todos:
        report.append(markdown_table(todos, ["File", "Line", "Text"]))
    else:
        report.append("_None detected._")

    report += [
        "",
        "## 10. Potential secret locations",
        "",
        "Secret VALUES are intentionally not included. Only file locations are listed.",
        "",
    ]

    if secret_locations:
        report += [f"- `{item}`" for item in secret_locations]
    else:
        report.append("_No obvious secret patterns detected._")

    report += [
        "",
        "## 11. Environment files",
        "",
    ]

    if env_files:
        report += [f"- `{item}`" for item in env_files]
    else:
        report.append("_No .env-like files detected._")

    report += [
        "",
        "## 12. Dependency / configuration files",
        "",
    ]

    for filename, content in manifests.items():
        report += [
            f"### `{filename}`",
            "",
            "```text",
            content,
            "```",
            "",
        ]

    report += [
        "## 13. Git contributors",
        "",
        "```text",
        git_authors() or "Git history unavailable",
        "```",
        "",
        "## 14. Next step",
        "",
        "Use this snapshot together with direct repository access for a full architecture review.",
        "The snapshot is intentionally diagnostic, not a substitute for reading the source code.",
        "",
    ]

    OUTPUT.write_text("\n".join(report), encoding="utf-8")

    print(f"Created: {OUTPUT}")
    print(f"Files scanned: {len(files)}")
    print(f"Code lines: {total_code_lines:,}")


if __name__ == "__main__":
    main()
