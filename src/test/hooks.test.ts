import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const root = path.resolve(__dirname, '..', '..');

test('hooks parse and check the staged tree with the system Bash', () => {
  const bash = process.platform === 'win32' ? 'bash' : '/bin/bash';
  for (const name of ['pre-commit', 'commit-msg']) {
    execFileSync(bash, ['-n', path.join(root, 'bin/hooks', name)]);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalens-hook-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  const check = () => execFileSync(
    bash, [path.join(root, 'bin/hooks/pre-commit')],
    { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    const file = path.join(dir, 'sample.md');
    fs.writeFileSync(file, 'Clean staged text\n');
    git('add', 'sample.md');
    assert.doesNotThrow(check);
    fs.writeFileSync(file, '<'.repeat(7) + ' ours\n');
    assert.doesNotThrow(check, 'only staged content is checked');
    git('add', 'sample.md');
    assert.throws(check, /commit refused/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function commonHooksDir(): string | undefined {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, encoding: 'utf8',
    }).trim();
    return path.resolve(root, common, 'hooks');
  } catch {
    return undefined; // not a git checkout (a packaged copy, say)
  }
}

test('an installed hook is never a dangling symlink', () => {
  // #114. Both commit gates were silently inactive for fifteen commits
  // because the shared hooks directory held symlinks into a worktree that
  // had since been removed. A fresh clone has no hooks installed and must
  // pass; a clone whose hooks point at nothing must fail, because that is
  // a gate everyone believes is wired and that has stopped running.
  const dir = commonHooksDir();
  if (dir === undefined || !fs.existsSync(dir)) {
    return;
  }
  for (const name of ['commit-msg', 'pre-commit']) {
    const hook = path.join(dir, name);
    let link: string;
    try {
      link = fs.readlinkSync(hook);
    } catch {
      continue; // absent, or a plain file someone wrote by hand -- not ours
    }
    const target = path.resolve(dir, link);
    assert.ok(fs.existsSync(target),
      `${name} is a dangling symlink to ${target}; run bin/install-hooks.sh`);
  }
});

test('the installer resolves the hooks against the main worktree', () => {
  // The defect was in which copy of bin/hooks the links pointed at. Pin the
  // fix at the source rather than by running the installer, which would
  // rewrite the developer's real hooks from inside a test.
  const script = fs.readFileSync(
    path.join(root, 'bin', 'install-hooks.sh'), 'utf8');
  assert.match(script, /git worktree list --porcelain/);
  assert.match(script, /src="\$main\/bin\/hooks"/);
  assert.doesNotMatch(script, /src="\$root\/bin\/hooks"/);
});
