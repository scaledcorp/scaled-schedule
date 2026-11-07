# scaled Schedule: concept and plan

A free, open-source project scheduler that does what ProjectLibre and Microsoft Project do for most
projects, without the endless settings of Project or Primavera P6. It should feel quick and friendly:
every button responds, bars glide into place when the schedule changes, and the keyboard works the way
Project users expect.

## Decisions (working defaults, open to change)

| Question | Default | Why |
|---|---|---|
| Name | scaled Schedule | Follows "scaled Buildout". Final name is Matthew's call. |
| Platform | Browser app, no build step, no server | Same pattern as the other scaled tools. Runs at scaledcorp.com and as a downloaded copy that works offline. A desktop installer (Tauri or Electron wrapper) can come later without rewriting anything. |
| Where files live | On the user's computer only | Nothing is uploaded. Matches the Client Data and AI Use Policy. Autosave keeps a copy in the browser. |
| License | MIT | Short, well known, lets anyone use and fork it. Matthew may prefer Apache-2.0 (adds a patent grant) or GPL-3.0 (forks must stay open). |
| Code origin | Written from scratch | Nothing copied from ProjectLibre (CPAL license). File formats are public specs. |
| Native file | `.sched` (JSON) | Human-readable, versioned, easy to diff. |

## What it must do (feature checklist)

Status: **v0.1** = in the first build, **next** = planned soon, **later** = on the roadmap.

### Scheduling engine
- [v0.1] Tasks, summary tasks (outline levels), milestones
- [v0.1] Durations in minutes, hours, days, weeks, months (working time)
- [v0.1] Links: finish-to-start, start-to-start, finish-to-finish, start-to-finish, with positive or negative lag
- [v0.1] Constraints: as soon as possible, as late as possible, start no earlier/later than, finish no earlier/later than, must start on, must finish on
- [v0.1] Critical path, total float, late dates, constraint conflict warnings
- [v0.1] Circular link detection (reported, never a hang)
- [v0.1] Project calendar: work week, working hours, holidays, one-click US federal holidays
- [v0.1] Percent complete, actual start and finish
- [v0.1] Baseline: save, show ghost bars, start/finish variance
- [next] Task calendars and resource calendars
- [next] Elapsed durations (e.g. 3 elapsed days for concrete curing)
- [next] Resource leveling (simple, delay-only)
- [later] Multiple baselines, earned value, schedule from finish

### Resources and cost
- [v0.1] Work, material and cost resources; max units; rate per hour; cost per use
- [v0.1] Assignments with units; task work and cost; fixed cost per task
- [v0.1] Over-allocation warnings
- [next] Resource usage histogram and leveling

### Views and feel
- [v0.1] Task grid with inline editing, outline indent/outdent, collapse/expand
- [v0.1] Gantt chart: drag to move, drag to stretch, drag to link, progress, critical path, baseline ghosts, today line, zoom from days to quarters
- [v0.1] Task details card, resource sheet, calendar and project settings
- [v0.1] Undo/redo, command palette (Ctrl+K), Project-style keyboard shortcuts, light and dark themes
- [next] Network diagram, resource usage view, column chooser, filters (critical, late, milestones)
- [next] Print and PDF export of the Gantt
- [later] Large-schedule virtualization (5,000+ tasks)
- [v0.2] Install as an app from Edge or Chrome: own window, works offline, `.sched` files open with a double-click

### Moving schedules in and out
- [v0.1] Microsoft Project XML (MSPDI) export and import. Project opens it directly; P6 Professional can import it too.
- [v0.1] Primavera P6 XER export (needs checking in a real copy of P6)
- [v0.1] CSV export and import
- [v0.1] Jira: import a Jira issue CSV export (epics become summary tasks, estimates become durations, assignees become resources); export tasks as a Jira-importable CSV
- [next] P6 XER import, P6 XML (PMXML) export
- [later] Jira connector app (Atlassian Forge) for live two-way sync. A browser page can't call the Jira API directly (Atlassian blocks cross-site requests), so live sync needs a small app that runs inside Jira.
- Not planned: reading `.mpp` binaries directly (needs a Java library). Ask Project users to save as XML.

