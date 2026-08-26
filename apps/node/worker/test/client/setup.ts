import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount whatever the last test mounted.
 *
 * Testing Library does this automatically when a global `afterEach` is available, and this file is here to
 * not depend on that: a component left mounted keeps its effects and its timers, and a timer surviving
 * into the next test would surface as a flake in whichever test ran next rather than as a failure in the
 * one that leaked it. This suite is about effect lifetimes, so leaking one is the least acceptable
 * possible bug in its own harness.
 */
afterEach(cleanup);
