import { chromium } from 'playwright';

const COMPOSER = 'div[role="textbox"][contenteditable="true"]';
// Instagram's wording when it limits an account. Any of these pauses the queue.
const WARN_RE = /try again later|action blocked|we restrict certain activity|temporarily (blocked|restricted)|account (has been )?(restricted|suspended|disabled)|we limit how often|help us confirm it's you/i;
const FAIL_RE = /failed to send|couldn.t send|not delivered|message not sent/i;

export class IgError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const rand = (a, b) => a + Math.random() * (b - a);

export class Instagram {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.ctx = null;
    this.page = null;
  }

  get isOpen() { return !!this.ctx; }

  async launch(channel) {
    if (this.ctx) {
      await this.#page();
      await this.page.bringToFront().catch(() => {});
      return;
    }
    const opts = { headless: false, viewport: null, args: ['--start-maximized'] };
    if (channel && channel !== 'chromium') opts.channel = channel;
    this.ctx = await chromium.launchPersistentContext(this.profileDir, opts);
    this.ctx.on('close', () => { this.ctx = null; this.page = null; });
    await this.#page();
    if (!/instagram\.com/.test(this.page.url())) {
      await this.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    }
  }

  async close() { await this.ctx?.close().catch(() => {}); }

  async #page() {
    if (!this.ctx) throw new IgError('browser_closed', 'The Instagram browser window is closed');
    if (!this.page || this.page.isClosed()) {
      this.page = this.ctx.pages().find((p) => !p.isClosed()) || await this.ctx.newPage();
    }
    return this.page;
  }

  async loggedIn() {
    if (!this.ctx) return false;
    const cookies = await this.ctx.cookies('https://www.instagram.com').catch(() => []);
    return cookies.some((c) => c.name === 'sessionid' && c.value);
  }

  checkpoint() {
    const u = this.page?.url() || '';
    return /\/challenge|\/accounts\/login|\/accounts\/suspended|\/accounts\/disabled/.test(u) ? u : null;
  }

  async warning() {
    const boxes = this.page.locator('[role="dialog"], [role="alert"]');
    const n = await boxes.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = await boxes.nth(i).innerText().catch(() => '');
      if (WARN_RE.test(t)) return t.trim().replace(/\s+/g, ' ').slice(0, 200);
    }
    return null;
  }

  async #dismissPopups() {
    if (await this.warning()) return; // never click away a restriction notice
    for (const name of ['Not Now', 'Not now']) {
      const b = this.page.getByRole('button', { name, exact: true }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
  }

  async #guard() {
    const cp = this.checkpoint();
    if (cp) throw new IgError('checkpoint', `Instagram is asking for login/verification (${cp})`);
    const w = await this.warning();
    if (w) throw new IgError('blocked', `Instagram warning: ${w}`);
  }

  /** Opens the DM thread with `username` and returns the composer locator. */
  async openThread(username) {
    const page = await this.#page();
    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, { waitUntil: 'domcontentloaded' });
    await this.#guard();

    const msgBtn = page.getByRole('button', { name: 'Message', exact: true })
      .or(page.getByRole('link', { name: 'Message', exact: true }));
    const notFound = page.getByText(/Sorry, this page isn.t available|Profile isn.t available/i);
    await msgBtn.or(notFound).first().waitFor({ timeout: 15000 }).catch(() => {});
    if (await notFound.first().isVisible().catch(() => false)) throw new IgError('not_found', 'Profile not found');
    await this.#dismissPopups();
    await this.#guard();

    if (await msgBtn.first().isVisible().catch(() => false)) await msgBtn.first().click();
    else await this.#openViaNewMessage(username);

    const box = page.locator(COMPOSER).last();
    await box.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {
      throw new IgError('no_composer', "Couldn't open the chat box (the account may not accept messages)");
    });
    await page.waitForTimeout(1200); // let the thread history render
    await this.#dismissPopups();
    await this.#guard();
    return box;
  }

  // Some profiles hide "Message" under the ⋯ menu; the new-message dialog reaches them too.
  async #openViaNewMessage(username) {
    const page = this.page;
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
    await this.#dismissPopups();
    const newMsg = page.locator('[aria-label="New message"]').first();
    await newMsg.click({ timeout: 15000 }).catch(() => {
      throw new IgError('no_message_button', 'No Message button on the profile and the new-message dialog did not open');
    });
    const search = page.locator('[role="dialog"] input').first();
    await search.waitFor({ timeout: 10000 });
    await search.fill(username);
    const result = page.locator('[role="dialog"]').getByText(username, { exact: true }).first();
    await result.waitFor({ timeout: 10000 }).catch(() => {
      throw new IgError('not_found', 'User not found in the new-message search');
    });
    await result.click();
    await page.getByRole('button', { name: /^(Chat|Next)$/ }).first().click({ timeout: 8000 });
  }

  /**
   * True if a chat bubble with exactly `message` is on the page (we've already sent it).
   * Searches the whole page: Instagram opens chats from a profile as a floating window
   * outside <main>. Matching the full text (not a prefix) matters because every DM from
   * one script starts the same way, and inbox previews ("You: …") must not count.
   */
  async threadContains(message) {
    const want = (message || '').replace(/\s+/g, '');
    if (!want) return false;
    return this.page.evaluate((want) => {
      for (const el of document.body.querySelectorAll('div, span')) {
        const t = el.textContent;
        if (t.length >= want.length && t.length <= want.length * 2 && t.replace(/\s+/g, '') === want) return true;
      }
      return false;
    }, want).catch(() => false);
  }

  async typeMessage(box, text, { humanlike }) {
    const kb = this.page.keyboard;
    await box.click();
    await kb.press('Control+A');
    await kb.press('Backspace');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        if (humanlike) await kb.type(lines[i], { delay: rand(25, 70) });
        else await kb.insertText(lines[i]);
      }
      if (i < lines.length - 1) await kb.press('Shift+Enter');
    }
  }

  async composerText() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.locator(COMPOSER).last().innerText({ timeout: 1000 }).catch(() => null);
  }

  async pressSend() { await this.page.keyboard.press('Enter'); }

  /** After Enter: composer must clear, the text must show in the thread, and no error may appear. */
  async verifySent(message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(700);
      await this.#guard();
      // Only read the chat window itself (the composer's nearest ancestor holding the message),
      // not the profile behind it, whose bio could contain any words.
      const chat = await this.page.evaluate((want) => {
        const boxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
        for (let el = boxes[boxes.length - 1]; el; el = el.parentElement) {
          if (el.textContent.replace(/\s+/g, '').includes(want)) return el.innerText;
        }
        return '';
      }, (message || '').replace(/\s+/g, '')).catch(() => '');
      if (FAIL_RE.test(chat)) throw new IgError('blocked', 'Instagram shows the message as not sent');
      const left = (await this.composerText()) ?? '';
      if (!left.trim() && await this.threadContains(message)) return true;
    }
    throw new IgError('not_confirmed', "Couldn't confirm the message was sent");
  }
}

