import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DOMCollector } from '../../src/collectors/dom';
import { Sanitizer } from '../../src/utils/sanitize';

// Asserts on the serialized rrweb events, not on the sanitizer in isolation:
// calling sanitizeTextNode directly passes even when rrweb never invokes it.
// See apex-bridge/bugspotter-sdk#169.

const EMAIL = 'jane.doe@example.com';
const CONTROL = 'Checkout total updated';
const TOKEN = 'csrf-7f3a9c2e41';
const PASSWORD = 'hunter2secret';
const DRAFT = 'private draft';

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
      (document.getElementById('pw') as HTMLInputElement).value = PASSWORD;
      collector.startRecording();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).not.toContain(PASSWORD);
    });

    it('masks input values typed after recording starts', async () => {
      document.body.innerHTML =
        '<input id="email" type="text"><input id="pw" type="password">';
      collector.startRecording();
      type('email', EMAIL);
      type('pw', PASSWORD);
      await flush();

      expect(serialized()).not.toContain(EMAIL);
      expect(serialized()).not.toContain(PASSWORD);
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

    // A textarea's child text is its default value. alpha.4 serializes it as a
    // text node through maskTextFn (PII patterns only), separately from the
    // masked `attributes.value`, so a non-pattern draft used to leak verbatim.
    describe('textarea child text', () => {
      it('masks child text present at snapshot time', () => {
        document.body.innerHTML = `<textarea>${DRAFT}</textarea><p>${CONTROL}</p>`;
        collector.startRecording();

        expect(serialized()).not.toContain(DRAFT);
        expect(serialized()).toContain(
          `"textContent":"${'*'.repeat(DRAFT.length)}"`
        );
        expect(serialized()).toContain(CONTROL);
      });

      it('masks child text of a textarea added after recording starts', async () => {
        collector.startRecording();
        const ta = document.createElement('textarea');
        ta.textContent = DRAFT;
        document.body.appendChild(ta);
        await flush();

        expect(serialized()).not.toContain(DRAFT);
      });

      it('masks child text appended to an existing textarea', async () => {
        document.body.innerHTML = '<textarea id="ta"></textarea>';
        collector.startRecording();
        document.getElementById('ta')!.append(DRAFT);
        await flush();

        expect(serialized()).not.toContain(DRAFT);
      });

      it('masks child text changed after recording starts', async () => {
        document.body.innerHTML = `<textarea id="ta">${CONTROL}</textarea>`;
        collector.startRecording();
        document.getElementById('ta')!.firstChild!.textContent = DRAFT;
        await flush();

        expect(serialized()).not.toContain(DRAFT);
      });
    });

    // Text whose parent is a ShadowRoot has no parentElement, so alpha.4's
    // needMaskingText skips maskTextFn for it on every path.
    describe('shadow root text', () => {
      const SHADOW = `Shadow contact ${EMAIL}`;

      const host = () => {
        const el = document.createElement('div');
        el.attachShadow({ mode: 'open' });
        return el;
      };

      // The non-PII prefix proves rrweb recorded the shadow text at all.
      const expectShadowRedacted = () => {
        const out = serialized();
        expect(out).toContain('Shadow contact');
        expect(out).not.toContain(EMAIL);
      };

      it('redacts PII present at snapshot time', () => {
        const el = host();
        el.shadowRoot!.append(SHADOW);
        document.body.appendChild(el);
        collector.startRecording();

        expectShadowRedacted();
      });

      it('redacts PII appended after recording starts', async () => {
        const el = host();
        document.body.appendChild(el);
        collector.startRecording();
        el.shadowRoot!.append(SHADOW);
        await flush();

        expectShadowRedacted();
      });

      it('redacts PII in a shadow host added after recording starts', async () => {
        collector.startRecording();
        const el = host();
        el.shadowRoot!.append(SHADOW);
        document.body.appendChild(el);
        await flush();

        expectShadowRedacted();
      });

      it('redacts PII in text changed after recording starts', async () => {
        const el = host();
        const text = document.createTextNode(CONTROL);
        el.shadowRoot!.append(text);
        document.body.appendChild(el);
        collector.startRecording();
        text.data = SHADOW;
        await flush();

        expectShadowRedacted();
      });
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

    it('records textarea child text unmasked', () => {
      document.body.innerHTML = `<textarea>${DRAFT}</textarea>`;
      collector.startRecording();

      expect(serialized()).toContain(`"textContent":"${DRAFT}"`);
    });

    it('still masks password inputs', async () => {
      document.body.innerHTML = '<input id="pw" type="password">';
      (document.getElementById('pw') as HTMLInputElement).value = PASSWORD;
      collector.startRecording();
      type('pw', 'hunter3secret');
      await flush();

      expect(serialized()).not.toContain(PASSWORD);
      expect(serialized()).not.toContain('hunter3secret');
    });
  });

  describe('with a disabled sanitizer', () => {
    beforeEach(() => {
      collector = new DOMCollector({
        sanitizer: new Sanitizer({ enabled: false }),
      });
    });

    it('records hidden input values unmasked', () => {
      document.body.innerHTML = `<input type="hidden" value="${TOKEN}">`;
      collector.startRecording();

      expect(serialized()).toContain(TOKEN);
    });

    it('records textarea child text unmasked', () => {
      document.body.innerHTML = `<textarea>${DRAFT}</textarea>`;
      collector.startRecording();

      expect(serialized()).toContain(`"textContent":"${DRAFT}"`);
    });
  });
});
