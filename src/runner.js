import { IgError } from './instagram.js';

const rand = (a, b) => a + Math.random() * (b - a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP_CODES = new Set(['blocked', 'checkpoint', 'browser_closed']);

function inHours(auto, d = new Date()) {
  const h = d.getHours();
  return auto.startHour <= auto.endHour
    ? h >= auto.startHour && h < auto.endHour
    : h >= auto.startHour || h < auto.endHour;
}

function nextStart(auto) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  do d.setHours(d.getHours() + 1); while (!inHours(auto, d));
  return d;
}

export class Runner {
  constructor({ db, ig }) {
    this.db = db;
    this.ig = ig;
    this.state = { running: false, mode: null, phase: 'idle', detail: '', lead: null, nextAt: null };
    this.flags = { stop: false, skip: false, markSent: false };
  }

  #set(patch) { Object.assign(this.state, patch); }

  start(mode) {
    if (this.state.running) throw new Error('Already running');
    if (!this.ig.isOpen) throw new Error('Open the Instagram browser first');
    this.flags = { stop: false, skip: false, markSent: false };
    this.#set({ running: true, mode, phase: 'starting', detail: '', lead: null, nextAt: null });
    this.db.log('info', `Started ${mode === 'auto' ? 'automatic' : 'assisted'} sending`);
    const loop = mode === 'auto' ? this.#autoLoop() : this.#assistLoop();
    loop
      .catch((e) => this.#pause(`Stopped on error: ${e.message}`))
      .finally(() => {
        this.#set({ running: false, lead: null, nextAt: null });
        if (!['paused', 'done', 'cap'].includes(this.state.phase)) this.#set({ phase: 'idle', detail: '' });
      });
  }

  stop() { this.flags.stop = true; }
  skip() { this.flags.skip = true; }
  markSent() { this.flags.markSent = true; }

  #pause(reason) {
    this.#set({ phase: 'paused', detail: reason });
    this.db.log('warn', reason);
  }

