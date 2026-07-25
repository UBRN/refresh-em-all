const { createHarness } = require('./harness');
const { PROFILES, runReliabilityScenario } = require('./reliability-scenario');

function selectedProfile() {
  const profileArgument = process.argv.find(argument => argument.startsWith('--profile='));
  return profileArgument ? profileArgument.split('=')[1] : 'full';
}

async function run() {
  const profile = selectedProfile();
  if (!PROFILES[profile]) {
    throw new Error(`Unknown reliability profile "${profile}". Use smoke, medium, or full.`);
  }

  const harness = await createHarness({ profile, trace: profile === 'full' });
  await runReliabilityScenario(harness, profile, { closeHarness: true });
}

run().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
