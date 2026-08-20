import 'dotenv/config';

import { getSupabaseAdmin } from '../src/lib/supabase.js';

/**
 * Put a few letters in the daily queue so the review screen can be LOOKED AT.
 *
 * Local visual check only. The real job produces nothing today because
 * services/leadSource.js returns [] — Stage B is blocked on a licence — so
 * without this the queue only ever renders its empty state.
 *
 *   node scripts/seed-queue.mjs <your-account-email>
 *   node scripts/seed-queue.mjs <your-account-email> --clean
 *
 * These are fake prospects at example.org. Nothing here is sendable without the
 * per-lead approval gate, and --clean removes every row it made.
 */

const email = process.argv[2];
const clean = process.argv.includes('--clean');

if (!email) {
  console.error('usage: node scripts/seed-queue.mjs <your-account-email> [--clean]');
  process.exit(1);
}

const db = getSupabaseAdmin();

const { data: profile } = await db
  .from('profiles')
  .select('id, email')
  .eq('email', email)
  .maybeSingle();

if (!profile) {
  console.error(`No account for ${email}. Sign up in the app first, then re-run.`);
  process.exit(1);
}

const { data: campaign } = await db
  .from('campaigns')
  .select('id')
  .eq('user_id', profile.id)
  .eq('name', 'Daily')
  .maybeSingle();

if (clean) {
  if (campaign) {
    await db.from('leads').delete().eq('campaign_id', campaign.id);
    await db.from('campaigns').delete().eq('id', campaign.id);
  }
  await db.from('daily_runs').delete().eq('user_id', profile.id);
  console.log('Seeded rows removed. The queue is empty again.');
  process.exit(0);
}

let campaignId = campaign?.id;

if (!campaignId) {
  const { data: made, error } = await db
    .from('campaigns')
    .insert({
      user_id: profile.id,
      name: 'Daily',
      mode: 'voice',
      brief: 'Classroom software for K-12 districts.',
      status: 'sending'
    })
    .select('id')
    .single();

  if (error) {
    console.error('Could not create the Daily campaign:', error.message);
    process.exit(1);
  }
  campaignId = made.id;
}

const LETTERS = [
  {
    email: 'dana.reyes@example.org',
    first_name: 'Dana',
    last_name: 'Reyes',
    company: 'Riverbend Unified',
    title: 'Director of Technology',
    fidelity_score: 91,
    generated_subject: 'twelve schools, one rollout',
    generated_body:
      'Dana,\n\nSaw Riverbend put Chromebooks in all twelve schools last September. That is a lot of ' +
      'devices to keep track of in one go.\n\nWe built something that handles the bit after the ' +
      'rollout, the part nobody budgets for. Worth 15 minutes next week?\n\nUnique'
  },
  {
    email: 'marcus.hale@example.org',
    first_name: 'Marcus',
    last_name: 'Hale',
    company: 'Cedar Park ISD',
    title: 'Head of IT',
    fidelity_score: 84,
    generated_subject: 'the Cedar Park 1:1 program',
    generated_body:
      'Marcus,\n\nRead that Cedar Park is expanding the 1:1 program to middle school this year. ' +
      'The jump from pilot to district-wide is where most of these come unstuck.\n\nHappy to share ' +
      'what we have seen work, no pitch. Free Thursday?\n\nUnique'
  }
];

const rows = LETTERS.map((letter) => ({
  ...letter,
  user_id: profile.id,
  campaign_id: campaignId,
  status: 'generated',
  research_json: { hooks: ['Rolled out 1:1 devices across the district last September.'] }
}));

const { error: insertError } = await db.from('leads').insert(rows);

if (insertError) {
  console.error('Could not seed the leads:', insertError.message);
  process.exit(1);
}

console.log(`Seeded ${rows.length} letters into the Daily queue for ${profile.email}.`);
console.log('Open http://localhost:5173/queue');
console.log('Undo with: node scripts/seed-queue.mjs ' + email + ' --clean');
