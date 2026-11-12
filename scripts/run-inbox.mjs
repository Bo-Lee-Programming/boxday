// Process the demo inbox from the command line (mock PayPal unless --sandbox).
// Usage: node scripts/run-inbox.mjs [--heuristic]
if (!process.argv.includes('--sandbox')) process.env.PAYPAL_MODE = 'mock';
if (process.argv.includes('--heuristic')) process.env.LLM_PROVIDER = 'heuristic';
process.env.DATA_DIR ||= 'data/runtime-cli';

const { seed, db, save } = await import('../src/state.js');
const { FARM } = await import('../src/farm.js');
const { compilePolicy } = await import('../src/policy.js');
const { processMessage } = await import('../src/agent.js');

await seed();
const c = await compilePolicy(FARM.default_policy);
console.log('POLICY', c.ai.via, `${c.ai.ms}ms`, JSON.stringify({ ...c.policy, source_text: undefined }), c.fixes);
db.policy = { ...c.policy, confirmed_at: new Date().toISOString() };
save();

for (const msg of db.messages) {
  await processMessage(msg, (s) => {
    if (s.kind === 'understood') console.log(`\n[${msg.id}] ${msg.from}: ${msg.text}\n  AI ${s.ai.via} ${s.ai.ms}ms →`, JSON.stringify(s.requests), s.fixes.length ? `\n  fixes: ${s.fixes.join(' | ')}` : '');
    if (s.kind === 'action') console.log(`  ${s.action.type} → ${s.action.decision}/${s.action.status} ${s.action.money ? `${s.action.money.kind} $${s.action.money.amount}` : ''} | ${s.action.reasons.slice(0, 2).join(' ')} ${s.action.error || ''}`);
  });
}
console.log('\nSTOCK', JSON.stringify(db.stock));
console.log('REPLY msg09:\n' + db.messages.find((m) => m.id === 'msg09').reply);
