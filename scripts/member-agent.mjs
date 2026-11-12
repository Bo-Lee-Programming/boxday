// A stand-in for a member's own AI assistant talking to the farm's agent (agent-to-agent).
// It reads the farm's agent card, then sends a structured request with the member's key.
// Usage: node scripts/member-agent.mjs [memberId] [request JSON]
//   node scripts/member-agent.mjs mb16 '[{"type":"skip_week","week":"next"},{"type":"add_on","addon":"honey","quantity":1}]'
// (The key comes from the farm's local member page, i.e. GET /api/members/agent-key. In real
//  life the member copies it into their assistant once.)
const BASE = process.env.BASE || 'http://localhost:3040';
const member = process.argv[2] || 'mb16';
const requests = JSON.parse(process.argv[3] || '[{"type":"skip_week","week":"next"},{"type":"add_on","addon":"honey","quantity":1}]');

const card = await (await fetch(`${BASE}/.well-known/agent.json`)).json();
console.log(`Found agent: ${card.name}\nSkills: ${card.skills.map((s) => s.id).join(', ')}`);
const { member: name, key } = await (await fetch(`${BASE}/api/members/agent-key?member=${member}`)).json();
console.log(`Acting for ${name}\nSending: ${JSON.stringify(requests)}`);
const res = await fetch(card.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ agent: { name: `${name.split(' ')[0]}'s assistant` }, requests }),
});
const out = await res.json();
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(out, null, 2));
