const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { GitSafetyManager, runGit } = require("../src/platform/gitSafety");

function initRepo(root) {
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "git-safety-test"]);
  runGit(root, ["config", "user.email", "git-safety@example.com"]);
}

test("GitSafetyManager stages only explicit allowlisted paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-safety-"));
  const skillsDir = path.join(root, "skills");
  const srcDir = path.join(root, "src");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "tool.py"), "print('ok')\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "app.js"), "console.log('baseline');\n", "utf8");
  initRepo(root);
  runGit(root, ["add", "--", "skills/tool.py", "src/app.js"]);
  runGit(root, ["commit", "-m", "baseline"]);

  fs.writeFileSync(path.join(skillsDir, "tool.py"), "print('updated')\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "app.js"), "console.log('changed but must not sync');\n", "utf8");

  const manager = new GitSafetyManager({
    cwd: root
  });
  const snapshot = manager.createSnapshot("trace-git", "skills-update", [
    path.join(skillsDir, "tool.py"),
    path.join(srcDir, "app.js")
  ]);

  assert.deepEqual(snapshot.staged_paths, ["skills/tool.py"]);
  const committedSkills = runGit(root, ["show", "HEAD:skills/tool.py"]);
  const committedSrc = runGit(root, ["show", "HEAD:src/app.js"]);
  assert.equal(committedSkills.output.includes("updated"), true);
  assert.equal(committedSrc.output.includes("must not sync"), false);
});

test("GitSafetyManager blocks sensitive keywords before commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-safety-sensitive-"));
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "tool.py"), "print('ok')\n", "utf8");
  initRepo(root);
  runGit(root, ["add", "--", "skills/tool.py"]);
  runGit(root, ["commit", "-m", "baseline"]);

  fs.writeFileSync(path.join(skillsDir, "tool.py"), "API_TOKEN = 'sk-live-secret'\n", "utf8");
  const alerts = [];
  const manager = new GitSafetyManager({
    cwd: root,
    alertHandler(payload) {
      alerts.push(payload);
    }
  });

  assert.throws(() => manager.createSnapshot("trace-git", "blocked", [
    path.join(skillsDir, "tool.py")
  ]), /SENSITIVE_SYNC_BLOCKED/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].findings[0].pattern_id, "API_KEY_PREFIX");
});
