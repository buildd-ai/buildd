import { existsSync, readFileSync } from "node:fs";

const p = `${process.env.CANDIDATE_DIR}/answer.json`;
if (!existsSync(p)) {
  console.error("no answer.json");
  process.exit(1);
}
let a: any;
try {
  a = JSON.parse(readFileSync(p, "utf8"));
} catch {
  console.error("answer.json is not valid JSON");
  process.exit(1);
}
const text: string = typeof a.answer === "string" ? a.answer.toLowerCase().replace(/\s+/g, " ").trim() : "";
const nums = new Set<string>(text.match(/\d+(?:\.\d+)?/g) ?? []);
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

// 5 billed seats x 12 x 12 = 720, less 15% = 612, plus the current onboarding fee 200 = 812.
if (a.abstain === true || !text) fail("wrong_abstention: the notes settle this");
if (!nums.has("812") && !nums.has("812.00")) fail("answer does not give 812");
if (nums.has("762") || nums.has("567.2") || nums.has("567.20") || nums.has("920")) fail("followed a superseded figure or ignored the seat minimum");
console.log("ok");
