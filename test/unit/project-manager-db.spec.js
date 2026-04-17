/**
 * project-manager / db.js — unit test skeletons.
 *
 * These tests exercise schema creation, basic CRUD, and sprint lifecycle
 * (activate / close) against an in-memory sqlite database. Skipped by
 * default because the module under test is ESM and Jest must be run with
 * `--experimental-vm-modules` to import it; the skip keeps `npm test` fast
 * while documenting the shape of the expected coverage.
 *
 * To run:
 *   NODE_OPTIONS='--experimental-vm-modules' npx jest test/unit/project-manager-db.spec.js
 *
 * Replace `describe.skip` with `describe` once we add an ESM-aware runner
 * (or convert db.js to a dual package).
 */

describe.skip('project-manager db.js', () => {
  let db;

  beforeEach(async () => {
    // Dynamic import so the module is only loaded if the suite actually runs.
    const dbMod = await import('../../apps/project-manager/db.js');
    db = dbMod;
    // In-memory sqlite — `:memory:` works via better-sqlite3.
    db.init(':memory:');
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

// Non-skipped placeholder so `npm test` doesn't fail with "Your test suite
// must contain at least one test." when only this file matches.
test('project-manager db spec file loads', () => {
  expect(true).toBe(true);
});
