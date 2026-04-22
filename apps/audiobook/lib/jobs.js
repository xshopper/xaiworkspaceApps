/**
 * Job registry — tracks TTS jobs for SSE progress + status queries.
 *
 * Jobs are in-memory only; on server restart any in-flight jobs are lost.
 * The on-disk mp3 is the source of truth for "has this chapter been generated".
 *
 * Terminal jobs (status 'done' or 'error') are evicted after EVICT_TTL_MS so
 * long-running workers don't accumulate unbounded job entries. SSE clients
 * that query mid-eviction will see the snapshot one last time if they caught
 * the update event, then 404 on subsequent polls — callers already treat
 * missing-job as "no progress available".
 */

import { EventEmitter } from 'node:events';

const EVICT_TTL_MS = 5 * 60 * 1000;

class JobRegistry extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.evictionTimers = new Map();
  }

  create({ bookId, chapterIdx, voice, speed, mp3Path, ttsJobId }) {
    const id = ttsJobId;
    const job = {
      id,
      bookId,
      chapterIdx,
      voice,
      speed,
      mp3Path,
      status: 'queued',
      percent: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.emit('update', job);
    return job;
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.emit('update', job);
    // Once a job reaches a terminal state, schedule eviction. Unref() the
    // timer so it never keeps the event loop alive on shutdown.
    if (job.status === 'done' || job.status === 'error') {
      this._scheduleEviction(id);
    }
    return job;
  }

  _scheduleEviction(id) {
    if (this.evictionTimers.has(id)) return;
    const t = setTimeout(() => {
      this.jobs.delete(id);
      this.evictionTimers.delete(id);
    }, EVICT_TTL_MS);
    if (typeof t.unref === 'function') t.unref();
    this.evictionTimers.set(id, t);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  listForBook(bookId) {
    return Array.from(this.jobs.values()).filter((j) => j.bookId === bookId);
  }
}

export const jobs = new JobRegistry();
