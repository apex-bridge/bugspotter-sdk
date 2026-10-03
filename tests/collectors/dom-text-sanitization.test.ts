import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DOMCollector } from '../../src/collectors/dom';
import { Sanitizer } from '../../src/utils/sanitize';

// Asserts on the serialized rrweb events, not on the sanitizer in isolation:
// calling sanitizeTextNode directly passes even when rrweb never invokes it.
// See apex-bridge/bugspotter-sdk#169.

const EMAIL = 'jane.doe@example.com';
const CONTROL = 'Checkout total updated';
const TOKEN = 'csrf-7f3a9c2e41';

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

const type = (id: string, value: string) => {
  const input = document.getElementById(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('DOMCollector replay sanitization', () => {
  let collector: DOMCollector;

  const serialized = () => JSON.stringify(collector.getEvents());

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    collector.stopRecording();
    collector.destroy();
    document.body.innerHTML = '';
  });

  describe('with sanitizer', () => {
    beforeEach(() => {
      collector = new DOMCollector({
        sanitizer: new Sanitizer({ enabled: true }),
      });
    });

    it('redacts PII in text present at snapshot time', () => {
      document.body.innerHTML = `<p>Contact ${EMAIL}</p><p>${CONTROL}</p>`;
      collector.startRecording();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).toContain('[REDACTED-');
      expect(serialized()).toContain(CONTROL);
    });

    it('redacts PII in text added after recording starts', async () => {
      collector.startRecording();
      const p = document.createElement('p');
      p.textContent = `Contact ${EMAIL}`;
      document.body.appendChild(p);
      await flush();

      expect(serialized()).not.toContain(EMAIL);
    });

    it('redacts PII in text changed after recording starts', async () => {
      document.body.innerHTML = `<p id="msg">${CONTROL}</p>`;
      collector.startRecording();
      document.getElementById('msg')!.firstChild!.textContent =
        `Contact ${EMAIL}`;
      await flush();

      expect(serialized()).not.toContain(EMAIL);
    });

    it('masks input values present at snapshot time', () => {
      document.body.innerHTML =
        '<input id="email" type="text"><input id="pw" type="password">';
      (document.getElementById('email') as HTMLInputElement).value = EMAIL;
      (document.getElementById('pw') as HTMLInputElement).value =
        'hunter2secret';
      collector.startRecording();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).not.toContain('hunter2secret');
    });

    it('masks input values typed after recording starts', async () => {
      document.body.innerHTML =
        '<input id="email" type="text"><input id="pw" type="password">';
      collector.startRecording();
      type('email', EMAIL);
      type('pw', 'hunter2secret');
      await flush();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).not.toContain('hunter2secret');
    });

    // rrweb 2.0.0-alpha.4's maskAllInputs map omits `hidden` and matches on
    // the type attribute only, so these two shapes used to serialize raw.
    it('masks hidden input values present at snapshot time', () => {
      document.body.innerHTML = `<input type="hidden" value="${TOKEN}">`;
      collector.startRecording();

      expect(serialized()).not.toContain(TOKEN);
    });

    it('masks hidden input values set after recording starts', async () => {
      document.body.innerHTML =
        '<input id="a" type="hidden"><input id="b" type="hidden">';
      collector.startRecording();
      (document.getElementById('a') as HTMLInputElement).value = TOKEN;
      document.getElementById('b')!.setAttribute('value', `${TOKEN}-attr`);
      await flush();

      expect(serialized()).not.toContain(TOKEN);
    });

    it('masks values of inputs without a type attribute', async () => {
      document.body.innerHTML = `<input value="${EMAIL}"><input id="late">`;
      collector.startRecording();
      document.getElementById('late')!.setAttribute('value', `${TOKEN}-late`);
      await flush();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).not.toContain(TOKEN);
    });
  });

  describe('without sanitizer', () => {
    beforeEach(() => {
      collector = new DOMCollector();
    });

    it('records text unchanged', () => {
      document.body.innerHTML = `<p>${CONTROL}</p>`;
      collector.startRecording();

      expect(serialized()).toContain(CONTROL);
    });

    it('records non-password input values unmasked', () => {
      document.body.innerHTML = `<input type="hidden" value="${TOKEN}">`;
      collector.startRecording();

      expect(serialized()).toContain(TOKEN);
    });

    it('still masks password inputs', async () => {
      document.body.innerHTML = '<input id="pw" type="password">';
      (document.getElementById('pw') as HTMLInputElement).value =
        'hunter2secret';
      collector.startRecording();
      type('pw', 'hunter3secret');
      await flush();

      expect(serialized()).not.toContain('hunter2secret');
      expect(serialized()).not.toContain('hunter3secret');
    });
  });
});
