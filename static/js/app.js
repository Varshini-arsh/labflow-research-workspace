/* LabFlow single-page frontend. Plain JS: hash router + fetch() against the DRF API. */
"use strict";

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const STATUSES = [["todo", "To do"], ["in_progress", "In progress"], ["review", "In review"], ["done", "Done"]];
const PRIORITIES = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["urgent", "Urgent"]];
const PROJECT_STATUSES = [["planning", "Planning"], ["active", "Active"], ["on_hold", "On hold"], ["completed", "Completed"]];
const PUB_STAGES = [["idea", "Idea"], ["drafting", "Drafting"], ["submitted", "Submitted"], ["accepted", "Accepted"], ["published", "Published"]];
const STATUS_DOT = { todo: "var(--muted)", in_progress: "var(--series-1)", review: "var(--series-4)", done: "var(--good)" };
const PROJECT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

const S = { me: null, users: [], projects: [], charts: [] };

function csrf() {
  return $("input[name=csrfmiddlewaretoken]")?.value || "";
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": csrf(), Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && /credentials/i.test(data.detail || "")) location.href = "/login/";
    const msg = data.detail || Object.entries(data).map(([k, v]) => `${k === "non_field_errors" ? "" : k + ": "}${[].concat(v).join(" ")}`).join(" · ");
    const err = new Error(msg || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "error" : ""}`;
  el.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${esc(message)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), type === "error" ? 5000 : 2600);
}

// ---------- formatting ----------
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
const dayDiff = (iso) => Math.round((Date.parse(iso) - Date.parse(todayISO())) / 864e5);
function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function dueLabel(task) {
  if (!task.due_date) return "";
  const d = dayDiff(task.due_date);
  const done = task.status === "done";
  let text = fmtDate(task.due_date);
  if (!done) {
    if (d === 0) text = "Today";
    else if (d === 1) text = "Tomorrow";
    else if (d < 0) text = `${-d}d overdue`;
    else if (d < 7) text = `in ${d}d`;
  }
  return `<span class="due ${!done && d < 0 ? "over" : ""}">${icon("calendar", "sm")}${text}</span>`;
}
function timeAgo(ts) {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(ts.slice(0, 10));
}
const avatar = (u, size = "") =>
  u ? `<span class="avatar ${size}" style="background:${esc(u.color)}" title="${esc(u.name)}">${esc(u.initials)}</span>`
    : `<span class="avatar ${size}" style="background:var(--surface-3);color:var(--muted)" title="Unassigned">?</span>`;
const prio = (p, label) => `<span class="prio ${p}" title="${esc(label)} priority"><span class="bars"><i></i><i></i><i></i></span>${esc(label)}</span>`;
const statusChip = (s, label) => `<span class="chip"><span class="sw" style="background:${STATUS_DOT[s]}"></span>${esc(label)}</span>`;
const projectChip = (code, color) => (code ? `<span class="chip"><span class="sw" style="background:${esc(color)}"></span>${esc(code)}</span>` : "");
const opts = (list, selected) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("");
const userOpts = (selected, blank = "Unassigned") => `<option value="">${blank}</option>` + opts(S.users.map((u) => [u.id, u.name]), selected);
const emptyState = (ico, text) => `<div class="empty">${icon(ico)}<div>${esc(text)}</div></div>`;

// ---------- layers: drawer, modal, palette ----------
const layers = [];
function openLayer(cls, html) {
  const z = 50 + layers.length * 2;
  const overlay = Object.assign(document.createElement("div"), { className: "overlay" });
  const box = Object.assign(document.createElement("div"), { className: cls, innerHTML: html });
  overlay.style.zIndex = z;
  box.style.zIndex = z + 1;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  document.body.append(overlay, box);
  requestAnimationFrame(() => { overlay.classList.add("show"); box.classList.add("show"); });
  const close = () => {
    const i = layers.indexOf(close);
    if (i >= 0) layers.splice(i, 1);
    overlay.classList.remove("show");
    box.classList.remove("show");
    setTimeout(() => { overlay.remove(); box.remove(); }, 250);
  };
  overlay.addEventListener("click", close);
  box.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  layers.push(close);
  return { box, close };
}

const field = (label, control, id) => `<div class="field"><label ${id ? `for="${id}"` : ""}>${label}</label>${control}</div>`;

function openForm({ title, body, submit = "Save", onSubmit, danger }) {
  const { box, close } = openLayer("modal", `
    <form novalidate>
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost icon-only" data-close aria-label="Close">${icon("x")}</button></div>
      <div class="modal-body">${body}<div class="field"><span class="error" data-error></span></div></div>
      <div class="modal-foot">
        ${danger ? `<button type="button" class="btn danger" data-danger style="margin-right:auto">${icon("trash")}${esc(danger.label)}</button>` : ""}
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary" type="submit">${esc(submit)}</button>
      </div>
    </form>`);
  const form = $("form", box);
  setTimeout(() => $("input:not([type=hidden]), textarea, select", form)?.focus(), 60);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      close();
    } catch (err) {
      $("[data-error]", form).textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  if (danger) {
    $("[data-danger]", form).addEventListener("click", async () => {
      if (!confirm(danger.confirm)) return;
      try { await danger.onClick(); close(); } catch (err) { $("[data-error]", form).textContent = err.message; }
    });
  }
  return { box, close };
}

// ---------- data loading ----------
async function loadShared() {
  [S.me, S.users, S.projects] = await Promise.all([api("me/"), api("users/"), api("projects/")]);
  renderSidebar();
}
async function refreshProjects() {
  S.projects = await api("projects/");
  renderSidebar();
}

function renderSidebar() {
  const active = S.projects.filter((p) => p.status !== "completed");
  $("#nav-projects").innerHTML = active
    .map((p) => `<a href="#/project/${p.id}" data-route="project-${p.id}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</a>`)
    .join("");
  const me = S.me;
  $("#me-box").innerHTML = `
    ${avatar(me)}
    <div class="who"><b>${esc(me.name)}</b><span>${esc(me.role_label)}</span></div>
    <form method="post" action="/logout/"><input type="hidden" name="csrfmiddlewaretoken" value="${esc(csrf())}">
      <button class="btn ghost icon-only" title="Sign out" aria-label="Sign out">${icon("logout")}</button></form>`;
  api("tasks/?assignee=me&status=todo,in_progress,review").then((t) => { $("#my-count").textContent = t.length || ""; }).catch(() => {});
}

