const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function getJobBlock(jobName) {
  const lines = workflow.split('\n');
  const startIndex = lines.findIndex(line => line === `  ${jobName}:`);

  if (startIndex === -1) {
    throw new Error(`Missing workflow job: ${jobName}`);
  }

  const nextJobOffset = lines
    .slice(startIndex + 1)
    .findIndex(line => /^  [A-Za-z0-9_-]+:$/.test(line));
  const endIndex = nextJobOffset === -1
    ? lines.length
    : startIndex + 1 + nextJobOffset;

  return lines.slice(startIndex, endIndex).join('\n');
}

describe('Release workflow publication policy', () => {
  const publishJob = getJobBlock('publish-release');

  test('targets GitHub explicitly without a repository checkout', () => {
    const releaseCommands = publishJob.match(/\bgh release\b/g) || [];

    expect(releaseCommands.length).toBeGreaterThan(0);
    expect(publishJob).toMatch(
      /^    env:\n      GH_REPO: \$\{\{ github\.repository \}\}$/m
    );
    expect(publishJob.match(/\bGH_REPO:/g)).toHaveLength(1);
    expect(publishJob).not.toContain('actions/checkout@');
    expect(publishJob).not.toMatch(/\bgit (?:remote|rev-parse)\b/);
  });

  test('retains tag-only publication and minimal write permission', () => {
    expect(publishJob).toContain(
      "if: ${{ github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref_name, 'v') }}"
    );
    expect(publishJob).toMatch(
      /^    permissions:\n      contents: write$/m
    );
  });
});
