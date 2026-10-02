#!/usr/bin/env bun

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const BASELINE_FILE = "scripts/.design-drift-baseline.json";

interface BaselineData {
  timestamp: string;
  counts: {
    arbitraryFontSizes: number;
    rawHexColors: number;
    roundedFull: number;
    handRolledSheets: number;
    localStatusBadges: number;
  };
}

// Load baseline
function loadBaseline(): BaselineData | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// Save baseline
function saveBaseline(data: BaselineData) {
  writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
}

// Scan for arbitrary font sizes: text-[<n>px]
function checkArbitraryFontSizes(): { count: number; violations: string[] } {
  try {
    const result = execSync(
      `find apps/web/src -type f \\( -name "*.tsx" -o -name "*.ts" \\) ! -path "*/components/ui/**" ! -name "FlightStrip.tsx" -exec grep -l 'text-\\[[0-9.]\\+px\\]' {} \\;`,
      { encoding: "utf-8" }
    );
    const files = result.trim().split("\n").filter(Boolean);
    const violations: string[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          const matches = line.match(/text-\[([0-9.]+)px\]/g);
          if (matches) {
            matches.forEach((match) => {
              violations.push(
                `${file}:${idx + 1}: Found ${match}, use a token from docs/design/design-system.md §3 (text-chip, text-eyebrow, text-meta, text-body, text-title, text-lede, text-heading, text-display)`
              );
            });
          }
        });
      } catch {
        // file read error
      }
    }

    return { count: violations.length, violations };
  } catch {
    return { count: 0, violations: [] };
  }
}

// Scan for raw hex colors in className/style
function checkRawHexColors(): { count: number; violations: string[] } {
  try {
    const result = execSync(
      `find apps/web/src -type f \\( -name "*.tsx" -o -name "*.ts" \\) ! -path "*/components/ui/**" ! -name "FlightStrip.tsx" -exec grep -n "#[0-9A-Fa-f]\\{6\\}\\|#[0-9A-Fa-f]\\{3\\}" {} + | grep -v "node_modules" | grep -E "(className|style|bg-|text-|border-|fill-|stroke-|ring-)" || true`,
      { encoding: "utf-8" }
    );

    const lines = result
      .trim()
      .split("\n")
      .filter(Boolean);
    const violations: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      // Parse grep output: filename:line:content
      const match = line.match(/^([^:]+):(\d+):(.*)/);
      if (match) {
        const [, filename, lineNum, content] = match;

        // Filter out URLs, comments, and other non-styling contexts
        if (
          content.includes("http") ||
          content.includes("//") ||
          content.includes("/*") ||
          !content.match(
            /(className|style|bg-|text-|border-|fill-|stroke-|ring-)/
          )
        ) {
          continue;
        }

        // Extract hex color
        const hexMatch = content.match(
          /#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}(?![0-9A-Fa-f])/
        );
        if (hexMatch && !seen.has(`${filename}:${lineNum}:${hexMatch[0]}`)) {
          seen.add(`${filename}:${lineNum}:${hexMatch[0]}`);
          violations.push(
            `${filename}:${lineNum}: Found raw hex color ${hexMatch[0]}, use design tokens from docs/design/design-system.md §2`
          );
        }
      }
    }

    return { count: violations.length, violations };
  } catch {
    return { count: 0, violations: [] };
  }
}

// Scan for rounded-full
function checkRoundedFull(): { count: number; violations: string[] } {
  try {
    const result = execSync(
      `find apps/web/src -type f \\( -name "*.tsx" -o -name "*.ts" \\) ! -path "*/components/ui/**" ! -name "FlightStrip.tsx" -exec grep -n "rounded-full" {} +`,
      { encoding: "utf-8" }
    );

    const lines = result
      .trim()
      .split("\n")
      .filter(Boolean);
    const violations: string[] = [];

    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        const [, filename, lineNum] = match;
        violations.push(
          `${filename}:${lineNum}: Found 'rounded-full', corners are square per design-system.md §2.7. For circular elements, use 'rounded-[50%]' or width=height with overflow hidden.`
        );
      }
    }

    return { count: violations.length, violations };
  } catch {
    return { count: 0, violations: [] };
  }
}

// Scan for hand-rolled sheets: fixed inset-0 patterns
function checkHandRolledSheets(): { count: number; violations: string[] } {
  try {
    const result = execSync(
      `find apps/web/src -type f \\( -name "*.tsx" -o -name "*.ts" \\) ! -path "*/components/ui/**" ! -path "*/components/BottomSheet.tsx" ! -path "*/components/SideSheet.tsx" -exec grep -n "fixed inset-0" {} +`,
      { encoding: "utf-8" }
    );

    const lines = result
      .trim()
      .split("\n")
      .filter(Boolean);
    const violations: string[] = [];

    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        const [, filename, lineNum] = match;
        violations.push(
          `${filename}:${lineNum}: Found 'fixed inset-0' sheet pattern, use Sheet or BottomSheet from components/ui/ per design-system.md §4`
        );
      }
    }

    return { count: violations.length, violations };
  } catch {
    return { count: 0, violations: [] };
  }
}