// ---------- router ----------
const routes = {
  dashboard: viewDashboard,
  projects: viewProjects,
  project: viewBoard,
  tasks: viewTasks,
  publications: viewPublications,
  team: viewTeam,
  activity: viewActivity,
};

async function route() {
  const [, name = "dashboard", param] = (location.hash || "#/dashboard").split("/");
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  const navKey = name === "project" ? `project-${param}` : name === "tasks" ? "my-tasks" : name;
  $$("#sidebar a[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === navKey));
  $("#sidebar").classList.remove("open");
  const view = $("#view");
  view.innerHTML = `<div class="skeleton" style="height:56px;margin-bottom:20px;max-width:420px"></div>
    <div class="grid stats">${'<div class="skeleton" style="height:96px"></div>'.repeat(4)}</div>
    <div class="skeleton" style="height:320px"></div>`;
  try {
    await (routes[name] || viewDashboard)(view, param);
  } catch (err) {
    view.innerHTML = emptyState("alert", `Couldn't load this page: ${err.message}`);
  }
}
const rerender = () => route();

// ---------- Dashboard ----------
async function viewDashboard(view) {
  const d = await api("dashboard/");
  const s = d.stats;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const total = d.status_breakdown.reduce((a, b) => a + b.count, 0);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${greet}, ${esc(S.me.name.split(" ")[0])}</h1>
        <p>${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · here's how the lab is doing.</p></div>
      <div class="actions">
        ${S.me.can.create_project ? `<button class="btn" data-new-project>${icon("folder")}New project</button>` : ""}
      </div>
    </div>
    <div class="grid stats">
      ${stat("folder", "Active projects", s.active_projects, "#/projects")}
      ${stat("check", "Open tasks", s.open_tasks, "#/tasks/all")}
      ${stat("alert", "Overdue", s.overdue_tasks, "#/tasks/overdue", s.overdue_tasks > 0)}
      ${stat("activity", "Done this week", s.done_this_week, "#/activity")}
      ${stat("clock", "Assigned to you", s.my_open_tasks, "#/tasks/mine")}
      ${stat("book", "Papers in pipeline", s.papers_in_pipeline, "#/publications")}
    </div>
    <div class="grid dash-grid">
      <section class="card">
        <div class="card-head"><h3>Tasks completed per week</h3><span class="sub">Last 8 weeks</span></div>
        <div class="card-body"><div class="chart-box"><canvas id="velocity" aria-label="Bar chart of tasks completed per week"></canvas></div></div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Task status</h3><span class="sub">${total} tasks</span></div>
        <div class="card-body" style="display:grid;grid-template-columns:170px 1fr;gap:18px;align-items:center">
          <div class="chart-box" style="height:170px"><canvas id="status-chart" aria-label="Doughnut chart of tasks by status"></canvas></div>
          <ul class="list">${d.status_breakdown.map((b) => `
            <li><span class="chip" style="background:none;padding:0"><span class="sw" style="background:${STATUS_DOT[b.status]};width:10px;height:10px;border-radius:3px"></span></span>
              <span class="grow">${esc(b.label)}</span><b class="tnum">${b.count}</b>
              <span class="muted tnum" style="width:38px;text-align:right">${total ? Math.round((100 * b.count) / total) : 0}%</span></li>`).join("")}
          </ul>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Team workload</h3><span class="sub legend">
          <span><i style="background:var(--critical)"></i>Overdue</span><span><i style="background:var(--series-1)"></i>Open</span><span><i style="background:var(--good)"></i>Done</span></span></div>
        <div class="card-body">${workloadRows(d.workload)}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Upcoming deadlines</h3><span class="sub">Next 10 days</span></div>
        <div class="card-body">
          ${d.upcoming.length ? `<ul class="list">${d.upcoming.map((t) => `
            <li class="clickable" data-task="${t.id}">
              ${avatar(t.assignee, "sm")}
              <div class="grow"><div class="title">${esc(t.title)}</div><div class="muted" style="font-size:12px">${esc(t.project_name)}</div></div>
              ${prio(t.priority, t.priority_label)}${dueLabel(t)}
            </li>`).join("")}</ul>` : emptyState("calendar", "Nothing due in the next 10 days.")}
        </div>
      </section>
      <section class="card span-2">
        <div class="card-head"><h3>Project progress</h3><a class="sub" href="#/projects">All projects →</a></div>
        <div class="card-body"><div class="table-wrap"><table class="table">
          <thead><tr><th>Project</th><th>Lead</th><th style="width:34%">Progress</th><th>Tasks</th><th>Overdue</th><th>Due</th></tr></thead>
          <tbody>${d.projects.map((p) => `
            <tr class="clickable" data-href="#/project/${p.id}">
              <td><div style="display:flex;gap:10px;align-items:center"><span class="dot" style="width:10px;height:10px;border-radius:3px;background:${esc(p.color)}"></span><span class="title">${esc(p.name)}</span></div></td>
              <td>${avatar(p.lead, "sm")} <span class="text-2">${esc(p.lead?.name || "")}</span></td>
              <td><div style="display:flex;align-items:center;gap:10px"><div class="progress" style="flex:1"><span style="width:${p.progress}%;background:${esc(p.color)}"></span></div><span class="tnum" style="width:36px">${p.progress}%</span></div></td>
              <td class="tnum">${p.done_count}/${p.task_count}</td>
              <td class="tnum">${p.overdue_count ? `<span class="chip critical">${icon("alert", "sm")}${p.overdue_count}</span>` : '<span class="muted">—</span>'}</td>
              <td class="text-2">${fmtDate(p.due_date)}</td>
            </tr>`).join("")}</tbody></table></div></div>
      </section>
    </div>`;

  drawVelocity(d.velocity);
  drawStatus(d.status_breakdown);
  view.querySelector("[data-new-project]")?.addEventListener("click", () => projectForm());
}

function stat(ico, label, value, href, alert = false) {
  return `<a class="card stat ${alert ? "alert" : ""}" href="${href}">
    <div class="label">${icon(ico, "sm")}${esc(label)}</div><div class="value tnum">${value}</div></a>`;
}

function workloadRows(rows) {
  const max = Math.max(1, ...rows.map((r) => r.open + r.done));
  return rows.map((r) => {
    const pct = (n) => `${(100 * n) / max}%`;
    const open = r.open - r.overdue;
    return `<div class="workload-row" title="${esc(r.user.name)}: ${r.overdue} overdue, ${open} open, ${r.done} done">
      <div class="who">${avatar(r.user, "sm")}<span>${esc(r.user.name)}</span></div>
      <div class="wbar">
        ${r.overdue ? `<span style="width:${pct(r.overdue)};background:var(--critical)"></span>` : ""}
        ${open ? `<span style="width:${pct(open)};background:var(--series-1)"></span>` : ""}
        ${r.done ? `<span style="width:${pct(r.done)};background:var(--good)"></span>` : ""}
      </div>
      <div class="muted tnum" style="font-size:12px;text-align:right">${r.open} open</div>
    </div>`;
  }).join("");
}

function chartDefaults() {
  Chart.defaults.font.family = cssVar("--font");
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar("--text");
  Chart.defaults.plugins.tooltip.titleColor = cssVar("--bg");
  Chart.defaults.plugins.tooltip.bodyColor = cssVar("--bg");
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.displayColors = false;
}

function drawVelocity(rows) {
  if (!window.Chart) return;
  chartDefaults();
  const ctx = $("#velocity");
  S.charts.push(new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map((r) => fmtDate(r.week)),
      datasets: [{ label: "Tasks completed", data: rows.map((r) => r.count), backgroundColor: cssVar("--series-1"),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 34 }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => `Week of ${i[0].label}`, label: (i) => `${i.raw} tasks completed` } } },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar("--grid") } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: cssVar("--grid") }, border: { display: false } },
      },
    },
  }));
}

function drawStatus(rows) {
  if (!window.Chart) return;
  const colors = { todo: cssVar("--muted"), in_progress: cssVar("--series-1"), review: cssVar("--series-4"), done: cssVar("--good") };
  S.charts.push(new Chart($("#status-chart"), {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{ data: rows.map((r) => r.count), backgroundColor: rows.map((r) => colors[r.status]), borderColor: cssVar("--surface"), borderWidth: 2, hoverOffset: 4 }],
    },
    options: { maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => `${i.label}: ${i.raw}` } } } },
  }));
}

// ---------- Projects ----------
async function viewProjects(view) {
  await refreshProjects();
  let filter = "all";
  const render = () => {
    const list = S.projects.filter((p) => filter === "all" || p.status === filter);
    $("#project-grid").innerHTML = list.length ? list.map(projectCard).join("") : emptyState("folder", "No projects with this status.");
  };
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Projects</h1><p>${S.projects.length} projects across the lab.</p></div>
      <div class="actions">${S.me.can.create_project ? `<button class="btn primary" data-new>${icon("plus")}New project</button>` : ""}</div>
    </div>
    <div class="toolbar"><div class="segmented" id="pfilter">
      ${[["all", "All"], ...PROJECT_STATUSES].map(([v, l]) => `<button data-v="${v}" class="${v === "all" ? "on" : ""}">${l}</button>`).join("")}
    </div></div>
    <div class="grid project-grid" id="project-grid"></div>`;
  render();
  $("#pfilter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    filter = b.dataset.v;
    $$("#pfilter button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  view.querySelector("[data-new]")?.addEventListener("click", () => projectForm());
}

function projectCard(p) {
  const label = PROJECT_STATUSES.find(([v]) => v === p.status)?.[1];
  return `<article class="card project-card" style="--pc:${esc(p.color)}" data-href="#/project/${p.id}" tabindex="0">
    <div style="display:flex;align-items:center;gap:8px"><span class="code">${esc(p.code)}</span><span class="chip" style="margin-left:auto">${esc(label)}</span></div>
    <h3>${esc(p.name)}</h3>
    <p>${esc(p.description)}</p>
    <div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span class="text-2">${p.done_count} of ${p.task_count} tasks done</span><b class="tnum">${p.progress}%</b></div>
      <div class="progress"><span style="width:${p.progress}%;background:${esc(p.color)}"></span></div>
    </div>
    <div class="meta">
      ${p.due_date ? `${icon("calendar", "sm")} ${fmtDate(p.due_date)}` : ""}
      ${p.overdue_count ? `<span class="chip critical">${p.overdue_count} overdue</span>` : ""}
      <span class="avatar-stack">${p.members.slice(0, 5).map((m) => avatar(m, "sm")).join("")}</span>
    </div>
  </article>`;
}

function projectForm(p = null) {
  const color = p?.color || PROJECT_COLORS[S.projects.length % PROJECT_COLORS.length];
  const memberIds = new Set((p?.members || [S.me]).map((m) => m.id));
  openForm({
    title: p ? `Edit ${p.name}` : "New project",
    submit: p ? "Save changes" : "Create project",
    body: `
      ${field("Project name", `<input class="input" id="f-name" name="name" required maxlength="120" value="${esc(p?.name)}" placeholder="e.g. Smart Grid Battery Analytics">`, "f-name")}
      <div class="field-row">
        ${field("Code", `<input class="input" id="f-code" name="code" required maxlength="12" value="${esc(p?.code)}" placeholder="GRID" style="text-transform:uppercase">`, "f-code")}
        ${field("Status", `<select class="select" name="status">${opts(PROJECT_STATUSES, p?.status || "active")}</select>`)}
      </div>
      ${field("Description", `<textarea class="input" name="description" rows="3">${esc(p?.description)}</textarea>`)}
      <div class="field-row">
        ${field("Start date", `<input class="input" type="date" name="start_date" value="${esc(p?.start_date || todayISO())}">`)}
        ${field("Due date", `<input class="input" type="date" name="due_date" value="${esc(p?.due_date)}">`)}
      </div>
      ${field("Lead", `<select class="select" name="lead_id">${opts(S.users.filter((u) => u.role !== "intern").map((u) => [u.id, u.name]), p?.lead?.id || S.me.id)}</select>`)}
      ${field("Colour", `<div class="swatches">${PROJECT_COLORS.map((c) => `<label style="background:${c}"><input type="radio" name="color" value="${c}" ${c === color ? "checked" : ""}><span></span></label>`).join("")}</div>`)}
      ${field("Members", `<div class="checks">${S.users.map((u) => `<label><input type="checkbox" name="member_ids" value="${u.id}" ${memberIds.has(u.id) ? "checked" : ""}>${avatar(u, "sm")}${esc(u.name)}</label>`).join("")}</div>`)}
    `,
    danger: p && S.me.can.admin ? {
      label: "Delete", confirm: `Delete "${p.name}" and all of its tasks? This cannot be undone.`,
      onClick: async () => { await api(`projects/${p.id}/`, { method: "DELETE" }); toast("Project deleted"); await refreshProjects(); location.hash = "#/projects"; },
    } : null,
    onSubmit: async (fd) => {
      const body = {
        name: fd.get("name"), code: fd.get("code"), status: fd.get("status"), description: fd.get("description"),
        start_date: fd.get("start_date") || null, due_date: fd.get("due_date") || null,
        lead_id: Number(fd.get("lead_id")) || null, color: fd.get("color"), member_ids: fd.getAll("member_ids").map(Number),
      };
      const saved = await api(p ? `projects/${p.id}/` : "projects/", { method: p ? "PATCH" : "POST", body });
      toast(p ? "Project updated" : "Project created");
      await refreshProjects();
      if (p) rerender(); else location.hash = `#/project/${saved.id}`;
    },
  });
}

// ---------- Kanban board ----------
async function viewBoard(view, id) {
  const [project, tasks] = await Promise.all([api(`projects/${id}/`), api(`tasks/?project=${id}`)]);
  const canEditProject = S.me.can.admin || project.lead?.id === S.me.id;
  const filters = { search: "", assignee: "", priority: "" };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/projects" class="muted" style="display:inline-flex;align-items:center;gap:4px;font-size:13px;margin-bottom:6px">${icon("back", "sm")}Projects</a>
        <h1 style="display:flex;align-items:center;gap:10px"><span style="width:14px;height:14px;border-radius:4px;background:${esc(project.color)}"></span>${esc(project.name)}</h1>
        <p>${esc(project.description)}</p>
      </div>
      <div class="actions">
        <span class="avatar-stack" style="align-self:center;margin-right:6px">${project.members.map((m) => avatar(m)).join("")}</span>
        ${canEditProject ? `<button class="btn" data-edit>${icon("edit")}Edit</button>` : ""}
        <button class="btn primary" data-add>${icon("plus")}Add task</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="input-icon">${icon("search")}<input class="input" id="b-search" placeholder="Filter tasks…" aria-label="Filter tasks"></div>
      <select class="select" id="b-assignee" aria-label="Filter by assignee"><option value="">Everyone</option><option value="me">Only mine</option>${opts(project.members.map((m) => [m.id, m.name]))}</select>
      <select class="select" id="b-priority" aria-label="Filter by priority"><option value="">Any priority</option>${opts(PRIORITIES)}</select>
      <span class="muted" style="margin-left:auto;font-size:13px">${project.progress}% complete · drag cards between columns</span>
    </div>
    <div class="board" id="board"></div>`;

  const board = $("#board");
  const visible = (t) =>
    (!filters.search || `${t.title} ${t.tags}`.toLowerCase().includes(filters.search)) &&
    (!filters.priority || t.priority === filters.priority) &&
    (!filters.assignee || String(t.assignee?.id) === (filters.assignee === "me" ? String(S.me.id) : filters.assignee));

  const render = () => {
    board.innerHTML = STATUSES.map(([s, label]) => {
      const col = tasks.filter((t) => t.status === s).sort((a, b) => a.position - b.position);
      const shown = col.filter(visible);
      return `<section class="column" data-status="${s}" aria-label="${label}">
        <div class="column-head"><span class="chip" style="background:none;padding:0"><span class="sw" style="background:${STATUS_DOT[s]}"></span></span>${label}<span class="n">${col.length}</span>
          <button class="btn ghost" data-add-in="${s}" aria-label="Add task to ${label}">${icon("plus", "sm")}</button></div>
        <div class="cards">${shown.map(taskCard).join("") || `<div class="muted" style="font-size:12px;text-align:center;padding:14px 0">Drop tasks here</div>`}</div>
      </section>`;
    }).join("");
  };
  render();

  // Filters
  $("#b-search").addEventListener("input", (e) => { filters.search = e.target.value.toLowerCase(); render(); });
  $("#b-assignee").addEventListener("change", (e) => { filters.assignee = e.target.value; render(); });
  $("#b-priority").addEventListener("change", (e) => { filters.priority = e.target.value; render(); });
  view.querySelector("[data-edit]")?.addEventListener("click", () => projectForm(project));
  view.querySelector("[data-add]").addEventListener("click", () => taskForm({ project_id: project.id }));
  board.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add-in]");
    if (add) taskForm({ project_id: project.id, status: add.dataset.addIn });
  });

  // Drag and drop (HTML5). The drawer's status dropdown is the touch-friendly fallback.
  let dragId = null;
  const marker = Object.assign(document.createElement("div"), { className: "drop-marker" });
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".task-card");
    if (!card) return;
    dragId = Number(card.dataset.task);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragId));
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  board.addEventListener("dragend", () => {
    $$(".dragging", board).forEach((c) => c.classList.remove("dragging"));
    $$(".column", board).forEach((c) => c.classList.remove("drag-over"));
    marker.remove();
  });
  const dropIndex = (cards, y) => {
    const others = $$(".task-card:not(.dragging)", cards);
    const i = others.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
    return { index: i < 0 ? others.length : i, before: others[i] };
  };
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".column");
    if (!col || dragId === null) return;
    e.preventDefault();
    $$(".column", board).forEach((c) => c.classList.toggle("drag-over", c === col));
    const cards = $(".cards", col);
    const { before } = dropIndex(cards, e.clientY);
    if (before) cards.insertBefore(marker, before); else cards.append(marker);
  });
  board.addEventListener("drop", async (e) => {
    const col = e.target.closest(".column");
    if (!col || dragId === null) return;
    e.preventDefault();
    const task = tasks.find((t) => t.id === dragId);
    const status = col.dataset.status;
    // Index among the *visible* cards; convert to an index in the full column.
    const { before } = dropIndex($(".cards", col), e.clientY);
    const full = tasks.filter((t) => t.status === status && t.id !== dragId).sort((a, b) => a.position - b.position);
    const index = before ? full.findIndex((t) => t.id === Number(before.dataset.task)) : full.length;
    marker.remove();
    dragId = null;
    if (!task.can_edit) { toast("You can only move tasks assigned to you.", "error"); render(); return; }
    // Optimistic update, then confirm with the server.
    const prev = { status: task.status, position: task.position };
    full.splice(index, 0, task);
    full.forEach((t, i) => { t.position = i; });
    task.status = status;
    render();
    try {
      const saved = await api(`tasks/${task.id}/move/`, { method: "POST", body: { status, position: index } });
      Object.assign(task, saved);
      if (prev.status !== status) toast(`Moved to ${saved.status_label}`);
    } catch (err) {
      Object.assign(task, prev);
      render();
      toast(err.message, "error");
    }
  });
}

function taskCard(t) {
  return `<article class="task-card" draggable="${t.can_edit}" data-task="${t.id}" tabindex="0" aria-label="${esc(t.title)}">
    ${t.tag_list.length ? `<div class="tags">${t.tag_list.slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : ""}
    <div class="t">${esc(t.title)}</div>
    <div class="row">${prio(t.priority, t.priority_label)}${dueLabel(t)}
      ${t.comment_count ? `<span class="due">${icon("message", "sm")}${t.comment_count}</span>` : ""}
      ${avatar(t.assignee, "sm")}</div>
  </article>`;
}

function taskForm(defaults = {}) {
  const projects = S.projects.filter((p) => p.status !== "completed");
  openForm({
    title: "New task",
    submit: "Create task",
    body: `
      ${field("Title", `<input class="input" id="f-title" name="title" required maxlength="200" placeholder="What needs to be done?">`, "f-title")}
      ${field("Project", `<select class="select" name="project_id">${opts(projects.map((p) => [p.id, p.name]), defaults.project_id)}</select>`)}
      ${field("Description", `<textarea class="input" name="description" rows="3" placeholder="Optional details"></textarea>`)}
      <div class="field-row">
        ${field("Status", `<select class="select" name="status">${opts(STATUSES, defaults.status || "todo")}</select>`)}
        ${field("Priority", `<select class="select" name="priority">${opts(PRIORITIES, "medium")}</select>`)}
      </div>
      <div class="field-row">
        ${field("Assignee", `<select class="select" name="assignee_id">${userOpts(S.me.id)}</select>`)}
        ${field("Due date", `<input class="input" type="date" name="due_date">`)}
      </div>
      ${field("Tags", `<input class="input" name="tags" placeholder="api, frontend, bug">`)}`,
    onSubmit: async (fd) => {
      if (!fd.get("title").trim()) throw new Error("Give the task a title.");
      await api("tasks/", {
        method: "POST",
        body: {
          title: fd.get("title").trim(), project_id: Number(fd.get("project_id")), description: fd.get("description"),
          status: fd.get("status"), priority: fd.get("priority"), assignee_id: Number(fd.get("assignee_id")) || null,
          due_date: fd.get("due_date") || null, tags: fd.get("tags"),
        },
      });
      toast("Task created");
      rerender();
      renderSidebar();
    },
  });
}

// ---------- Task drawer ----------
async function openTask(id) {
  const { box, close } = openLayer("drawer", `<div class="drawer-body"><div class="skeleton" style="height:300px"></div></div>`);
  let task;
  let dirty = false;
  try {
    task = await api(`tasks/${id}/`);
  } catch (err) {
    close();
    toast(err.message, "error");
    return;
  }
  const comments = await api(`tasks/${id}/comments/`);
  const dis = task.can_edit ? "" : "disabled";
  box.innerHTML = `
    <div class="drawer-head">
      ${projectChip(task.project_code, task.project_color)}
      ${task.is_overdue ? `<span class="chip critical">${icon("alert", "sm")}Overdue</span>` : ""}
      ${!task.can_edit ? `<span class="chip">${icon("shield", "sm")}Read-only for you</span>` : ""}
      <span style="margin-left:auto"></span>
      ${task.can_edit ? `<button class="btn ghost icon-only" data-delete title="Delete task" aria-label="Delete task">${icon("trash")}</button>` : ""}
      <button class="btn ghost icon-only" data-close aria-label="Close">${icon("x")}</button>
    </div>
    <div class="drawer-body">
      <input class="title-input" name="title" value="${esc(task.title)}" ${dis} aria-label="Task title">
      <div class="props">
        <label>Status</label><select class="select" name="status" ${dis}>${opts(STATUSES, task.status)}</select>
        <label>Priority</label><select class="select" name="priority" ${dis}>${opts(PRIORITIES, task.priority)}</select>
        <label>Assignee</label><select class="select" name="assignee_id" ${dis}>${userOpts(task.assignee?.id)}</select>
        <label>Due date</label><input class="input" type="date" name="due_date" value="${esc(task.due_date)}" ${dis}>
        <label>Tags</label><input class="input" name="tags" value="${esc(task.tags)}" ${dis} placeholder="comma, separated">
      </div>
      <div class="section-title">Description</div>
      <textarea class="input" name="description" rows="4" style="width:100%" ${dis} placeholder="Add more detail…">${esc(task.description)}</textarea>
      <div class="section-title">Comments · ${comments.length}</div>
      <div id="comments">${comments.map(commentHtml).join("") || '<p class="muted" style="margin:0 0 14px">No comments yet. Start the discussion.</p>'}</div>
      <form class="comment-form" id="comment-form">
        ${avatar(S.me)}
        <textarea class="input" name="body" rows="2" placeholder="Write a comment… (Ctrl+Enter to send)" aria-label="Comment"></textarea>
        <button class="btn primary">Send</button>
      </form>
      <p class="muted" style="font-size:12px;margin-top:22px">Created ${timeAgo(task.created_at)} · updated ${timeAgo(task.updated_at)}</p>
    </div>`;

  const save = async (patch) => {
    try {
      task = await api(`tasks/${id}/`, { method: "PATCH", body: patch });
      dirty = true;
      toast("Saved");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  $$("select, input[type=date]", box).forEach((el) => el.addEventListener("change", () => {
    const v = el.value;
    save({ [el.name]: el.name === "assignee_id" ? Number(v) || null : v || null });
  }));
  $$(".title-input, input[name=tags], textarea[name=description]", box).forEach((el) =>
    el.addEventListener("change", () => {
      if (el.name === "title" && !el.value.trim()) { el.value = task.title; return; }
      save({ [el.name]: el.value });
    }));

  const form = $("#comment-form", box);
  const sendComment = async () => {
    const body = form.body.value.trim();
    if (!body) return;
    try {
      const c = await api(`tasks/${id}/comments/`, { method: "POST", body: { body } });
      const list = $("#comments", box);
      if (!list.querySelector(".comment")) list.innerHTML = "";
      list.insertAdjacentHTML("beforeend", commentHtml(c));
      form.body.value = "";
      dirty = true;
    } catch (err) {
      toast(err.message, "error");
    }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); sendComment(); });
  form.body.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendComment(); });

  $("[data-delete]", box)?.addEventListener("click", async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try {
      await api(`tasks/${id}/`, { method: "DELETE" });
      toast("Task deleted");
      dirty = true;
      close();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Re-render the page behind the drawer once it closes, if anything changed.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(box)) {
      observer.disconnect();
      if (dirty) { rerender(); renderSidebar(); }
    }
  });
  observer.observe(document.body, { childList: true });
}

const commentHtml = (c) => `<div class="comment">${avatar(c.author, "sm")}<div class="bubble"><b>${esc(c.author?.name)}</b><time>${timeAgo(c.created_at)}</time><p>${esc(c.body)}</p></div></div>`;

// ---------- Task list ----------
async function viewTasks(view, scope = "mine") {
  const state = { scope: scope === "overdue" ? "all" : scope, overdue: scope === "overdue", status: new Set(["todo", "in_progress", "review"]), search: "" };
  if (scope.startsWith("u-")) state.scope = "all";
  const userId = scope.startsWith("u-") ? scope.slice(2) : "";
  const person = S.users.find((u) => String(u.id) === userId);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${person ? `${esc(person.name)}'s tasks` : state.overdue ? "Overdue tasks" : "Tasks"}</h1><p>Click any row to open, edit and comment.</p></div>
      <div class="actions"><button class="btn primary" data-add>${icon("plus")}New task</button></div>
    </div>
    <div class="toolbar">
      ${person ? "" : `<div class="segmented" id="t-scope"><button data-v="mine">Assigned to me</button><button data-v="all">Everyone</button></div>`}
      <div class="segmented" id="t-status">${STATUSES.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join("")}</div>
      <label class="chip" style="cursor:pointer;padding:6px 10px"><input type="checkbox" id="t-overdue" ${state.overdue ? "checked" : ""}> Overdue only</label>
      <div class="input-icon" style="margin-left:auto">${icon("search")}<input class="input" id="t-search" placeholder="Search tasks…" aria-label="Search tasks"></div>
    </div>
    <section class="card"><div class="table-wrap" id="t-table"></div></section>`;

  const sync = () => {
    $$("#t-scope button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.scope));
    $$("#t-status button").forEach((b) => b.classList.toggle("on", state.status.has(b.dataset.v)));
  };
  const load = async () => {
    const q = new URLSearchParams();
    if (userId) q.set("assignee", userId); else if (state.scope === "mine") q.set("assignee", "me");
    if (state.status.size) q.set("status", [...state.status].join(","));
    if (state.overdue) q.set("overdue", "1");
    if (state.search) q.set("search", state.search);
    const tasks = await api(`tasks/?${q}`);
    $("#t-table").innerHTML = tasks.length ? `<table class="table">
      <thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Priority</th><th>Due</th><th>Assignee</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr class="clickable" data-task="${t.id}">
        <td><span class="title">${esc(t.title)}</span>${t.comment_count ? ` <span class="muted" style="font-size:12px">${icon("message", "sm")} ${t.comment_count}</span>` : ""}</td>
        <td>${projectChip(t.project_code, t.project_color)}</td>
        <td>${statusChip(t.status, t.status_label)}</td>
        <td>${prio(t.priority, t.priority_label)}</td>
        <td>${dueLabel(t) || '<span class="muted">—</span>'}</td>
        <td>${avatar(t.assignee, "sm")} <span class="text-2">${esc(t.assignee?.name || "Unassigned")}</span></td>
      </tr>`).join("")}</tbody></table>` : emptyState("check", "No tasks match these filters. Nice work.");
  };
  sync();
  await load();

  $("#t-scope")?.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.scope = b.dataset.v; sync(); load(); });
  $("#t-status").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.status.has(b.dataset.v) ? state.status.delete(b.dataset.v) : state.status.add(b.dataset.v);
    sync();
    load();
  });
  $("#t-overdue").addEventListener("change", (e) => { state.overdue = e.target.checked; load(); });
  let timer;
  $("#t-search").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { state.search = e.target.value.trim(); load(); }, 250); });
  view.querySelector("[data-add]").addEventListener("click", () => taskForm({ project_id: S.projects[0]?.id }));
}

