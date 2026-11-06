/**
 * Group builder: name a group and tick its members by hand.
 * Every group name starts with @ and has _ instead of spaces (see groupName).
 * A group that already exists gets the missing members added. Nobody is
 * removed from any group.
 */

import { addToGroupOp, createGroupOp, levelName, loadProject } from "./data.js";
import { esc, option } from "./ui.js";
import "./groupbuilder.css";

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
/** House rule for group names: always a leading @, never spaces. "Projektering VVS" → "@Projektering_VVS". */
export const groupName = (value) => {
  const bare = clean(value).replace(/^@+/, "").replace(/ /g, "_");
  return bare ? `@${bare}` : "";
};
const byRank = (a, b) => b.level - a.level || (a.name || a.email).localeCompare(b.name || b.email, "sv");

export function createGroupBuilder({ root, rest, projects, currentProjectId, showPreview }) {
  const state = {
    projectId: currentProjectId,
    data: null,
    manual: { selected: new Set(), admin: "" },
  };

  root.innerHTML = `
    <div class="mx-controls">
      <div class="mx-field">
        <label for="gb-project">Projekt</label>
        <select id="gb-project">${projects
          .filter((p) => !p.inactive || p.id === currentProjectId)
          .map((p) => option(p.id, `${p.name}${p.id === currentProjectId ? " (öppet)" : ""}`, p.id === currentProjectId))
          .join("")}</select>
      </div>
    </div>

    <div id="gb-manual" class="view">
      <div class="mx-controls">
        <div class="mx-field">
          <label for="gb-name">Gruppnamn</label>
          <input id="gb-name" list="gb-groups" placeholder="Ny grupp, t.ex. Projektering VVS, eller välj en befintlig" autocomplete="off" />
          <datalist id="gb-groups"></datalist>
        </div>
        <div class="mx-field gb-admin" id="gb-admin-field" hidden>
          <label for="gb-admin">Gruppadmin</label>
          <select id="gb-admin"></select>
        </div>
      </div>
      <p id="gb-name-st" class="gb-note muted">Skriv ett namn och markera vilka som ska vara med.</p>
      <div class="filters">
        <input id="gb-search" type="search" placeholder="Sök namn, e-post, organisation, titel…" />
        <select id="gb-f-org" aria-label="Organisation"></select>
        <select id="gb-f-title" aria-label="Titel"></select>
      </div>
      <div id="gb-people" class="mx-wrap"><p class="empty">Laddar…</p></div>
    </div>

    <div id="gb-bar" class="batch" hidden>
      <span id="gb-count" class="batch-count"></span>
      <button id="gb-preview" type="button" class="primary">Förhandsgranska</button>
      <button id="gb-clear" type="button" class="ghost">Avmarkera</button>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? `Projekt ${id}`;
  const findGroup = (name) => {
    // Compared in normalised form, so "@Byggbolaget AB" is found when typing "Byggbolaget AB".
    const key = groupName(name).toLowerCase();
    return key ? (state.data?.groups.find((g) => groupName(g.name).toLowerCase() === key) ?? null) : null;
  };

  function render() {
    if (state.data) renderManual();
  }

  /* ---------- manual ---------- */

  function renderManualFilters() {
    const rows = state.data.rows;
    const values = (key) => [...new Set(rows.map((row) => clean(row[key])).filter(Boolean))].sort((a, b) => a.localeCompare(b, "sv"));
    const keep = { org: $("#gb-f-org").value, title: $("#gb-f-title").value };
    $("#gb-f-org").innerHTML = option("", "Alla organisationer") + values("organization").map((v) => option(v, v)).join("");
    $("#gb-f-title").innerHTML = option("", "Alla titlar") + values("title").map((v) => option(v, v)).join("");
    $("#gb-f-org").value = [...$("#gb-f-org").options].some((o) => o.value === keep.org) ? keep.org : "";
    $("#gb-f-title").value = [...$("#gb-f-title").options].some((o) => o.value === keep.title) ? keep.title : "";
    $("#gb-groups").innerHTML = state.data.groups
      .filter((g) => !g.readOnly)
      .map((g) => `<option value="${esc(g.name)}"></option>`)
      .join("");
  }

  function visiblePeople() {
    const query = $("#gb-search").value.trim().toLowerCase();
    const org = $("#gb-f-org").value;
    const title = $("#gb-f-title").value;
    return state.data.rows.filter((row) => {
      if (org && clean(row.organization) !== org) return false;
      if (title && clean(row.title) !== title) return false;
      return !query || [row.name, row.email, row.organization, row.title].some((v) => v.toLowerCase().includes(query));
    });
  }

  /** The ticked users who are not in the group yet. */
  function manualAdds() {
    const group = findGroup($("#gb-name").value);
    return [...state.manual.selected]
      .map((email) => state.data.rowByEmail.get(email))
      .filter((row) => row && !(group && row.groups.has(group.id)));
  }

  function renderManual() {
    const name = groupName($("#gb-name").value);
    const group = findGroup(name);
    const adds = manualAdds();

    const note = $("#gb-name-st");
    note.className = "gb-note";
    if (!name) {
      note.classList.add("muted");
      note.textContent = "Skriv ett namn och markera vilka som ska vara med.";
    } else if (group?.readOnly) {
      note.classList.add("bad");
      note.textContent = `${group.name} är skrivskyddad och kan inte ändras här.`;
    } else if (group) {
      note.classList.add("add");
      note.textContent = `${group.name} finns redan. De du markerar läggs till.`;
    } else {
      note.classList.add("new");
      note.textContent = `${name} skapas som ny grupp.`;
    }

    // A new group needs a group admin, chosen among the ticked users.
    const needsAdmin = Boolean(name) && !group && adds.length > 0;
    $("#gb-admin-field").hidden = !needsAdmin;
    if (needsAdmin) {
      const ranked = [...adds].sort(byRank);
      if (!adds.some((row) => row.email === state.manual.admin)) state.manual.admin = ranked[0].email;
      $("#gb-admin").innerHTML = ranked.map((row) => option(row.email, row.name || row.email, row.email === state.manual.admin)).join("");
    }

    const rows = visiblePeople();
    const selectable = rows.filter((row) => !(group && row.groups.has(group.id)));
    const all = selectable.length > 0 && selectable.every((row) => state.manual.selected.has(row.email));
    $("#gb-people").innerHTML = rows.length
      ? `<table class="gb">
          <thead><tr>
            <th class="gb-c"><input id="gb-pall" type="checkbox" ${all ? "checked" : ""} ${selectable.length ? "" : "disabled"} aria-label="Välj alla synliga" /></th>
            <th>Namn</th><th>Organisation</th><th>Titel</th><th>Roll</th>
          </tr></thead>
          <tbody>${rows
            .map((row) => {
              const member = Boolean(group && row.groups.has(group.id));
              const on = member || state.manual.selected.has(row.email);
              return `<tr class="${member ? "done" : ""} ${row.level === 0 ? "inactive" : ""}" data-email="${esc(row.email)}">
                <td class="gb-c"><input type="checkbox" data-email="${esc(row.email)}" ${on ? "checked" : ""} ${member ? "disabled" : ""} /></td>
                <td><b>${esc(row.name || row.email)}</b>${member ? ` <span class="gb-st ok">redan med</span>` : ""}<small class="gb-sub">${esc(row.email)}</small></td>
                <td>${esc(row.organization) || `<span class="muted">–</span>`}</td>
                <td>${esc(row.title) || `<span class="muted">–</span>`}</td>
                <td>${esc(levelName(row.level))}</td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>`
      : `<p class="empty">Inga användare matchar filtret.</p>`;

    const ready = Boolean(name) && !group?.readOnly && adds.length > 0;
    $("#gb-bar").hidden = state.manual.selected.size === 0;
    $("#gb-preview").disabled = !ready;
    $("#gb-count").textContent = `${state.manual.selected.size} valda` + (name ? "" : " · skriv ett gruppnamn");
  }

  function buildManualOps() {
    const name = groupName($("#gb-name").value);
    const existing = findGroup(name);
    const pid = state.data.projectId;
    const group = existing ? { ...existing } : { id: null, name };
    const adds = manualAdds();
    // Group admin first, so the new group has one from its first membership.
    const rows = existing ? adds : [...adds].sort((a, b) => (b.email === state.manual.admin) - (a.email === state.manual.admin));
    const ops = [];
    if (!existing) ops.push(createGroupOp(pid, projectName(pid), group));
    rows.forEach((row, i) => ops.push(addToGroupOp(pid, row.email, group, !existing && i === 0)));
    const skipped = [...state.manual.selected]
      .filter((email) => !adds.some((row) => row.email === email))
      .map((email) => `${email}: är redan med i ${group.name}`);
    return { ops, skipped };
  }

  $("#gb-name").addEventListener("input", render);
  $("#gb-name").addEventListener("change", (event) => {
    event.target.value = groupName(event.target.value);
    render();
  });
  $("#gb-admin").addEventListener("change", (event) => (state.manual.admin = event.target.value));
  for (const id of ["#gb-search", "#gb-f-org", "#gb-f-title"]) $(id).addEventListener("input", render);

  $("#gb-people").addEventListener("change", (event) => {
    const box = event.target;
    const group = findGroup($("#gb-name").value);
    if (box.id === "gb-pall") {
      for (const row of visiblePeople()) {
        if (group && row.groups.has(group.id)) continue;
        if (box.checked) state.manual.selected.add(row.email);
        else state.manual.selected.delete(row.email);
      }
    } else if (box.dataset.email) {
      if (box.checked) state.manual.selected.add(box.dataset.email);
      else state.manual.selected.delete(box.dataset.email);
    } else return;
    render();
  });

  // Clicking anywhere on a row ticks it, like the user list.
  $("#gb-people").addEventListener("click", (event) => {
    const tr = event.target.closest("tr[data-email]");
    if (!tr || event.target.closest("input, a, button")) return;
    tr.querySelector("input:not(:disabled)")?.click();
  });

  /* ---------- shared ---------- */

  async function load(projectId) {
    state.projectId = projectId;
    state.data = null;
    $("#gb-people").innerHTML = `<p class="empty">Laddar…</p>`;
    $("#gb-bar").hidden = true;
    try {
      const data = await loadProject(rest, projectId);
      if (state.projectId !== projectId) return;
      use(data);
    } catch {
      const message = `<p class="empty">Kan inte läsa ${esc(projectName(projectId))}. Du behöver vara projektadmin där.</p>`;
      $("#gb-people").innerHTML = message;
    }
  }

  function use(data) {
    state.data = data;
    for (const email of [...state.manual.selected]) if (!data.rowByEmail.has(email)) state.manual.selected.delete(email);
    renderManualFilters();
    render();
  }

  $("#gb-project").addEventListener("change", (event) => {
    state.manual.selected.clear();
    load(event.target.value);
  });

  $("#gb-preview").addEventListener("click", () => {
    if (!state.data) return;
    const { ops, skipped } = buildManualOps();
    showPreview(ops, skipped, async () => {
      state.manual.selected.clear();
      await load(state.projectId);
    });
  });

  $("#gb-clear").addEventListener("click", () => {
    state.manual.selected.clear();
    render();
  });

  render();
  load(currentProjectId);

  return {
    /** Reuse a project the main view already loaded. */
    seed(data) {
      if (data.projectId === state.projectId) use(data);
    },
  };
}
