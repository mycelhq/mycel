/**
 * The slice of React `next.tsx` actually uses.
 *
 * Not a vendored copy of `@types/react` — deliberately. React is a peer dependency here: the
 * founder's Next.js app owns the version, and a second set of React types in this monorepo would
 * be one more thing to keep in step for no benefit. This file exists so `tsc --noEmit` can check
 * OUR code; consumers resolve the real `react` and get the real types.
 *
 * If `next.tsx` ever needs more of React than this, that is a signal to reach for the real types
 * rather than to grow this file — the provider is meant to stay a side-effect component.
 */
declare module "react" {
  export type ReactNode = unknown;
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  export function useRef<T>(initial: T): { current: T };
}