// ---------- Publications ----------
async function viewPublications(view) {
  const pubs = await api("publications/");
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Publications</h1><p>${pubs.length} papers · from first idea to DOI. Use the arrow on a card to advance its stage.</p></div>
      <div class="actions"><button class="btn primary" data-new>${icon("plus")}Add paper</button></div>
    </div>
    <div class="pipeline">${PUB_STAGES.map(([s, label], i) => {
      const items = pubs.filter((p) => p.status === s);
      return `<section class="stage"><h4>${label}<span class="muted">${items.length}</span></h4>
        ${items.map((p) => `<article class="paper" data-pub="${p.id}" tabindex="0">
          <div class="t">${esc(p.title)}</div>
          <div class="a">${esc(p.authors)}</div>
          <div class="v">${projectChip(p.project_code, p.project_color)}<span>${esc(p.venue || "Venue TBD")}${p.year ? ` · ${p.year}` : ""}</span>
            ${i < PUB_STAGES.length - 1 ? `<button class="btn ghost icon-only" style="margin-left:auto;padding:4px" data-advance="${p.id}" title="Move to ${PUB_STAGES[i + 1][1]}" aria-label="Move to ${PUB_STAGES[i + 1][1]}">${icon("arrow", "sm")}</button>` : ""}
          </div>
          ${p.doi ? `<div class="v">DOI ${esc(p.doi)}</div>` : ""}
        </article>`).join("") || '<div class="muted" style="font-size:12px;padding:8px 6px">Nothing here yet</div>'}
      </section>`;
    }).join("")}</div>`;

  view.querySelector("[data-new]").addEventListener("click", () => pubForm());
  view.querySelector(".pipeline").addEventListener("click", async (e) => {
    const adv = e.target.closest("[data-advance]");
    if (adv) {
      e.stopPropagation();
      const p = pubs.find((x) => x.id === Number(adv.dataset.advance));
      const next = PUB_STAGES[PUB_STAGES.findIndex(([s]) => s === p.status) + 1];
      try {
        await api(`publications/${p.id}/`, { method: "PATCH", body: { status: next[0] } });
        toast(`Moved to ${next[1]}`);
        rerender();
      } catch (err) { toast(err.message, "error"); }
      return;
    }
    const card = e.target.closest("[data-pub]");
    if (card) pubForm(pubs.find((x) => x.id === Number(card.dataset.pub)));
  });
}

function pubForm(p = null) {
  openForm({
    title: p ? "Edit paper" : "Add paper",
    submit: p ? "Save" : "Add paper",
    body: `
      ${field("Title", `<input class="input" name="title" required maxlength="250" value="${esc(p?.title)}">`)}
      ${field("Authors", `<input class="input" name="authors" required value="${esc(p?.authors)}" placeholder="A. Rao, P. Sharma">`)}
      <div class="field-row">
        ${field("Venue", `<input class="input" name="venue" value="${esc(p?.venue)}" placeholder="Journal or conference">`)}
        ${field("Year", `<input class="input" name="year" type="number" min="1990" max="2100" value="${esc(p?.year)}">`)}
      </div>
      <div class="field-row">
        ${field("Stage", `<select class="select" name="status">${opts(PUB_STAGES, p?.status || "idea")}</select>`)}
        ${field("Project", `<select class="select" name="project_id"><option value="">None</option>${opts(S.projects.map((x) => [x.id, x.name]), p?.project_id)}</select>`)}
      </div>
      ${field("DOI", `<input class="input" name="doi" value="${esc(p?.doi)}" placeholder="10.xxxx/xxxxx">`)}`,
    danger: p && S.me.role !== "intern" ? {
      label: "Delete", confirm: "Delete this paper?",
      onClick: async () => { await api(`publications/${p.id}/`, { method: "DELETE" }); toast("Paper deleted"); rerender(); },
    } : null,
    onSubmit: async (fd) => {
      if (!fd.get("title").trim() || !fd.get("authors").trim()) throw new Error("Title and authors are required.");
      const body = Object.fromEntries(fd);
      body.year = Number(body.year) || null;
      body.project_id = Number(body.project_id) || null;
      await api(p ? `publications/${p.id}/` : "publications/", { method: p ? "PATCH" : "POST", body });
      toast(p ? "Paper updated" : "Paper added");
      rerender();
    },
  });
}

// ---------- Team ----------
async function viewTeam(view) {
  const d = await api("dashboard/");
  const byUser = Object.fromEntries(d.workload.map((w) => [w.user.id, w]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Team</h1><p>${S.users.length} people · click a person to see their tasks.</p></div></div>
    <div class="grid team-grid">${S.users.map((u) => {
      const w = byUser[u.id] || { open: 0, done: 0, overdue: 0 };
      const projects = S.projects.filter((p) => p.members.some((m) => m.id === u.id));
      return `<article class="card person clickable" data-href="#/tasks/u-${u.id}" tabindex="0">
        <div class="top">${avatar(u, "lg")}<div><div class="title" style="font-weight:600">${esc(u.name)}</div><div class="muted" style="font-size:13px">${esc(u.title)}</div></div>
          <span class="chip" style="margin-left:auto">${esc(u.role_label)}</span></div>
        <div class="nums"><div><b class="tnum">${w.open}</b><span>Open</span></div><div><b class="tnum">${w.done}</b><span>Done</span></div>
          <div><b class="tnum" style="${w.overdue ? "color:var(--critical)" : ""}">${w.overdue}</b><span>Overdue</span></div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${projects.map((p) => projectChip(p.code, p.color)).join("") || '<span class="muted" style="font-size:12px">No projects</span>'}</div>
      </article>`;
    }).join("")}</div>`;
}

