import { describe, expect, it } from "vitest";
import { InvalidTransition, isTerminal, transition } from "./machine.js";
import { isValidCode, newRoomCode } from "./codes.js";

describe("room state machine", () => {
  it("follows the happy path lobby → playing → paused → playing → ended", () => {
    let s = transition("lobby", "START");
    expect(s).toBe("playing");
    s = transition(s, "PAUSE");
    expect(s).toBe("paused");
    s = transition(s, "START");
    expect(s).toBe("playing");
    s = transition(s, "END");
    expect(s).toBe("ended");
    expect(isTerminal(s)).toBe(true);
  });

  it("host disconnect pauses a playing room but leaves lobby alone", () => {
    expect(transition("playing", "HOST_DISCONNECT")).toBe("paused");
    expect(transition("lobby", "HOST_DISCONNECT")).toBe("lobby");
    expect(transition("paused", "HOST_DISCONNECT")).toBe("paused");
  });

  it("host reconnect never auto-resumes playback", () => {
    // The speaker coming back online must not blast music by itself.
    expect(transition("paused", "HOST_RECONNECT")).toBe("paused");
    expect(transition("lobby", "HOST_RECONNECT")).toBe("lobby");
  });

  it("full disconnect/reconnect cycle keeps the party recoverable", () => {
    let s = transition("lobby", "START"); // playing
    s = transition(s, "HOST_DISCONNECT"); // paused (hoparlör koptu)
    s = transition(s, "HOST_RECONNECT"); // still paused
    s = transition(s, "START"); // host presses play
    expect(s).toBe("playing");
  });

  it("ended is terminal — every other event throws", () => {
    for (const ev of ["START", "PAUSE", "HOST_DISCONNECT", "HOST_RECONNECT"] as const) {
      expect(() => transition("ended", ev)).toThrow(InvalidTransition);
    }
    expect(transition("ended", "END")).toBe("ended"); // idempotent close
  });

  it("play/pause are idempotent (double-tap safe)", () => {
    expect(transition("playing", "START")).toBe("playing");
    expect(transition("paused", "PAUSE")).toBe("paused");
  });
});

describe("room codes", () => {
  it("generates 4 letters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = newRoomCode();
      expect(code).toHaveLength(4);
      expect(isValidCode(code)).toBe(true);
      // The confusable characters must never appear.
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it("validates user input case-insensitively", () => {
    expect(isValidCode("abcd")).toBe(true);
    expect(isValidCode("AB")).toBe(false);
    expect(isValidCode("AB0D")).toBe(false);
    expect(isValidCode("ABIL")).toBe(false);
  });
});