// Scan for local StatusBadge functions
function checkLocalStatusBadges(): { count: number; violations: string[] } {
  try {
    const result = execSync(
      `find apps/web/src -type f \\( -name "*.tsx" \\) ! -path "*/components/StatusBadge.tsx" -exec grep -l "function StatusBadge\\|const StatusBadge.*=.*(" {} +`,
      { encoding: "utf-8" }
    );

    const files = result.trim().split("\n").filter(Boolean);
    const violations: string[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (
            /function StatusBadge|const StatusBadge\s*=\s*\(/.test(line)
          ) {
            violations.push(
              `${file}:${idx + 1}: Found local StatusBadge definition, consolidate on components/StatusBadge.tsx or use Chip from components/ui/ per design-system.md §4`
            );
          }
        });
      } catch {
        // file read error
      }
    }

    return { count: violations.length, violations };
  } catch {
    return { count: 0, violations: [] };
  }
}

async function main() {
  console.log("🎨 Design Drift Check\n");

  const arbitraryFontSizes = checkArbitraryFontSizes();
  const rawHexColors = checkRawHexColors();
  const roundedFull = checkRoundedFull();
  const handRolledSheets = checkHandRolledSheets();
  const localStatusBadges = checkLocalStatusBadges();

  const currentCounts = {
    arbitraryFontSizes: arbitraryFontSizes.count,
    rawHexColors: rawHexColors.count,
    roundedFull: roundedFull.count,
    handRolledSheets: handRolledSheets.count,
    localStatusBadges: localStatusBadges.count,
  };

  const baseline = loadBaseline();

  if (!baseline) {
    console.log("📋 Establishing baseline (no prior baseline found):");
    console.log(`   Arbitrary font sizes:  ${currentCounts.arbitraryFontSizes}`);
    console.log(`   Raw hex colors:        ${currentCounts.rawHexColors}`);
    console.log(`   rounded-full usage:    ${currentCounts.roundedFull}`);
    console.log(`   Hand-rolled sheets:    ${currentCounts.handRolledSheets}`);
    console.log(`   Local StatusBadges:    ${currentCounts.localStatusBadges}`);

    saveBaseline({
      timestamp: new Date().toISOString(),
      counts: currentCounts,
    });

    console.log("\n✅ Baseline saved to", BASELINE_FILE);
    process.exit(0);
  }

  console.log("📊 Design Drift Report:");
  console.log("   Rule                     | Current | Baseline | Status");
  console.log("   ----                     | ------- | -------- | ------");

  let violations: string[] = [];
  let failed = false;

  const checks = [
    { name: "Arbitrary font sizes", current: currentCounts.arbitraryFontSizes, baseline: baseline.counts.arbitraryFontSizes, violations: arbitraryFontSizes.violations },
    { name: "Raw hex colors", current: currentCounts.rawHexColors, baseline: baseline.counts.rawHexColors, violations: rawHexColors.violations },
    { name: "rounded-full usage", current: currentCounts.roundedFull, baseline: baseline.counts.roundedFull, violations: roundedFull.violations },
    { name: "Hand-rolled sheets", current: currentCounts.handRolledSheets, baseline: baseline.counts.handRolledSheets, violations: handRolledSheets.violations },
    { name: "Local StatusBadges", current: currentCounts.localStatusBadges, baseline: baseline.counts.localStatusBadges, violations: localStatusBadges.violations },
  ];

  for (const check of checks) {
    const status =
      check.current > check.baseline
        ? "❌ DRIFT"
        : check.current < check.baseline
          ? "✅ IMPROVED"
          : "🟢 OK";

    console.log(
      `   ${check.name.padEnd(24)} | ${String(check.current).padEnd(7)} | ${String(check.baseline).padEnd(8)} | ${status}`
    );

    if (check.current > check.baseline) {
      failed = true;
      violations.push(
        `\n❌ ${check.name} increased from ${check.baseline} to ${check.current}:`
      );
      violations.push(...check.violations.slice(0, 5)); // Show first 5
      if (check.violations.length > 5) {
        violations.push(
          `   ... and ${check.violations.length - 5} more violations`
        );
      }
    }
  }

  if (violations.length > 0) {
    console.log("\n" + violations.join("\n"));
  }

  if (failed) {
    console.log("\n❌ Design drift detected. Please reduce violations to the baseline.");
    process.exit(1);
  }

  console.log("\n✅ Design drift check passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(2);
});