// ---------- Activity ----------
async function viewActivity(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Everything that changed across the lab, newest first.</p></div>
      <div class="actions"><select class="select" id="a-project" aria-label="Filter by project"><option value="">All projects</option>${opts(S.projects.map((p) => [p.id, p.name]))}</select></div></div>
    <section class="card"><div class="card-body" id="feed"></div></section>`;
  const load = async () => {
    const pid = $("#a-project").value;
    const items = await api(`activity/${pid ? `?project=${pid}` : ""}`);
    $("#feed").innerHTML = items.length ? `<ul class="feed">${items.map((a) => `<li>${avatar(a.actor)}
      <div class="what"><b>${esc(a.actor?.name || "Someone")}</b> ${esc(a.verb)} <span class="text-2">“${esc(a.target)}”</span>
        <div style="margin-top:4px">${projectChip(a.project_code, a.project_color)}</div></div>
      <time datetime="${esc(a.created_at)}">${timeAgo(a.created_at)}</time></li>`).join("")}</ul>` : emptyState("activity", "No activity yet.");
  };
  $("#a-project").addEventListener("change", load);
  await load();
}

// ---------- Command palette (Ctrl+K) ----------
async function openPalette() {
  if ($(".palette")) return;
  const { box, close } = openLayer("modal palette", `<input placeholder="Search tasks, projects, people, pages…" aria-label="Search"><ul role="listbox"></ul>`);
  const input = $("input", box);
  const list = $("ul", box);
  input.focus();
  const pages = [["Dashboard", "#/dashboard", "dashboard"], ["Projects", "#/projects", "folder"], ["My tasks", "#/tasks/mine", "check"], ["Overdue tasks", "#/tasks/overdue", "alert"],
    ["Publications", "#/publications", "book"], ["Team", "#/team", "users"], ["Activity", "#/activity", "activity"]];
  let tasks = [];
  let items = [];
  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    items = [
      ...pages.filter(([n]) => match(n)).map(([n, href, ico]) => ({ group: "Pages", label: n, ico, go: () => (location.hash = href) })),
      ...S.projects.filter((p) => match(`${p.name} ${p.code}`)).map((p) => ({ group: "Projects", label: p.name, kind: p.code, ico: "folder", go: () => (location.hash = `#/project/${p.id}`) })),
      ...tasks.filter((t) => q && match(`${t.title} ${t.tags}`)).slice(0, 8).map((t) => ({ group: "Tasks", label: t.title, kind: t.project_code, ico: "check", go: () => openTask(t.id) })),
      ...S.users.filter((u) => q && match(u.name)).map((u) => ({ group: "People", label: u.name, kind: u.role_label, ico: "users", go: () => (location.hash = `#/tasks/u-${u.id}`) })),
    ];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let last = "";
    list.innerHTML = items.map((it, i) => {
      const head = it.group !== last ? `<div class="group">${it.group}</div>` : "";
      last = it.group;
      return `${head}<li role="option" data-i="${i}" class="${i === sel ? "sel" : ""}" aria-selected="${i === sel}">${icon(it.ico)}<span>${esc(it.label)}</span>${it.kind ? `<span class="kind">${esc(it.kind)}</span>` : ""}</li>`;
    }).join("") || `<div class="empty">No results for “${esc(input.value)}”</div>`;
  };
  const choose = (i) => { const it = items[i]; if (!it) return; close(); it.go(); };
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    if (e.key === "Enter") choose(sel);
  });
  list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(Number(li.dataset.i)); });
  render();
  tasks = await api("tasks/").catch(() => []);
  render();
}

