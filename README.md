# scaled Schedule

A free, open-source project scheduler: task table, Gantt chart, critical path, resources and costs, with
files that move to Microsoft Project, Primavera P6 and Jira. It runs in the browser, needs no install or
account, and keeps your files on your own computer.

## Run it

- **Online:** scaledcorp.com (coming soon).
- **On your computer:** double-click `run_local.bat` (needs Python), or run
  `python -m http.server 5080` in this folder and open http://localhost:5080/app/.
- **Tests:** open http://localhost:5080/tests/ (engine, calendar, outline edits and every file format).

### Install it like a desktop app (Edge or Chrome)

1. Open https://scaledcorp.github.io/scaled-schedule/app/ in Edge or Chrome.
2. Click **Install** in the toolbar (or the install icon in the address bar).
3. scaled Schedule gets its own window and Start menu icon, and works offline.
4. Double-click any `.sched` file. The first time, Windows asks which app to use, or the app asks
   permission to open `.sched` files: choose scaled Schedule and allow it. After that, `.sched` files
   open straight into the app, and Ctrl+S saves back to the same file.

## What it does today (v0.1)

- Tasks, summary tasks and milestones; durations in hours, days, weeks or months
- Links of all four types with lag; constraints; critical path and float; circular-link warnings
- Calendar with work week, hours and holidays (one click adds US federal holidays)
- Resources with rates and max units, assignments, work and cost, over-booking warnings
- Progress, baselines with ghost bars, undo/redo, autosave, light and dark themes
- Drag bars to move them, drag their right edge to stretch, drag the dot onto another bar to link
- Open: `.sched` (its own format), Microsoft Project XML, CSV, Jira CSV export
- Save and export: `.sched`, Microsoft Project XML, Primavera P6 XER, CSV, Jira import CSV

## Keyboard

| Keys | Does |
|---|---|
| Type, Enter, F2 | Edit the selected cell |
| Arrows, Tab | Move around the table |
| Ctrl+Enter / Insert | Add a task below / insert one above |
| Delete | Delete selected tasks (Undo in the message) |
| Alt+Shift+Right / Left | Indent / outdent |
| Alt+Shift+Up / Down | Move a task (and its children) |
| Ctrl+L / Ctrl+Shift+L | Link / unlink selected tasks |
| Shift+F2 | Task details |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+O | Save / open |
| Ctrl+K | All commands |
| Ctrl+scroll | Zoom the Gantt |

## Moving schedules to other tools

- **Microsoft Project:** Export → Microsoft Project (.xml), then open it in Project. Project users can
  send you their schedule with File → Save As → XML.
- **Primavera P6:** Export → Primavera P6 (.xer), then File → Import in P6 Professional. P6 can also
  import the Microsoft Project XML. Summary tasks become WBS elements.
- **Jira:** export your issues from Jira as CSV and open the file here (epics become summary tasks).
  Export → Jira (.csv) gives a file for Jira's "Import issues from CSV".
- **ProjectLibre:** opens the Microsoft Project XML (it ignores holidays in that file).

See [CONCEPT.md](CONCEPT.md) for the plan, the feature checklist and what's next.

## License

MIT. Copyright (c) 2026 scaled, LLC. Written from scratch; no code from ProjectLibre or other schedulers.
