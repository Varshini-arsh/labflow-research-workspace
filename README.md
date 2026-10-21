# LabFlow: research lab workspace

LabFlow is a project and task manager for small research teams. It covers lab projects, a drag-and-drop Kanban board, a publication pipeline from first idea to DOI, and a live dashboard that shows who is overloaded before deadlines slip.

**Stack:** Python · Django 5 · Django REST Framework · MySQL (SQLite fallback) · HTML/CSS/vanilla JavaScript · Chart.js

---

## Case study

The demo data models a university research lab with 7 people (a Lab Admin, 3 Researchers and 3 Interns) running five projects:

| Code | Project | Status |
|---|---|---|
| GRID | Smart Grid Battery Analytics | Active |
| ZKRWA | ZKP Compliance for Tokenized Assets | Active |
| CAMPUS | Campus Energy Dashboard | Active |
| AGRI | Crop Yield Forecasting | Planning |
| WEB | Lab Website Revamp | Completed |

**The problem:** the lab tracked work in spreadsheets and chat threads. Nobody could answer "what's overdue?", "who has too much on their plate?" or "where is that paper?" without asking around.

**What LabFlow gives them:**
- **One Kanban board per project.** Drag a card to change its status, and the order is saved on the server.
- **A dashboard** with tasks completed per week, a status breakdown, team workload (overdue, open and done) and the deadlines for the next 10 days.
- **Role-based access.** Interns can only edit tasks assigned to them, only researchers can create projects, and only admins can delete projects. The backend enforces these rules, and the UI hides what you can't do.
- **A publication pipeline:** Idea → Drafting → Submitted → Accepted → Published.
- **An activity feed** that records every change, by whom and when.

## Features

| Area | What you can do |
|---|---|
| Dashboard | 6 stat tiles that click through to filtered views, a weekly velocity bar chart, a status doughnut, a workload bar per person, upcoming deadlines and a project progress table |
| Projects | Filter by status. Create or edit with a colour, lead, members and dates. Admins can delete |
| Kanban board | Drag and drop between and within columns (pointer events with a floating card preview, auto-scroll at the board edges, optimistic UI that rolls back on error), filter by text, assignee and priority, add a task straight into a column. On touch screens, move a task from the task drawer |
| Task drawer | Inline editing that saves on change, comments (Ctrl+Enter to send), overdue badge, read-only mode when you lack permission |
| Tasks list | "Assigned to me" or "Everyone", status toggles, overdue-only, debounced search |
| Publications | A 5-stage pipeline where one click advances a paper, plus an edit modal |
| Team | Workload per person. Click a person to see their tasks |
| Global | Ctrl+K command palette (pages, projects, tasks, people), dark mode, toasts, loading skeletons, responsive layout with a mobile sidebar, keyboard access |

## Architecture

```
Browser (vanilla JS SPA, hash router)
   │  fetch() + session cookie + CSRF token
   ▼
Django REST Framework  ── core/views.py        ViewSets, custom actions (move, comments), dashboard
   │                     core/permissions.py  role rules shared by views and tests
   │                     core/serializers.py  nested read / id write, validation
   ▼
Django ORM + hand-written SQL  ──►  MySQL 8 (or SQLite for zero setup)
```

### Data model

```
User 1─1 Profile(role, title, color)
User 1─* Project(lead)      Project *─* User(members)
Project 1─* Task(status, priority, position, due_date, assignee, completed_at)
Task 1─* Comment(author, body)
Project 1─* Publication(status, venue, doi)
Activity(actor, verb, target, project)    ← audit trail
```

Indexes on `(project, status)`, `(assignee, status)` and `due_date` match the board, "my tasks" and overdue queries.

### A hand-written SQL example

The team workload panel uses one `LEFT JOIN … GROUP BY` with conditional sums. It runs the same way on SQLite and MySQL:

```sql
SELECT u.id,
       SUM(CASE WHEN t.id IS NOT NULL AND t.status <> 'done' THEN 1 ELSE 0 END) AS open_tasks,
       SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)                        AS done_tasks,
       SUM(CASE WHEN t.status <> 'done' AND t.due_date < %s THEN 1 ELSE 0 END)   AS overdue_tasks
FROM auth_user u
LEFT JOIN core_task t ON t.assignee_id = u.id
WHERE u.is_active = %s
GROUP BY u.id
ORDER BY open_tasks DESC;
```

## REST API

Every endpoint requires a session login. You can browse them at `/api/`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/me/` | Current user and what they're allowed to do |
| GET | `/api/dashboard/` | Stats, velocity, workload, upcoming deadlines, project progress |
| GET/POST | `/api/projects/` | List (with task, done and overdue counts) or create. `?status=active` |
| GET/PATCH/DELETE | `/api/projects/{id}/` | Read, update (lead or admin), delete (admin) |
| GET/POST | `/api/tasks/` | Filters: `project`, `status=todo,review`, `priority`, `assignee=me\|{id}`, `overdue=1`, `search` |
| GET/PATCH/DELETE | `/api/tasks/{id}/` | Role-checked edit and delete |
| POST | `/api/tasks/{id}/move/` | `{status, position}`. Drag and drop: inserts and renumbers the column in one transaction |
| GET/POST | `/api/tasks/{id}/comments/` | Comment thread |
| CRUD | `/api/publications/` | Paper pipeline |
| GET | `/api/activity/` | Latest 60 events. `?project={id}` |
| GET | `/api/users/` | Team members |

## Run it locally

```bash
git clone https://github.com/Varshini-arsh/labflow-research-workspace.git
cd labflow-research-workspace
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo       # loads the case-study lab
python manage.py runserver
```

Open http://127.0.0.1:8000 and click one of the **demo account** buttons, or sign in as `ananya`, `rahul` or `meera` with the password `demo12345`.

### Use MySQL instead of SQLite

```bash
docker compose up -d                       # MySQL 8.4 on localhost:3306
# PowerShell
$env:DB_ENGINE="mysql"; python manage.py migrate; python manage.py seed_demo; python manage.py runserver
# bash
DB_ENGINE=mysql python manage.py migrate && DB_ENGINE=mysql python manage.py seed_demo
```

The connection settings are `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST` and `DB_PORT` (see `.env.example`). The driver is PyMySQL, which is pure Python, so it needs no compiler on Windows.

## Tests

```bash
python manage.py test core.tests
```

There are 12 API tests. They cover the role rules (intern, researcher, admin), validation, drag-and-drop reordering, filters, comments and the SQL workload numbers on the dashboard.

## Project structure

```
labflow/            settings (env-driven), urls
core/
  models.py         Profile, Project, Task, Comment, Publication, Activity
  permissions.py    role rules
  serializers.py    DRF serializers
  views.py          ViewSets, move/comments actions, dashboard, raw-SQL workload
  pages.py          login, demo login, app shell
  tests.py          API tests
  management/commands/seed_demo.py
templates/          login.html, app.html (shell), icons.html (SVG sprite)
static/css/app.css  design tokens, light and dark themes, components
static/js/app.js    SPA: router, views, Kanban drag and drop, drawer, command palette
```
