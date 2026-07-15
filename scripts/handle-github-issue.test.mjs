import assert from "node:assert/strict";
import test from "node:test";
import { classifyIssue } from "./handle-github-issue.mjs";

const issue = (labels = [], assignees = []) => ({
  labels: labels.map((name) => ({ name })),
  assignees,
});

test("routes unowned and unlabeled issues to analysis", () => {
  assert.equal(classifyIssue(issue()).script, "analyse-github-issues.mjs");
});

test("routes feedback and ready labels to their workflows", () => {
  assert.equal(
    classifyIssue(issue(["comments to be resolved"])).script,
    "update-github-issue-plans.mjs",
  );
  assert.equal(
    classifyIssue(issue(["ready to go"])).script,
    "implement-github-issues.mjs",
  );
});

test("does not route other assigned or labeled issues", () => {
  assert.equal(classifyIssue(issue([], [{ login: "owner" }])), null);
  assert.equal(classifyIssue(issue(["review needed"])), null);
});
