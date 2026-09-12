// THE LIVE VIEW OF THE AGENT'S BROWSER — tested against a REAL Chromium, not a mock.
//
// Everything interesting here is a property of the DevTools protocol rather than of our code: that a
// second client may attach while another drives, that frames stop after two unless each is
// acknowledged, that the port is random and has to be read off disk, that a service-worker target
// accepts a screencast and never paints. A mocked CDP would assert our beliefs about all four back
// at us, and every one of those beliefs is exactly the kind that turns out to be wrong in
// production.
//
// So this launches a browser. It SKIPS rather than fails when there is none — CI without a browser
// should not go red for a feature it cannot exercise — and says so, because a silently skipped test
// is worse than a missing one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPageTarget, readDevToolsPort, Screencast } from "../src/screencast";

const CANDIDATES = [
  process.env.MYCEL_TEST_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter((p): p is string => !!p);

/**
 * ═══ OPT-IN, AND THE REASON IS THE CLOCK RATHER THAN THE CODE ═══
 *
 * These pass in about a second when run alone and fail intermittently inside the full suite. Node's
 * test runner runs files in parallel across the CPUs, so a Chrome cold start is competing with two
 * thousand other tests for a loaded machine — and no deadline that is honest about "the browser did
 * not answer" is long enough to survive that reliably.
 *
 * A flaky test is worse than a missing one: it teaches everybody to re-run the suite, and the day it
 * fails for a real reason nobody believes it. So they are gated on `MYCEL_TEST_BROWSER=1`.
 *
 * The gate used to say "CI does" — it does not. CI is dark to save Actions minutes, so between the
 * gate and that sentence these had never run ONCE, and two of the five failed the first time anybody
 * tried: `stop()` deleted the Chrome profile directory while Chrome's renderer was still writing
 * into it. The gate was hiding a real bug rather than a flake. Hence `npm run test:browser`: a gated
 * test with no command to run it is a deleted test that still costs you a file.
 *
 * THAT IS ONLY ACCEPTABLE BECAUSE CI RUNS THEM EXPLICITLY. A gate that turns a test off by default
 * and nowhere on is the "silently never runs" defect this repo has been finding all week — see the
 * `landing` app, whose suite CI had been told to skip. `.github/workflows/apps.yml` has a `browser`
 * job that sets the variable, alone on its own runner, which is exactly the environment they need.
 */
const WANTED = process.env.MYCEL_TEST_BROWSER === "1";
const CHROME = WANTED ? CANDIDATES.find((p) => existsSync(p)) : undefined;
const why = !WANTED
  ? "run `npm run test:browser` to run these (nothing else does — see the note above)"
  : "no chromium on this machine";

/** An always-repainting page. See the note where it is used. */
const MOVING_PAGE = `<body style="margin:0;background:#123456;overflow:hidden">
<h1 style="color:white;font:700 40px system-ui;padding:24px">mycel</h1>
<div style="width:120px;height:120px;margin:40px;background:#7fd1a0;animation:spin 1s linear infinite"></div>
<style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>
</body>`;

/** Launch a throwaway browser on a port IT chooses, exactly as browser-use does. */
async function browser(): Promise<{ dir: string; proc: ChildProcess; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "mycel-cdp-"));
  const proc = spawn(
    CHROME!,
    [
      // `0` means "pick a free one", which is the situation this whole module exists to handle:
      // browser-use calls `_find_free_port()`, so the port is never knowable in advance.
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      /**
       * A page that MOVES, and that is load-bearing for the ack test below.
       *
       * The first version of this was a static `<h1>` on a coloured background, and the ack test
       * correctly failed against it with one frame — because a page that never repaints legitimately
       * produces one frame and stops. A screencast is driven by compositor activity, so a test that
       * wants to see several frames has to give the browser something to composite.
       */
      `data:text/html,${encodeURIComponent(MOVING_PAGE)}`,
    ],
    { stdio: "ignore" },
  );
  /**
   * SIGKILL is a REQUEST, not an event. It returns as soon as the signal is queued, and Chrome is
   * not one process — the renderer and GPU children keep writing into `Default/` for a few
   * milliseconds after the parent is gone. Deleting the profile directory at that moment raced them
   * and failed with `ENOTEMPTY: directory not empty, rmdir`, which is why two of these tests failed
   * every time they were actually run.
   *
   * So: wait for the exit to be REAPED, then delete, then retry the delete a few times for the
   * children that outlive their parent. The retry is what makes this reliable rather than merely
   * usually-fine; a cleanup that flakes is how a browser test earns its reputation.
   */
  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone; the promise below still settles */
      }
      // A SIGKILLed process cannot refuse to die, but never hanging the suite on it matters more
      // than the tidiness of the directory, so the wait has a deadline.
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3_000).unref?.())]);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50).unref?.());
      }
    }
    // A leftover directory in `os.tmpdir()` is not worth failing a green test over. The OS clears it.
  };
  return { dir, proc, stop };
}