// ---------- global wiring ----------
function setThemeIcon() {
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#theme-btn use").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  return dark;
}

document.addEventListener("click", (e) => {
  const taskEl = e.target.closest("[data-task]");
  if (taskEl && !e.target.closest("button, a, select, input")) { openTask(Number(taskEl.dataset.task)); return; }
  const hrefEl = e.target.closest("[data-href]");
  if (hrefEl && !e.target.closest("button, a")) location.hash = hrefEl.dataset.href;
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape" && layers.length) { layers[layers.length - 1](); return; }
  if (e.key === "Enter" && document.activeElement?.matches("[data-task], [data-href], [data-pub]")) document.activeElement.click();
});

$("#search-btn").addEventListener("click", openPalette);
$("#quick-add").addEventListener("click", () => {
  const m = location.hash.match(/#\/project\/(\d+)/);
  taskForm({ project_id: m ? Number(m[1]) : S.projects.find((p) => p.status === "active")?.id });
});
$("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#theme-btn").addEventListener("click", () => {
  const next = setThemeIcon() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("labflow-theme", next); } catch (err) { /* storage unavailable */ }
  setThemeIcon();
  rerender(); // charts read colours from CSS variables
});
window.addEventListener("hashchange", route);

(async function init() {
  setThemeIcon();
  try {
    await loadShared();
  } catch (err) {
    $("#view").innerHTML = emptyState("alert", `Couldn't reach the API: ${err.message}`);
    return;
  }
  route();
})();
