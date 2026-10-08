import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("provider startup failure keeps one failed capture entry per requested route", async () => {
  const output = mkdtempSync(join(tmpdir(), "qa-provider-test-"));
  try {
    const child = Bun.spawn([process.execPath, "scripts/qa/capture.ts"], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        BUILDD_BROWSER_PROVIDER: "none",
        QA_ROUTES: "/ready,/another",
        QA_NO_LOGIN: "1",
        QA_OUTPUT: output,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(1);
    const captures = JSON.parse(
      readFileSync(join(output, "captures.json"), "utf8"),
    );
    expect(captures.map((c: { path: string }) => c.path)).toEqual([
      "/ready",
      "/another",
    ]);
    for (const capture of captures) {
      expect(capture.providerError).toBe("provider_missing");
      expect(capture.screenshot).toBeUndefined();
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