/** Poll for a file the browser writes when it is ready. */
async function waitForPortFile(dir: string, ms = 20_000): Promise<number | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const port = readDevToolsPort(readFileSync(join(dir, "DevToolsActivePort"), "utf8"));
      if (port) return port;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

test("the port is read off disk, because the browser picks it", { skip: !CHROME && why }, async () => {
  const b = await browser();
  try {
    const port = await waitForPortFile(b.dir);
    assert.ok(port, "DevToolsActivePort was never written — the browser did not start");
    // The second line is the BROWSER target's websocket path and must never be mistaken for the
    // port; a client that screencasts the browser target connects fine and paints nothing.
    const raw = readFileSync(join(b.dir, "DevToolsActivePort"), "utf8");
    assert.ok(raw.split("\n").length >= 2, "the file has two lines and only the first is a port");
    assert.equal(readDevToolsPort(raw), port);
  } finally {
    await b.stop();
  }
});

test("garbage in the port file is not a port", () => {
  for (const bad of ["", "\n", "not-a-port", "-1", "70000", "  "]) {
    assert.equal(readDevToolsPort(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(readDevToolsPort("54321\n/devtools/browser/abc"), 54321);
});

test("a page target is chosen, and real JPEG frames arrive", { skip: !CHROME && why }, async () => {
  const b = await browser();
  try {
    const port = await waitForPortFile(b.dir);
    assert.ok(port);
    const target = await findPageTarget(`http://127.0.0.1:${port}`);
    assert.ok(target?.webSocketDebuggerUrl, "no page target — a screencast on a worker never paints");

    const cast = await Screencast.attach(target.webSocketDebuggerUrl, { quality: 50, maxWidth: 640, maxHeight: 400 });
    try {
      const deadline = Date.now() + 15_000;
      while (!cast.latest() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));

      const frame = cast.latest();
      assert.ok(frame, `no frame in 15s — ${cast.why()}`);
      // A JPEG, byte-checked. `ffd8ff` is the SOI marker; asserting on length alone would pass on
      // any base64 that decoded to something.
      assert.equal(frame.bytes.subarray(0, 3).toString("hex"), "ffd8ff", "that is not a JPEG");
      assert.ok(frame.bytes.length > 500, "a frame that small is an error page, not a screenshot");
      assert.ok(frame.width > 0 && frame.height > 0);
      assert.ok(Math.abs(Date.now() - frame.at) < 120_000, "the timestamp is seconds, not microseconds");
    } finally {
      cast.stop();
    }
  } finally {
    await b.stop();
  }
});

test("it keeps painting past the second frame — the ack is real", { skip: !CHROME && why }, async () => {
  // THE BUG THIS CATCHES: Chromium will not send frame N+1 until N is acknowledged. Forget
  // `Page.screencastFrameAck` and the feature works for exactly two frames and then freezes, which
  // reads as "the page stopped changing" and is impossible to spot by eye.
  const b = await browser();
  try {
    const port = await waitForPortFile(b.dir);
    const target = await findPageTarget(`http://127.0.0.1:${port!}`);
    const cast = await Screencast.attach(target!.webSocketDebuggerUrl, { quality: 40, maxWidth: 480, maxHeight: 300 });
    try {
      /**
       * TWO IS THE WHOLE PROPERTY, and collecting three was the flake.
       *
       * Without the ack, Chromium sends frame 1, waits for an acknowledgement that never comes, and
       * sends nothing else — so `latest()` can only ever hold ONE. Two distinct frames is therefore
       * exact proof that the ack is being sent, and asking for three was asking for extra evidence
       * of a thing already established.
       *
       * It cost a red suite: run alone this passes in about a second, and run inside the full
       * two-thousand-test suite the browser is competing for a loaded machine and twenty seconds was
       * not always enough to collect a third. A test that is right about the code and wrong about
       * the clock is still a broken test.
       */
      const seen = new Set<string>();
      const deadline = Date.now() + 30_000;
      // The page carries a CSS animation (see MOVING_PAGE), so the compositor is busy and sampling
      // the buffer is enough to watch the frames advance.
      while (seen.size < 2 && Date.now() < deadline) {
        const f = cast.latest();
        if (f) seen.add(`${f.at}:${f.bytes.length}`);
        await new Promise((r) => setTimeout(r, 60));
      }
      assert.ok(seen.size >= 2, `only ${seen.size} distinct frame(s) — the ack is probably missing`);
    } finally {
      cast.stop();
    }
  } finally {
    await b.stop();
  }
});

test("this connection cannot drive the browser", async () => {
  // The safety property, and the reason it is an allowlist rather than a convention: this socket is
  // open on a browser holding a customer's logged-in session, and the only difference between
  // watching and driving is which method names can leave here.
  const cast = Object.create(Screencast.prototype) as Screencast & { send: (m: string) => void };
  for (const forbidden of [
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Page.navigate",
    "Runtime.evaluate",
    "Network.getAllCookies",
    "Storage.getCookies",
  ]) {
    assert.throws(() => cast.send(forbidden), /only watches/, forbidden);
  }
});
