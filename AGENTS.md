# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-08

## OVERVIEW
Project: **pi-chrome-assistent**
Stack: *Not yet initialized — empty workspace*

## STRUCTURE
The repository is currently empty. No source files, configuration, or documentation have been added yet.

## COMMANDS
| Action | Command |
|--------|---------|
| Install| *TBD* |
| Test   | *TBD* |
| Build  | *TBD* |
| Run    | *TBD* |

## CODING STANDARDS
*   **Language**: *TBD*
*   **Style**: *TBD*
*   **Rules**: *TBD*

## WHERE TO LOOK
*   **Source**: *TBD*
*   **Tests**: *TBD*
*   **Docs**: *TBD*

## NOTES
*   This workspace was initialized but is empty. No git repository has been created yet.
*   Once code is added, run `/init` again to populate this file with accurate project details.

## RULES
*   **При любой разработке всегда сверяйтесь с документацией Pi** — перед реализацией功能的, интеграцией API, или принятием архитектурных решений читайте документацию Pi (основная документация и примеры из SDK/расширений), чтобы соответствовать актуальным контрактам и рекомендациям фреймворка.
*   **Весь UI/UX должен быть на русском языке** — все пользовательские тексты в popup, content script, overlay, toast, статусах, сообщениях об ошибках, кнопках, плейсхолдерах и любых других интерфейсах должны быть русскоязычными.
*   **Вся пользовательская документация должна быть на русском языке** — `README.md`, `CHANGELOG.md`, инструкции по запуску, troubleshooting и иные документы для конечного пользователя должны быть написаны на русском языке. Технические внутренние заметки и служебные plan/review-артефакты могут оставаться на английском только если это явно требуется процессом, но пользовательская документация — всегда на русском.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Pi-Chrome-Assistent** (2744 symbols, 5895 relationships, 237 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Pi-Chrome-Assistent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Pi-Chrome-Assistent/clusters` | All functional areas |
| `gitnexus://repo/Pi-Chrome-Assistent/processes` | All execution flows |
| `gitnexus://repo/Pi-Chrome-Assistent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
