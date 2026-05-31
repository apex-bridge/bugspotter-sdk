/**
 * Tests for the CaptureManager replay-persistence opt-in path.
 *
 * Pins the three behavior branches the slice 2 wiring added:
 *  1. persistAcrossNavigation: true + valid dbName → persistence is
 *     constructed and passed through to DOMCollector.
 *  2. persistAcrossNavigation: true + missing dbName → warning
 *     logged, persistence NOT constructed (the silent-misconfig
 *     guard the inline comment justifies).
 *  3. Flag omitted or false → no persistence, no IDB writes.
 *
 * Plus the tab-isolation guard added in this round:
 *  4. dbName gets a per-tab suffix from sessionStorage so two tabs
 *     of the same SPA don't share storage.
 *
 * The test uses a thin mock of ReplayPersistence (no real IDB
 * required); the goal is to pin CaptureManager's wiring decisions,
 * not re-test the persistence layer.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// vi.hoisted so the mock factories below can reference these — vi.mock
// is hoisted to the top of the file, before module-level consts run.
const mocks = vi.hoisted(() => {
  const ReplayPersistenceMock = vi.fn();
  const DOMCollectorMock = vi.fn();
  return { ReplayPersistenceMock, DOMCollectorMock };
});

vi.mock('../../src/core/storage/replay-persistence', () => ({
  ReplayPersistence: function (
    this: { dbName: string },
    options: { dbName: string }
  ) {
    mocks.ReplayPersistenceMock(options);
    this.dbName = options.dbName;
  },
}));

vi.mock('../../src/collectors/dom', () => ({
  DOMCollector: function (
    this: {
      startRecording: () => void;
      destroy: () => void;
      getEvents: () => unknown[];
    },
    config: unknown
  ) {
    mocks.DOMCollectorMock(config);
    this.startRecording = vi.fn();
    this.destroy = vi.fn();
    this.getEvents = () => [];
  },
}));

// Import AFTER the mocks so CaptureManager picks them up.
import { CaptureManager } from '../../src/core/capture-manager';

const { ReplayPersistenceMock, DOMCollectorMock } = mocks;

describe('CaptureManager — replay persistence opt-in', () => {
  beforeEach(() => {
    ReplayPersistenceMock.mockClear();
    DOMCollectorMock.mockClear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('branch (a): persistAcrossNavigation + valid dbName', () => {
    it('constructs ReplayPersistence and passes it to DOMCollector', () => {
      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: true,
          dbName: 'host-app',
        },
      });

      expect(ReplayPersistenceMock).toHaveBeenCalledTimes(1);
      const callArg = ReplayPersistenceMock.mock.calls[0][0] as {
        dbName: string;
      };
      // dbName is tab-scoped; see branch (d).
      expect(callArg.dbName.startsWith('host-app-')).toBe(true);

      // DOMCollector receives the persistence instance.
      expect(DOMCollectorMock).toHaveBeenCalledTimes(1);
      const domArg = DOMCollectorMock.mock.calls[0][0] as {
        persistence?: unknown;
      };
      expect(domArg.persistence).toBeDefined();
    });
  });

  describe('branch (b): persistAcrossNavigation but no dbName', () => {
    it('logs a warn and does NOT construct ReplayPersistence', () => {
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: true,
          // dbName: deliberately omitted
        },
      });

      expect(ReplayPersistenceMock).not.toHaveBeenCalled();
      const matchingWarns = warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('persistAcrossNavigation enabled but dbName not set')
      );
      expect(matchingWarns).toHaveLength(1);

      // DOMCollector still constructed (capture proceeds) but with no persistence.
      expect(DOMCollectorMock).toHaveBeenCalledTimes(1);
      const domArg = DOMCollectorMock.mock.calls[0][0] as {
        persistence?: unknown;
      };
      expect(domArg.persistence).toBeUndefined();
    });
  });

  describe('branch (c): flag omitted or false', () => {
    it('does not construct ReplayPersistence when flag is omitted', () => {
      new CaptureManager({
        replay: { enabled: true, dbName: 'unused' },
      });
      expect(ReplayPersistenceMock).not.toHaveBeenCalled();
    });

    it('does not construct ReplayPersistence when flag is explicitly false', () => {
      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: false,
          dbName: 'unused',
        },
      });
      expect(ReplayPersistenceMock).not.toHaveBeenCalled();
    });
  });

  describe('branch (d): tab-scoped dbName', () => {
    it('appends a per-tab id read from sessionStorage', () => {
      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: true,
          dbName: 'tenant-x',
        },
      });
      const arg = ReplayPersistenceMock.mock.calls[0][0] as { dbName: string };
      // Format: "<base>-<8 alphanum chars>"
      expect(arg.dbName).toMatch(/^tenant-x-[a-z0-9]{8}$/);
    });

    it('reuses the existing tabId on reconstruction within the same tab', () => {
      // First instance writes the tabId to sessionStorage.
      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: true,
          dbName: 'tenant-x',
        },
      });
      const first = ReplayPersistenceMock.mock.calls[0][0] as {
        dbName: string;
      };

      // Second instance — same tab, same sessionStorage — should
      // see the same tabId and produce the same dbName.
      ReplayPersistenceMock.mockClear();
      new CaptureManager({
        replay: {
          enabled: true,
          persistAcrossNavigation: true,
          dbName: 'tenant-x',
        },
      });
      const second = ReplayPersistenceMock.mock.calls[0][0] as {
        dbName: string;
      };
      expect(second.dbName).toBe(first.dbName);
    });
  });
});