  async #sleep(ms, phase, detail = '') {
    this.#set({ phase, detail, nextAt: Date.now() + ms });
    const end = Date.now() + ms;
    while (Date.now() < end && !this.flags.stop && !this.flags.skip) await wait(Math.min(500, end - Date.now()));
    this.flags.skip = false;
    this.#set({ nextAt: null });
  }

  #fail(lead, e) {
    this.db.updateLead(lead.id, { status: 'failed', error: e.message });
    this.db.log('error', `@${lead.username}: ${e.message}`);
  }

  #sent(lead) {
    this.db.updateLead(lead.id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
    this.db.log('ok', `Sent to @${lead.username}`);
  }

  /** Opens the thread and fills the message. Returns false if the lead was skipped as already messaged. */
  async #prepare(lead, humanlike) {
    this.#set({ lead: { id: lead.id, username: lead.username, name: lead.name, message: lead.message }, phase: 'opening', detail: `Opening @${lead.username}` });
    const box = await this.ig.openThread(lead.username);
    if (await this.ig.threadContains(lead.message)) {
      this.db.updateLead(lead.id, { status: 'skipped', error: 'Already in this conversation — not sent again' });
      this.db.log('warn', `@${lead.username}: message already in thread, skipped`);
      return false;
    }
    this.#set({ phase: 'typing', detail: 'Typing message' });
    await this.ig.typeMessage(box, lead.message, { humanlike });
    return true;
  }

  // ---------- Assisted: app opens + types, you press Enter ----------
  async #assistLoop() {
    while (!this.flags.stop) {
      const lead = this.db.nextReady();
      if (!lead) { this.#set({ phase: 'done', detail: 'No more ready leads' }); return; }
      try {
        if (!(await this.#prepare(lead, false))) continue;
      } catch (e) {
        // Account-level problems leave the lead in the queue; only lead-level problems fail it.
        if (e instanceof IgError && STOP_CODES.has(e.code)) return this.#pause(e.message);
        this.#fail(lead, e);
        continue;
      }
      const result = await this.#waitForUser(lead);
      if (result === 'sent') { this.#sent(lead); await wait(800); }
      else if (result === 'skipped') { this.db.updateLead(lead.id, { status: 'skipped' }); this.db.log('info', `Skipped @${lead.username}`); }
      else if (result === 'blocked') return this.#pause(`Instagram showed a warning while messaging @${lead.username}. Stop sending for today.`);
      else if (result === 'closed') return this.#pause('The Instagram window was closed');
      else return; // stopped
    }
  }

  async #waitForUser(lead) {
    this.#set({ phase: 'waiting_user', detail: 'Check the message, then press Enter in the Instagram window' });
    this.flags.skip = false;
    this.flags.markSent = false;
    let last = lead.message;
    let ticks = 0;
    while (true) {
      if (this.flags.stop) return 'stopped';
      if (this.flags.skip) { this.flags.skip = false; return 'skipped'; }
      if (this.flags.markSent) { this.flags.markSent = false; return 'sent'; }
      if (!this.ig.isOpen) return 'closed';
      await wait(600);
      if (++ticks % 5 === 0 && await this.ig.warning().catch(() => null)) return 'blocked';
      const text = await this.ig.composerText();
      if (text === null) continue;
      if (text.trim()) { last = text; continue; }
      // Composer emptied: sent, or the user cleared it. Confirm by finding the text in the thread.
      await wait(1500);
      if (await this.ig.threadContains(last)) return 'sent';
      last = '';
    }
  }

  // ---------- Automatic: paced sending with caps and safety stops ----------
  async #autoLoop() {
    let fails = 0;
    let sinceBreak = 0;
    let breakAt = null;
    while (!this.flags.stop) {
      const s = this.db.getSettings().auto;
      breakAt ??= Math.max(1, Math.round(rand(s.breakEvery - 2, s.breakEvery + 2)));

      if (!inHours(s)) {
        const at = nextStart(s);
        await this.#sleep(at - Date.now(), 'sleeping', `Outside active hours (${s.startHour}:00–${s.endHour}:00)`);
        continue;
      }
      if (this.db.sentToday() >= s.dailyCap) {
        const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(s.startHour, 0, 0, 0);
        this.db.log('info', `Daily cap of ${s.dailyCap} reached — resuming tomorrow`);
        await this.#sleep(t - Date.now(), 'cap', `Daily cap reached (${s.dailyCap}). Resumes tomorrow at ${s.startHour}:00`);
        continue;
      }
      const lead = this.db.nextReady();
      if (!lead) { this.#set({ phase: 'done', detail: 'No more ready leads' }); return; }

      try {
        if (!(await this.#prepare(lead, true))) continue;
        await wait(rand(600, 1800));
        if (this.flags.stop) return;
        this.#set({ phase: 'sending', detail: 'Sending' });
        await this.ig.pressSend();
        await this.ig.verifySent(lead.message);
        this.#sent(lead);
        fails = 0;
        sinceBreak++;
      } catch (e) {
        if (e instanceof IgError && STOP_CODES.has(e.code)) {
          if (this.state.phase === 'sending') this.#fail(lead, e); // may have gone out; don't resend blindly
          return this.#pause(`${e.message}. Automatic sending paused.`);
        }
        this.#fail(lead, e);
        if (++fails >= 3) return this.#pause('3 failures in a row — paused so you can check the Instagram window');
        await this.#sleep(rand(20, 40) * 1000, 'waiting', 'Short pause after a failed lead');
        continue;
      }

      if (sinceBreak >= breakAt) {
        sinceBreak = 0;
        breakAt = null;
        await this.#sleep(rand(s.breakMinMin, s.breakMaxMin) * 60000, 'break', 'Taking a longer break');
      } else {
        await this.#sleep(rand(s.minDelaySec, s.maxDelaySec) * 1000, 'waiting', 'Waiting before the next DM');
      }
    }
  }
}
