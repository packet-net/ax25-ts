/**
 * `sessionQuirkSpecIssues` against the quirk names: the TS leg of
 * packet.net's `Ax25SessionQuirks.SpecIssues` / `[Ax25SpecIssue]` check. A
 * quirk named `ax25Spec<N>...` works around packethacking/ax25spec issue N,
 * so the map must list it with that number, and must list nothing else.
 */
import { describe, expect, it } from "vitest";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  sessionQuirkSpecIssues,
} from "../src/sdl/session-quirks.js";

const specNamed = /^ax25Spec(\d+)[A-Z]/;

describe("sessionQuirkSpecIssues", () => {
  const quirkNames = Object.keys(defaultSessionQuirks) as (keyof Ax25SessionQuirks)[];

  it("lists every ax25Spec<N> quirk with issue N and a link to it", () => {
    const named = quirkNames.filter((name) => specNamed.test(name));
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      const n = Number(specNamed.exec(name)![1]);
      const entry = sessionQuirkSpecIssues[name];
      expect(entry, name).toBeDefined();
      expect(entry!.issue, name).toBe(n);
      expect(entry!.url.endsWith(`/issues/${n}`), `${name}: ${entry!.url}`).toBe(true);
    }
  });

  it("lists nothing that is not an ax25Spec<N> quirk", () => {
    for (const name of Object.keys(sessionQuirkSpecIssues)) {
      expect(quirkNames, name).toContain(name);
      expect(specNamed.test(name), name).toBe(true);
    }
  });

  it("points the crossed-dial quirks at their packet.net removal issues", () => {
    expect(sessionQuirkSpecIssues.ax25Spec114UnexpectedUaIgnored?.removalTrackedIn).toBe(880);
    expect(sessionQuirkSpecIssues.ax25Spec114RepeatedConnectUaIgnored?.removalTrackedIn).toBe(880);
    expect(sessionQuirkSpecIssues.ax25Spec50RepeatedConnectSabmReacknowledged?.removalTrackedIn).toBe(881);
  });
});
