jest.mock("child_process");

import { exec } from "child_process";
import { cli } from "../src";

describe("deployer CLI", () => {
  const spy: jest.Mock<Promise<{ stdout: string; stderr: string }>, string[]> = exec as any;

  beforeEach(() => {
    spy.mockClear();
  });

  describe("deployer apps", () => {
    it("lists apps", async () => {
      const log = jest.spyOn(console, "log");
      await cli(["apps"]);
    });
  });
});
