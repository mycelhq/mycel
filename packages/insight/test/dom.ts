/**
 * The smallest browser this package can be tested against.
 *
 * Not jsdom. The point of these tests is the consent gate, the redactor and the queue — none of
 * which touch layout, parsing or rendering — and pulling a 5MB DOM implementation into a package
 * whose defining property is zero runtime dependencies would mean the test environment is heavier
 * than the thing it tests. What is actually needed is: two storages, an event target, a location and
 * a crypto. That is what this is.
 *
 * `localStorage` is modelled as own properties rather than an internal Map, deliberately: the
 * consent sweep iterates `Object.keys(store)`, which is exactly the behaviour that would be missed
 * by a Map-backed stub with a `keys()` method bolted on — and that sweep is the mechanism that makes
 * withdrawal real.
 */

export class MemoryStorage {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this, key) ? String((this as never as Record<string, unknown>)[key]) : null;
  }
  setItem(key: string, value: string): void {
    (this as never as Record<string, unknown>)[key] = String(value);
  }
  removeItem(key: string): void {
    delete (this as never as Record<string, unknown>)[key];
  }
}

export interface FakeWindow extends EventTarget {
  localStorage: MemoryStorage;
  sessionStorage: MemoryStorage;
  location: { pathname: string; href: string };
  crypto: { getRandomValues(a: Uint8Array): Uint8Array };
}

/** Install a fresh window/document. Call at the top of every test so nothing leaks between them. */
export function installDom(pathname = "/"): FakeWindow {
  const target = new EventTarget() as FakeWindow;
  target.localStorage = new MemoryStorage();
  target.sessionStorage = new MemoryStorage();
  target.location = { pathname, href: `https://example.test${pathname}` };
  target.crypto = {
    getRandomValues(a: Uint8Array) {
      for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
      return a;
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = target;
  g.document = { visibilityState: "visible" };
  // `navigator` is deliberately left as Node's own: it is a getter-only global here, and the client
  // only reaches for `sendBeacon` when no `transport` was injected — which these tests always inject.
  return target;
}

export function clearDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.document;
}

/** Read a storage as a plain object — what the sweep tests assert against. */
export function snapshot(store: MemoryStorage): Record<string, string> {
  return { ...(store as unknown as Record<string, string>) };
}