## The signature feature: drop in a video, get a schedule (after the bones)

Drop a short explainer video (about 30 seconds) on the window and scaled Schedule writes the tasks,
durations, links and Gantt for you. Matthew's idea, November 6, 2026.

**How to keep it light enough for a laptop:** the core app stays a few hundred kilobytes. The AI parts
are an optional add-on that downloads once, the first time someone uses the feature, and then runs fully
offline in the browser (WebGPU when the laptop has it, plain CPU otherwise). Nothing is uploaded.

| Step | What runs | Approx. size | Why it's enough |
|---|---|---|---|
| 1. Pull the sound track | Browser's own audio decoder | 0 | Built in |
| 2. Speech to text | Whisper tiny or base (open weights, ONNX in the browser) | 40 to 150 MB | An explainer is mostly narration: about 75 words in 30 seconds |
| 3. Read the slides | A few still frames (one every 3 seconds) through OCR (Tesseract, WebAssembly) | about 10 MB | Catches on-screen titles, dates and bullet lists |
| 4. Turn words into a plan | A small open model, e.g. Qwen 0.5B to 1.5B instruct, 4-bit | 400 MB to 1 GB | Forced to answer in a fixed JSON shape (phases, tasks, days, links), so a small model is reliable |
| 5. Build the schedule | The scaled Schedule engine | 0 | The model only proposes tasks; our engine does all the date math |

Then the user reviews it as a draft: tasks appear one by one with a short animation, low-confidence
guesses are highlighted, and one click accepts or undoes the whole thing.

**Options to offer:** (a) the offline add-on above, (b) "use my own model" for people already running
Ollama locally (matches the private LLM lab work), (c) a cloud model with the user's own API key for
the best quality. Same JSON shape for all three, so the rest of the app doesn't care which one ran.

### A little helper bot (same model, Matthew's idea, November 6, 2026)

A small chat box in the corner: "add a 3-day testing task after Build", "move Launch to March 15",
"who is over-booked next week?", "link rows 4 to 9". It reuses the video feature's small model, so it adds
nothing to download. The model never edits the project directly: it picks from the app's own command list
(the same one behind Ctrl+K and every button) and fills in the details, so every change goes through the
normal undo history and can't break the schedule. Questions are answered from the computed schedule
(dates, float, cost), not from the model's memory. Start with a fixed set of about 20 commands; grow it as
people ask for more.

**First proof step:** time Whisper base + Qwen 1.5B on this laptop (Ryzen with integrated graphics) on
three sample explainer videos. Target: under a minute from drop to draft.

## How it's built

```
app/
  index.html          the page
  style.css           all styles (Wake look: Geist, Cherenkov azure, light and dark)
  js/calendar.js      working-time math (add work, subtract work, snap, holidays)
  js/model.js         project data, outline, links, parsing and formatting
  js/scheduler.js     critical path method: forward pass, backward pass, float, rollups, cost
  js/store.js         state, undo/redo, autosave
  js/io/              native .sched, MS Project XML, P6 XER, CSV, Jira CSV
  js/ui/              grid, Gantt, details card, dialogs, command palette, toasts
  js/app.js           wires it together
tests/index.html      engine and file-format tests (open in a browser)
```

Times are stored as whole minutes since 1970 in "floating" local time (no time zone), so daylight saving
time never shifts a schedule. Durations and lags are stored as working minutes.

## Known limits in v0.1
- Links into or out of summary tasks are supported but simplified (start-based links from a summary use
  its earliest child; the backward pass applies them to every child). Linking tasks, not summaries, gives
  the most accurate float.
- ProjectLibre drops links that loop between summary tasks and ignores holidays when it opens MS Project
  XML. Microsoft Project handles both. The XML export is correct either way.
