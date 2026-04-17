/**
 * project-manager / db.js — unit test skeletons.
 *
 * Schema / CRUD / sprint lifecycle tests run against an in-memory sqlite
 * database. These are gated behind `describe.skip` until we run Jest with
 * `--experimental-vm-modules` (the module is ESM); the authenticate() test
 * below is pure-logic and runs unconditionally.
 *
 * To run the skipped tests:
 *   NODE_OPTIONS='--experimental-vm-modules' npx jest test/unit/project-manager-db.spec.js
 */

describe('project-manager — authenticate() guard semantics (fail-closed)', () => {
  // Mirrors server.js:authenticate() — round-4 contract. If BRIDGE_TOKEN is
  // falsy (not configured) we FAIL CLOSED: every authenticated endpoint
  // returns 401. This is the opposite of the pre-round-4 "open mode" and
  // is enforced by:
  //   if (!BRIDGE_TOKEN || req.headers['x-app-bridge-token'] !== BRIDGE_TOKEN)
  // Any regression that reintroduces open-mode fallback MUST fail this
  // suite (see the "unconfigured" cases below).
  function authenticateLike(token, headerToken) {
    if (!token || headerToken !== token) return false;
    return true;
  }

  test('unconfigured token (empty string) rejects all requests', () => {
    expect(authenticateLike('', undefined)).toBe(false);
    expect(authenticateLike('', 'anything')).toBe(false);
    // Even a header matching the empty string must be rejected — that was
    // the classic open-mode bypass.
    expect(authenticateLike('', '')).toBe(false);
  });

  test('unconfigured token (undefined) rejects all requests', () => {
    expect(authenticateLike(undefined, undefined)).toBe(false);
    expect(authenticateLike(undefined, 'anything')).toBe(false);
  });

  test('unconfigured token (null) rejects all requests', () => {
    expect(authenticateLike(null, undefined)).toBe(false);
    expect(authenticateLike(null, 'anything')).toBe(false);
  });

  test('configured token rejects when header missing', () => {
    expect(authenticateLike('secret', undefined)).toBe(false);
  });

  test('configured token rejects when header mismatches', () => {
    expect(authenticateLike('secret', 'wrong')).toBe(false);
  });

  test('configured token accepts exact match', () => {
    expect(authenticateLike('secret', 'secret')).toBe(true);
  });

  test('server.js source enforces fail-closed (regression guard)', () => {
    // Textual invariant: the authenticate() body must use `!BRIDGE_TOKEN ||`
    // not `BRIDGE_TOKEN &&`. If anyone flips the operator back to the open-
    // mode form, this regex miss will catch it.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/project-manager/server.js'),
      'utf8'
    );
    expect(src).toMatch(/!BRIDGE_TOKEN\s*\|\|\s*req\.headers\['x-app-bridge-token'\]\s*!==\s*BRIDGE_TOKEN/);
  });
});

describe.skip('project-manager db.js', () => {
  let db;

  beforeEach(async () => {
    // Dynamic import so the module is only loaded if the suite actually runs.
    const dbMod = await import('../../apps/project-manager/db.js');
    db = dbMod;
    // In-memory sqlite — `:memory:` works via better-sqlite3.
    db.init(':memory:');
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  describe('projects', () => {
    test('createProject returns a row with id, name, description', () => {
      const p = db.createProject({ name: 'X', description: 'd' });
      expect(p.id).toEqual(expect.any(String));
      expect(p.name).toBe('X');
      expect(p.description).toBe('d');
    });

    test('listProjects returns empty array when none exist', () => {
      expect(db.listProjects()).toEqual([]);
    });

    test('deleteProject cascades to tasks and sprints', () => {
      const p = db.createProject({ name: 'X' });
      db.createTask(p.id, { title: 'T1' });
      db.createSprint(p.id, { name: 'S1' });
      expect(db.deleteProject(p.id)).toBe(true);
      expect(db.listTasks(p.id)).toEqual([]);
      expect(db.listSprints(p.id)).toEqual([]);
    });
  });

  describe('closeSprint', () => {
    test('moves incomplete tasks to next planned sprint', () => {
      const p = db.createProject({ name: 'X' });
      const s1 = db.createSprint(p.id, { name: 'S1' });
      const s2 = db.createSprint(p.id, { name: 'S2' });
      db.activateSprint(s1.id);
      db.createTask(p.id, { title: 'done task', status: 'done', sprint_id: s1.id });
      const t2 = db.createTask(p.id, { title: 'incomplete', sprint_id: s1.id });
      const result = db.closeSprint(s1.id);
      expect(result.velocity).toBeGreaterThanOrEqual(0);
      expect(result.incomplete).toBe(1);
      // Incomplete task should have moved to s2
      const moved = db.listTasks(p.id, { sprint_id: s2.id });
      expect(moved.map((t) => t.id)).toContain(t2.id);
    });

    test('refuses to close non-active sprint', () => {
      const p = db.createProject({ name: 'X' });
      const s = db.createSprint(p.id, { name: 'S' });
      const result = db.closeSprint(s.id);
      expect(result.error).toMatch(/active/i);
    });
  });
});
