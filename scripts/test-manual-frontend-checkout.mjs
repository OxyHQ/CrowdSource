import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseDocument } from 'yaml';

const workflow = parseDocument(
  readFileSync('.github/workflows/deploy-frontends.yml', 'utf8'),
).toJS();
const expectedCheckouts = process.cwd().includes('/Mention/') ? 3 : 5;
function validate(value) {
  let count = 0;
  for (const job of Object.values(value.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('actions/checkout@')) continue;
      // Every checkout is the commit CI tested (DEPLOY_SHA), never the event's
      // `github.sha`, which is main's head when CI finished and may be a commit
      // CI never ran on (an auto-merge push starts no workflow).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
      assert.equal(step.with.ref, '${{ env.DEPLOY_SHA }}');
      assert.equal(step.if, undefined);
      count++;
    }
  }
  assert.equal(count, expectedCheckouts);
  const sha = 'a'.repeat(40);
  const github = {
    event_name: 'workflow_run',
    ref: 'refs/heads/main',
    sha,
    repository: 'OxyHQ/fixture',
    event: {
      workflow_run: {
        head_sha: sha,
        conclusion: 'success',
        event: 'push',
        head_repository: { full_name: 'OxyHQ/fixture' },
        head_branch: 'main',
      },
    },
  };
  function admits(context, hold = 'false') {
    return runInNewContext(
      value.jobs.scope.if,
      { github: context, vars: { OXY_1519_ROLLOUT_HOLD: hold } },
      { timeout: 100 },
    );
  }
  assert.equal(admits(github), true);
  assert.equal(admits(github, 'true'), false);
  // main moved on past the tested commit: admitted here, and the scope job's
  // `require-current-main.sh --decide` step decides whether it still releases.
  assert.equal(
    admits({
      ...github,
      event: { workflow_run: { ...github.event.workflow_run, head_sha: 'b'.repeat(40) } },
    }),
    true,
  );
  const gate = value.jobs.scope.steps.find((step) => step.id === 'gate');
  assert.match(gate?.run ?? '', /require-current-main\.sh --decide/);
  for (const id of ['reviewer', 'console'])
    assert.equal(
      value.jobs.scope.steps.find((step) => step.id === id)?.if,
      "steps.gate.outputs.current == 'true'",
    );
  for (const change of [
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { head_repository: { full_name: 'other/repo' } },
    { head_branch: 'feature' },
  ])
    assert.equal(
      admits({ ...github, event: { workflow_run: { ...github.event.workflow_run, ...change } } }),
      false,
    );
  assert.equal(admits({ ...github, event_name: 'workflow_dispatch' }), true);
  assert.equal(
    admits({ ...github, event_name: 'workflow_dispatch', ref: 'refs/heads/feature' }),
    false,
  );
  if (value.on.push) assert.equal(admits({ ...github, event_name: 'push' }), true);
}
validate(workflow);
const ungated = structuredClone(workflow);
delete ungated.jobs.scope.steps.find((step) => step.id === 'reviewer').if;
assert.throws(() => validate(ungated));
const checkout = structuredClone(workflow);
Object.values(checkout.jobs)
  .find((job) => job.steps?.some((step) => step.uses?.startsWith('actions/checkout@')))
  .steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
  '${{ github.sha }}';
assert.throws(() => validate(checkout));
console.log(
  `${expectedCheckouts} CI-tested-SHA checkouts; current/moved-on/manual/hold/foreign/failed CI controls, the gate and two mutations PASS`,
);
