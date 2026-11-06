/**
 * User manager data layer.
 *
 * rest(path, { method, body }) goes through StreamBIM.API.makeApiRequest live,
 * or through an in-memory mock on localhost. Both return parsed JSON:API.
 *
 * makeApiRequest hides HTTP status: every error, and some successful writes
 * (201/204), arrive as a DataCloneError. Such errors are marked `blind`, and
 * the batch runner re-reads the server to see whether the write landed.
 */

import { createMockDb, mockMe, mockOrganizations, mockProjects } from "./mock-users.js";

/** Pause between writes. Keeps a batch at roughly four requests a second. */
export const WRITE_GAP_MS = 250;

export const LEVELS = [
  [0, "Inaktiv"],
  [5, "Gäst"],
  [10, "Användare"],
  [15, "Arbetsflödesadmin"],
  [20, "Projektadmin"],
  [25, "Kundadmin"],
  [30, "Ägare"],
];

/** Levels a project admin may hand out. Higher ones are rejected by the server. */
export const ASSIGNABLE_LEVELS = LEVELS.filter(([level]) => level <= 20);

export function levelName(level) {
  return LEVELS.find(([value]) => value === level)?.[1] ?? String(level);
}

export function parseLevel(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  return LEVELS.find(([, name]) => name.toLowerCase() === value)?.[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RestError extends Error {
  constructor(message, blind) {
    super(message);
    this.blind = blind;
  }
}

/** REST through the live widget API. */
export function liveRest(api) {
  return async (path, { method = "GET", body } = {}) => {
    const opts = { url: path, method };
    if (body !== undefined) opts.body = body;
    let text;
    try {
      text = await api.makeApiRequest(opts);
    } catch (error) {
      const blind = /could not be cloned/i.test(error?.message ?? "");
      throw new RestError(blind ? `${method} ${path}: okänt svar` : error?.message || String(error), blind);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

/** REST against fake data, with the same JSON:API shapes as the live server. */
export function mockRest() {
  const db = createMockDb();

  const member = (projectId, m) => ({
    id: `${projectId}-${m.email}`,
    type: "project-members",
    attributes: {
      "given-name": m.given,
      "family-name": m.family,
      organization: m.organization,
      title: m.title,
      phone: m.phone,
      "privilege-level": m.level,
      guest: m.guest,
      invited: m.invited,
      "last-login": m.lastLogin,
    },
    relationships: {
      user: { data: { type: "users", id: m.email } },
      "user-organization": { data: m.orgId ? { type: "user-organizations", id: m.orgId } : null },
    },
  });

  const groupMember = (gm) => ({
    id: gm.id,
    type: "group-members",
    attributes: { "is-admin": gm.admin },
    relationships: {
      group: { data: { type: "groups", id: gm.group } },
      user: { data: { type: "users", id: gm.user } },
    },
  });

  const fail = (message) => {
    throw new RestError(message, true);
  };

  return async (path, { method = "GET", body } = {}) => {
    await sleep(60);
    if (path.startsWith("/mgw/api/v2/customers")) {
      return { data: [{ id: "1", type: "customers", attributes: { "customer-admins": [mockMe] } }] };
    }
    if (path.startsWith("/mgw/api/v3/projects/")) {
      const relationships = { customer: { data: { type: "customers", id: "1" } } };
      return { data: { id: path.split("/").pop(), type: "projects", relationships } };
    }
    if (path.startsWith("/mgw/api/v3/projects")) {
      return { data: mockProjects.map((p) => ({ id: p.id, type: "projects", attributes: { name: p.name } })) };
    }
    if (path.startsWith("/mgw/api/v3/user-organizations")) {
      return {
        data: mockOrganizations.map((o) => ({ id: o.id, type: "user-organizations", attributes: { name: o.name } })),
      };
    }
    const match = path.match(/^\/project-(\d+)\/api\/v1\/v2\/([a-z-]+)(?:\/([^?]+))?/);
    if (!match) fail(`${method} ${path}: okänt svar`);
    const [, projectId, resource, rawId] = match;
    const id = rawId && decodeURIComponent(rawId);
    const p = db.project(projectId);
    if (!p) fail(`${method} ${path}: okänt svar`);

    if (resource === "project-members") {
      if (method === "GET" && !id) return { data: p.members.map((m) => member(projectId, m)) };
      const email = (id ?? body?.data?.id ?? "").replace(`${projectId}-`, "");
      let m = p.members.find((item) => item.email === email);
      if (method === "GET") return m ? { data: member(projectId, m) } : fail(`GET ${path}: okänt svar`);
      const a = body?.data?.attributes ?? {};
      const org = body?.data?.relationships?.["user-organization"]?.data;
      if (method === "POST") {
        if (m) fail(`POST ${path}: okänt svar`);
        m = { email, given: "", family: "", organization: "", orgId: null, title: "", phone: "", level: 10, guest: false, invited: false, lastLogin: null };
        p.members.push(m);
        p.groupMembers.push({ id: db.nextId(), group: "1", user: email, admin: false });
      } else if (method !== "PATCH" || !m) {
        fail(`${method} ${path}: okänt svar`);
      }
      if (method === "PATCH" && email === mockMe && "privilege-level" in a) fail(`PATCH ${path}: okänt svar`);
      if ("given-name" in a) m.given = a["given-name"];
      if ("family-name" in a) m.family = a["family-name"];
      if ("organization" in a) m.organization = a.organization;
      if ("title" in a) m.title = a.title;
      if ("phone" in a) m.phone = a.phone;
      if ("privilege-level" in a) m.level = a["privilege-level"];
      if ("guest" in a) m.guest = a.guest;
      if ("invited" in a) m.invited = a.invited;
      if (org !== undefined) m.orgId = org?.id ?? null;
      return { data: member(projectId, m) };
    }
    if (resource === "users" && method === "GET") {
      return {
        data: p.members.map((m) => ({
          id: m.email,
          type: "users",
          attributes: { name: `${m.given} ${m.family}`.trim(), "first-name": m.given, "last-name": m.family, organization: m.organization },
        })),
      };
    }
    if (resource === "groups" && method === "POST") {
      const name = body?.data?.attributes?.name;
      if (!name || p.groups.some((g) => g.name === name)) fail(`POST ${path}: okänt svar`);
      const group = { id: db.nextId(), name, description: "", readOnly: false };
      p.groups.push(group);
      return { data: { id: group.id, type: "groups", attributes: { name } } };
    }
    if (resource === "groups" && method === "GET") {
      return {
        data: p.groups.map((g) => ({
          id: g.id,
          type: "groups",
          attributes: { name: g.name, description: g.description, organization: "", "is-read-only": g.readOnly },
          relationships: {
            "child-groups": { data: p.groups.filter((c) => c.parent === g.name).map((c) => ({ type: "groups", id: c.id })) },
            "parent-groups": { data: [] },
          },
        })),
      };
    }
    if (resource === "group-members") {
      if (method === "GET") return { data: p.groupMembers.map(groupMember) };
      if (method === "POST") {
        const rel = body?.data?.relationships ?? {};
        const gm = {
          id: db.nextId(),
          group: rel.group?.data?.id,
          user: rel.user?.data?.id,
          admin: Boolean(body?.data?.attributes?.["is-admin"]),
        };
        if (p.groupMembers.some((item) => item.group === gm.group && item.user === gm.user)) fail(`POST ${path}: okänt svar`);
        p.groupMembers.push(gm);
        return { data: groupMember(gm) };
      }
      if (method === "DELETE") {
        const index = p.groupMembers.findIndex((item) => item.id === id);
        if (index < 0) fail(`DELETE ${path}: okänt svar`);
        const gm = p.groupMembers[index];
        const admins = p.groupMembers.filter((item) => item.group === gm.group && item.admin);
        if (gm.admin && admins.length === 1) fail(`DELETE ${path}: okänt svar`);
        p.groupMembers.splice(index, 1);
        return { data: null };
      }
    }
    return fail(`${method} ${path}: okänt svar`);
  };
}

const base = (projectId) => `/project-${projectId}/api/v1/v2`;
const memberId = (projectId, email) => `${projectId}-${email}`;
const relId = (resource, name) => resource?.relationships?.[name]?.data?.id ?? null;

/**
 * Is this user a customer admin of the customer that owns the project?
 * Read from the customer, as the StreamBIM app does: a customer admin does not
 * have to be a member of the project, so project-members cannot answer this.
 * Customers are served by API v2, unlike projects (v3).
 */
export async function isCustomerAdmin(rest, projectId, email) {
  const [project, customers] = await Promise.all([rest(`/mgw/api/v3/projects/${projectId}`), rest("/mgw/api/v2/customers")]);
  const customerId = relId(project?.data, "customer");
  const customer = (customers?.data ?? []).find((c) => String(c.id) === String(customerId));
  const admins = customer?.attributes?.["customer-admins"];
  const me = String(email).trim().toLowerCase();
  return Array.isArray(admins) && admins.some((admin) => String(admin).trim().toLowerCase() === me);
}

export async function loadProjects(rest) {
  const res = await rest("/mgw/api/v3/projects");
  return (res?.data ?? [])
    .filter((p) => !p.attributes?.["deleted-at"])
    .map((p) => ({ id: String(p.id), name: p.attributes?.name || `Projekt ${p.id}`, inactive: Boolean(p.attributes?.["is-inactive"]) }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

export async function loadOrganizations(rest) {
  const res = await rest("/mgw/api/v3/user-organizations");
  return (res?.data ?? [])
    .map((o) => ({ id: String(o.id), name: o.attributes?.name || o.id }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/**
 * Members, groups and memberships for one project, joined into rows.
 * Four reads, run together.
 */
export async function loadProject(rest, projectId, track = (label, promise) => promise) {
  const root = base(projectId);
  const [members, users, groups, groupMembers] = await Promise.all([
    track("Medlemmar", rest(`${root}/project-members`)),
    track("Användarprofiler", rest(`${root}/users`)).catch(() => ({ data: [] })),
    track("Grupper", rest(`${root}/groups`)),
    track("Gruppmedlemskap", rest(`${root}/group-members`)),
  ]);

  const userById = new Map((users?.data ?? []).map((u) => [u.id, u.attributes ?? {}]));
  const groupList = (groups?.data ?? [])
    .map((g) => ({
      id: String(g.id),
      name: g.attributes?.name ?? g.id,
      description: g.attributes?.description ?? "",
      readOnly: Boolean(g.attributes?.["is-read-only"] || g.attributes?.["is-imported"]),
      parentIds: (g.relationships?.["parent-groups"]?.data ?? []).map((r) => String(r.id)),
      childIds: (g.relationships?.["child-groups"]?.data ?? []).map((r) => String(r.id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const groupTree = buildGroupTree(groupList);

  const rows = (members?.data ?? []).map((m) => {
    const a = m.attributes ?? {};
    const email = relId(m, "user") ?? String(m.id).replace(`${projectId}-`, "");
    const u = userById.get(email) ?? {};
    const given = a["given-name"] || u["first-name"] || "";
    const family = a["family-name"] || u["last-name"] || "";
    return {
      email,
      given,
      family,
      // StreamBIM reports "@" as the name of users who never filled one in.
      name: `${given} ${family}`.trim() || (/\p{L}/u.test(u.name ?? "") ? u.name : ""),
      organization: a.organization || u.organization || "",
      orgId: relId(m, "user-organization"),
      title: a.title || u.title || "",
      phone: a.phone || u.phone || "",
      level: Number(a["privilege-level"] ?? 0),
      guest: Boolean(a.guest),
      invited: Boolean(a.invited),
      lastLogin: a["last-login"] || null,
      groups: new Map(),
      adminOf: new Set(),
    };
  });

  const rowByEmail = new Map(rows.map((row) => [row.email, row]));
  for (const gm of groupMembers?.data ?? []) {
    const row = rowByEmail.get(relId(gm, "user"));
    if (!row) continue;
    row.groups.set(String(relId(gm, "group")), String(gm.id));
    if (gm.attributes?.["is-admin"]) row.adminOf.add(String(relId(gm, "group")));
  }
  for (const row of rows) row.inherited = inheritedGroups(row.groups, groupTree.byId);
  rows.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "sv"));
  return { projectId, rows, rowByEmail, groups: groupTree.ordered, groupById: groupTree.byId };
}

/**
 * Groups nest: a child group is a member of its parent, so the child's members
 * belong to the parent too. Links are read from both parent-groups and
 * child-groups. Returns the groups in tree order, each with `depth`, `parents`,
 * `children`, a short `label` and a `path` like "Projektering › El".
 */
function buildGroupTree(list) {
  const byId = new Map(list.map((g) => [g.id, { ...g, parents: new Set(), children: new Set() }]));
  for (const g of byId.values()) {
    for (const id of g.parentIds) if (byId.has(id) && id !== g.id) (g.parents.add(id), byId.get(id).children.add(g.id));
    for (const id of g.childIds) if (byId.has(id) && id !== g.id) (g.children.add(id), byId.get(id).parents.add(g.id));
  }
  const bare = (g) => g.name.replace(/^@/, "");
  const ordered = [];
  const placed = new Set();
  const visit = (g, depth, trail) => {
    if (trail.includes(g.id)) return;
    const parent = byId.get(trail.at(-1));
    if (!placed.has(g.id)) {
      placed.add(g.id);
      g.depth = depth;
      g.label = parent && bare(g).startsWith(`${bare(parent)}_`) ? bare(g).slice(bare(parent).length + 1) : bare(g);
      g.path = trail.map((id) => byId.get(id).label).concat(g.label).join(" › ");
      ordered.push(g);
    }
    [...g.children]
      .map((id) => byId.get(id))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"))
      .forEach((child) => visit(child, depth + 1, [...trail, g.id]));
  };
  const sorted = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "sv"));
  for (const g of sorted) if (!g.parents.size) visit(g, 0, []);
  for (const g of sorted) visit(g, 0, []); // cycles without a root
  return { ordered, byId };
}

/** Groups a user belongs to through a child group: groupId → the direct group it comes through. */
function inheritedGroups(direct, byId) {
  const inherited = new Map();
  for (const id of direct.keys()) {
    const queue = [...(byId.get(id)?.parents ?? [])];
    const seen = new Set([id]);
    while (queue.length) {
      const parent = queue.shift();
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (!direct.has(parent) && !inherited.has(parent)) inherited.set(parent, id);
      queue.push(...(byId.get(parent)?.parents ?? []));
    }
  }
  return inherited;
}

/**
 * StreamBIM refuses to remove a group's last group admin (403
 * theGroupNeedsToHaveAtLeastOneGroupAdmin). Given the emails about to leave
 * `groupId`, return the one that must stay, or null.
 */
export function lastAdminKept(data, groupId, leaving) {
  const admins = data.rows.filter((row) => row.adminOf.has(groupId)).map((row) => row.email);
  const out = new Set(leaving);
  if (!admins.length || admins.some((email) => !out.has(email))) return null;
  return admins.find((email) => out.has(email));
}

/* ---------- Operations: one REST write each, with a check for blind results ---------- */

function memberBody(projectId, email, attributes, orgId) {
  const data = {
    type: "project-members",
    id: memberId(projectId, email),
    attributes,
    relationships: {
      project: { data: { type: "projects", id: String(projectId) } },
      user: { data: { type: "users", id: email } },
    },
  };
  if (orgId !== undefined) {
    data.relationships["user-organization"] = { data: orgId ? { type: "user-organizations", id: orgId } : null };
  }
  return { data };
}

async function readMember(rest, projectId, email) {
  try {
    const res = await rest(`${base(projectId)}/project-members/${encodeURIComponent(memberId(projectId, email))}`);
    return res?.data?.attributes ?? null;
  } catch {
    return null;
  }
}

/** Change fields on an existing member. `attributes` uses API names (given-name, title, …). */
export function patchMemberOp(projectId, row, attributes, orgId, label) {
  return {
    label,
    who: row.email,
    method: "PATCH",
    path: `${base(projectId)}/project-members/${encodeURIComponent(memberId(projectId, row.email))}`,
    body: memberBody(projectId, row.email, attributes, orgId),
    async check(rest) {
      const now = await readMember(rest, projectId, row.email);
      return Boolean(now) && Object.entries(attributes).every(([key, value]) => now[key] === value);
    },
  };
}

/** Add someone as a member of a project (no invitation unless `invite`). */
export function addMemberOp(projectId, email, attributes, orgId, label) {
  return {
    label,
    who: email,
    method: "POST",
    path: `${base(projectId)}/project-members`,
    body: memberBody(projectId, email, { invited: false, ...attributes }, orgId),
    async check(rest) {
      return Boolean(await readMember(rest, projectId, email));
    },
  };
}

async function groupMembers(rest, projectId, cache) {
  cache.groupMembers ??= {};
  cache.groupMembers[projectId] ??= rest(`${base(projectId)}/group-members`).then((res) => res?.data ?? []);
  return cache.groupMembers[projectId];
}

const inGroup = (list, groupId, email) =>
  list.some((gm) => relId(gm, "group") === groupId && relId(gm, "user") === email);

/**
 * POST group-members → 200; 409 if already a member. One pair per request.
 * Verified 2026-11-05 (web app HAR + Rendra's project-mw spec). `admin` makes
 * the user a group administrator.
 */
export function addToGroupOp(projectId, email, group, admin = false) {
  return {
    label: `Lägg till i ${group.name}${admin ? " som gruppadmin" : ""}`,
    who: email,
    method: "POST",
    path: `${base(projectId)}/group-members`,
    // `group` may be a group that a createGroupOp earlier in the batch creates; its id is filled in then.
    ready: () => Boolean(group.id),
    get body() {
      return {
        data: {
          type: "group-members",
          attributes: { "is-admin": admin },
          relationships: {
            group: { data: { type: "groups", id: group.id } },
            user: { data: { type: "users", id: email } },
          },
        },
      };
    },
    async check(rest, cache) {
      return Boolean(group.id) && inGroup(await groupMembers(rest, projectId, cache), group.id, email);
    },
  };
}

/**
 * Create a group in a project and write its id into `group` (a { id, name }
 * object later operations share). NOT verified live: the documented-looking
 * body was rejected on 2026-11-05. The op re-reads the groups to confirm.
 */
export function createGroupOp(projectId, projectName, group) {
  const path = `${base(projectId)}/groups`;
  const findId = async (rest) => {
    const res = await rest(path);
    const found = (res?.data ?? []).find((g) => g.attributes?.name === group.name);
    return found ? String(found.id) : null;
  };
  return {
    label: `Skapa gruppen ${group.name}`,
    who: projectName,
    method: "POST",
    path,
    async run(rest) {
      try {
        const res = await rest(path, {
          method: "POST",
          body: { data: { type: "groups", attributes: { name: group.name, description: "", organization: "" } } },
        });
        if (res?.data?.id) group.id = String(res.data.id);
      } catch (error) {
        if (!error.blind) throw error;
      }
      group.id ??= await findId(rest);
      if (!group.id) throw new RestError("StreamBIM skapade inte gruppen.", false);
    },
    async check() {
      return Boolean(group.id);
    },
  };
}

/** Verified 2026-11-05 from the StreamBIM web app: DELETE group-members/{id} → 200. */
export function removeFromGroupOp(projectId, email, group, groupMemberId) {
  return {
    label: `Ta bort från ${group.name}`,
    who: email,
    method: "DELETE",
    path: `${base(projectId)}/group-members/${groupMemberId}`,
    async check(rest, cache) {
      return !inGroup(await groupMembers(rest, projectId, cache), group.id, email);
    },
  };
}

/**
 * Run operations one at a time, WRITE_GAP_MS apart. Blind results are checked
 * afterwards by re-reading the server. `onUpdate` is called after each step.
 * Returns when done or when `signal.stopped` is set.
 */
export async function runOps(rest, ops, onUpdate, signal = {}) {
  for (const op of ops) op.status = "väntar";
  onUpdate();
  for (const op of ops) {
    if (signal.stopped) break;
    if (op.ready && !op.ready()) {
      op.status = "fel";
      op.error = "Ett tidigare steg misslyckades.";
      onUpdate();
      continue;
    }
    op.status = "kör";
    onUpdate();
    try {
      if (op.run) await op.run(rest);
      else await rest(op.path, { method: op.method, body: op.body });
      op.status = "ok";
    } catch (error) {
      op.status = error.blind ? "kontrollerar" : "fel";
      op.error = error.message;
    }
    onUpdate();
    await sleep(WRITE_GAP_MS);
  }

  const cache = {};
  for (const op of ops.filter((item) => item.status === "kontrollerar")) {
    if (signal.stopped) break;
    let landed = false;
    try {
      landed = await op.check(rest, cache);
    } catch {
      landed = false;
    }
    op.status = landed ? "ok" : "fel";
    if (landed) op.error = "";
    onUpdate();
    await sleep(WRITE_GAP_MS / 2);
  }
  for (const op of ops) if (op.status === "väntar") op.status = "stoppad";
  onUpdate();
}
