import { expect, test } from "bun:test";
import { firstLoadOutcome } from "../ui/src/chat-load";

test("stale initial load success cannot suppress the current request failure", () => {
  const current = 2;
  let firstLoad = true;

  const olderSuccess = firstLoadOutcome(1, current, firstLoad, false);
  if (olderSuccess === "loaded") firstLoad = false;
  const currentFailure = firstLoadOutcome(2, current, firstLoad, true);

  expect(olderSuccess).toBe("stale");
  expect(firstLoad).toBe(true);
  expect(currentFailure).toBe("failed");
});
