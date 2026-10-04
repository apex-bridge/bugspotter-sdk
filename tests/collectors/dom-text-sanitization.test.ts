import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { eventWithTime } from '@rrweb/types';
import { DOMCollector } from '../../src/collectors/dom';
import { Sanitizer } from '../../src/utils/sanitize';
import type {
  ReplayPersistence,
  PersistableBuffer,
} from '../../src/core/storage/replay-persistence';

// Asserts on the serialized rrweb events, not on the sanitizer in isolation:
// calling sanitizeTextNode directly passes even when rrweb never invokes it.
// See apex-bridge/bugspotter-sdk#169.

const EMAIL = 'jane.doe@example.com';
const CONTROL = 'Checkout total updated';
const TOKEN = 'csrf-7f3a9c2e41';
const PASSWORD = 'hunter2secret';
const DRAFT = 'private draft';

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

// Entries held by the collector's textarea tracking. Memory isn't observable
// through events, so this reads the private field.
const trackedNodes = (collector: DOMCollector): number =>
  (collector as unknown as { replayNodes: { size: number } }).replayNodes.size;

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

    it('redacts PII in the page URL of meta events', () => {
      const original = window.location.href;
      window.history.pushState({}, '', `/reset?email=${EMAIL}`);
      try {
        collector.startRecording();
      } finally {
        window.history.replaceState({}, '', original);
      }

      expect(serialized()).toContain('/reset?email=');
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

      it('does not grow tracking across repeated mounts', async () => {
        collector.startRecording();
        const mountAndUnmount = async () => {
          const container = document.createElement('div');
          container.innerHTML = `<textarea>${DRAFT}</textarea>`;
          document.body.appendChild(container);
          await flush();
          container.remove();
          await flush();
        };
        await mountAndUnmount();
        const baseline = trackedNodes(collector);
        for (let i = 0; i < 10; i++) {
          await mountAndUnmount();
        }

        expect(serialized()).not.toContain(DRAFT);
        expect(trackedNodes(collector)).toBe(baseline);
      });
    });

    // A recorded child frame calls rrweb's postMessage instead of our emit, so
    // the guard runs only in the parent. rrweb remaps child ids to ids the
    // parent's record.mirror doesn't hold. Posts what a child record() sends.
    describe('textarea child text in a cross-origin iframe', () => {
      const REMOTE_TEXTAREA = 5;
      const REMOTE_TEXT = 6;
      const iframe = document.createElement('iframe');
      // As in a real cross-origin frame, so rrweb never attaches it itself.
      Object.defineProperty(iframe, 'contentDocument', { value: null });

      const postFromChild = (event: object) =>
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data: { type: 'rrweb', event, isCheckout: false },
            source: iframe.contentWindow,
          })
        );

      const childMutation = (data: object) =>
        postFromChild({
          type: 3,
          timestamp: Date.now(),
          data: {
            source: 0,
            adds: [],
            removes: [],
            texts: [],
            attributes: [],
            ...data,
          },
        });

      beforeEach(() => {
        collector = new DOMCollector({
          sanitizer: new Sanitizer({ enabled: true }),
          recordCrossOriginIframes: true,
        });
        document.body.appendChild(iframe);
        collector.startRecording();
        childSnapshot();
      });

      const childSnapshot = () =>
        postFromChild({
          type: 2,
          timestamp: Date.now(),
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                {
                  type: 2,
                  id: 2,
                  tagName: 'html',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 3,
                      tagName: 'body',
                      attributes: {},
                      childNodes: [
                        {
                          type: 2,
                          id: REMOTE_TEXTAREA,
                          tagName: 'textarea',
                          attributes: {},
                          childNodes: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
        });

      it('masks child text appended to an existing textarea', () => {
        childMutation({
          adds: [
            {
              parentId: REMOTE_TEXTAREA,
              nextId: null,
              node: { type: 3, id: REMOTE_TEXT, textContent: DRAFT },
            },
          ],
        });

        expect(serialized()).toContain('"tagName":"textarea"');
        expect(serialized()).not.toContain(DRAFT);
      });

      it('masks child text changed after recording starts', () => {
        childMutation({
          adds: [
            {
              parentId: REMOTE_TEXTAREA,
              nextId: null,
              node: { type: 3, id: REMOTE_TEXT, textContent: CONTROL },
            },
          ],
        });
        childMutation({ texts: [{ id: REMOTE_TEXT, value: DRAFT }] });

        expect(serialized()).not.toContain(DRAFT);
      });

      // rrweb emits one remove per removed subtree root.
      it('does not grow tracking across repeated mounts', () => {
        let nextId = 100;
        const mountAndUnmount = () => {
          const container = nextId++;
          const textarea = nextId++;
          const text = nextId++;
          childMutation({
            adds: [
              {
                parentId: 3,
                nextId: null,
                node: {
                  type: 2,
                  id: container,
                  tagName: 'div',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: textarea,
                      tagName: 'textarea',
                      attributes: {},
                      childNodes: [{ type: 3, id: text, textContent: CONTROL }],
                    },
                  ],
                },
              },
            ],
          });
          childMutation({ texts: [{ id: text, value: DRAFT }] });
          childMutation({ removes: [{ parentId: 3, id: container }] });
        };
        mountAndUnmount();
        const baseline = trackedNodes(collector);
        for (let i = 0; i < 10; i++) {
          mountAndUnmount();
        }

        expect(serialized()).not.toContain(DRAFT);
        expect(trackedNodes(collector)).toBe(baseline);
      });

      it('drops tracking when the frame re-snapshots or is removed', async () => {
        const initial = trackedNodes(collector);
        childSnapshot();
        expect(trackedNodes(collector)).toBe(initial);

        iframe.remove();
        await flush();
        expect(trackedNodes(collector)).toBe(0);
      });
    });

    // Events restored from IndexedDB may come from an SDK version or a page
    // that didn't sanitize, and carry a previous page's node ids.
    describe('events restored from persistence', () => {
      const LEGACY_TEXT = 13;

      const legacyEvents = () => {
        const now = Date.now();
        return [
          {
            type: 4,
            timestamp: now,
            data: {
              href: `https://app.example/reset?email=${EMAIL}`,
              width: 800,
              height: 600,
            },
          },
          {
            type: 2,
            timestamp: now + 1,
            data: {
              node: {
                type: 0,
                id: 1,
                childNodes: [
                  {
                    type: 2,
                    id: 10,
                    tagName: 'body',
                    attributes: {},
                    childNodes: [
                      {
                        type: 2,
                        id: 11,
                        tagName: 'p',
                        attributes: {},
                        childNodes: [
                          { type: 3, id: 12, textContent: `Contact ${EMAIL}` },
                        ],
                      },
                      {
                        type: 2,
                        id: 14,
                        tagName: 'textarea',
                        attributes: {},
                        childNodes: [
                          { type: 3, id: LEGACY_TEXT, textContent: DRAFT },
                        ],
                      },
                    ],
                  },
                ],
              },
              initialOffset: { top: 0, left: 0 },
            },
          },
          {
            type: 3,
            timestamp: now + 2,
            data: {
              source: 0,
              adds: [],
              removes: [],
              attributes: [],
              texts: [{ id: LEGACY_TEXT, value: `${DRAFT} v2` }],
            },
          },
        ] as unknown as eventWithTime[];
      };

      const restoring = (events: eventWithTime[]) =>
        ({
          bind: vi.fn(),
          restore: vi.fn(async (buffer: PersistableBuffer) => {
            buffer.addBatch(events);
          }),
          flush: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn(),
        }) as unknown as ReplayPersistence;

      const restoreInto = async (events: eventWithTime[]) => {
        const restored = new DOMCollector({
          sanitizer: new Sanitizer({ enabled: true }),
          persistence: restoring(events),
        });
        restored.startRecording();
        await flush();
        return restored;
      };

      it('sanitizes and masks legacy events before buffering them', async () => {
        collector = await restoreInto(legacyEvents());

        expect(serialized()).toContain('/reset?email=');
        expect(serialized()).toContain('Contact ');
        expect(serialized()).not.toContain(EMAIL);
        expect(serialized()).not.toContain(DRAFT);
        // Restored ids belong to a previous page: no live tracking.
        expect(trackedNodes(collector)).toBe(0);
      });

      it('leaves events restored twice unchanged', async () => {
        const events = legacyEvents();
        const first = await restoreInto(events);
        const once = JSON.stringify(first.getEvents());
        first.destroy();

        collector = await restoreInto(events);
        const twice = JSON.stringify(
          collector.getEvents().slice(0, events.length)
        );

        expect(once).toContain(`"textContent":"${'*'.repeat(DRAFT.length)}"`);
        expect(twice).toBe(
          JSON.stringify(JSON.parse(once).slice(0, events.length))
        );
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
