// Gathers what the reviewing agent reads: the pull request, the issue it claims to fix, and the diff.

import { spawnSync } from 'node:child_process';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, ...args) => {
  const r = sh('git', args, { cwd: repo });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const ghJson = (path) => {
  const r = sh('gh', ['api', path]);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};

export function mergeBaseOf(repo, base, head) {
  return git(repo, 'merge-base', base, head).trim();
}

/**
 * The diff, budgeted so a large PR still fits: source files in full (up to a per-file cap), snapshot files
 * collapsed to one example plus a count, and the rest listed by name when the budget runs out.
 * Every omission is stated in the text so the agent knows what it did not see.
 */
export function budgetedDiff(repo, mergeBase, head, adapter, { totalBudget = 180_000, perFile = 25_000 } = {}) {
  const names = git(repo, 'diff', '--name-only', '--no-renames', mergeBase, head).split('\n').filter(Boolean);
  const stat = git(repo, 'diff', '--stat=200', '--no-renames', mergeBase, head);
  const snapshots = names.filter((n) => adapter.isSnapshot(n));
  const regular = names.filter((n) => !adapter.isSnapshot(n));
  const order = [...regular.filter((n) => adapter.isSource(n)), ...regular.filter((n) => !adapter.isSource(n))];

  const parts = [`# Files changed\n\n${stat}`];
  let used = parts[0].length;
  const omitted = [];
  for (const n of order) {
    let d = git(repo, 'diff', '--no-renames', mergeBase, head, '--', n);
    if (d.length > perFile) d = d.slice(0, perFile) + `\n... [diff of ${n} cut at ${perFile} characters]\n`;
    if (used + d.length > totalBudget) {
      omitted.push(n);
      continue;
    }
    parts.push(d);
    used += d.length;
  }
  if (snapshots.length) {
    const sample = git(repo, 'diff', '--no-renames', mergeBase, head, '--', snapshots[0]).slice(0, 6000);
    parts.push(`# ${snapshots.length} expected-output snapshot files changed. One example of the ${snapshots.length}:\n${sample}`);
  }
  if (omitted.length) parts.push(`# Diffs not shown (budget): ${omitted.join(', ')}`);
  return parts.join('\n');
}

export function pullRequest(repoSlug, number) {
  const pr = ghJson(`repos/${repoSlug}/pulls/${number}`);
  if (!pr) throw new Error(`Cannot read pull request ${repoSlug}#${number}`);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    url: pr.html_url,
    // People a human put on the PR: candidates to own the decisions the review refuses to make.
    reviewers: (pr.requested_reviewers ?? []).map((u) => u.login),
    assignees: (pr.assignees ?? []).map((u) => u.login),
  };
}

/** The issue the PR names in its title or body ("#2234"), read from the adapter's issue repository. */
export function linkedIssue(pr, adapter) {
  const m = /#(\d{2,6})\b/.exec(`${pr.title}\n${pr.body}`);
  if (!m || !adapter.issueRepo) return null;
  const issue = ghJson(`repos/${adapter.issueRepo}/issues/${m[1]}`);
  if (!issue) return null;
  return { ref: `${adapter.issueRepo.split('/')[0]}#${m[1]}`, title: issue.title, body: (issue.body ?? '').slice(0, 20_000) };
}
