// Verifies PayPal sandbox credentials from .env without any buyer interaction:
// OAuth, Agent Toolkit create_order + get_order, Agent Toolkit create_invoice (draft),
// and a Vault v3 setup token. No money moves.
// Usage: node scripts/check-sandbox.mjs
process.env.PAYPAL_MODE = 'sandbox';
const { config } = await import('../src/config.js');
if (config.paypalMode !== 'sandbox') {
  console.error('No PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env. See .env.example.');
  process.exit(1);
}
const { paypal, toolkitOrderArgs, invoiceArgs, linkOf } = await import('../src/paypal.js');

const step = async (label, fn) => {
  try { const r = await fn(); console.log(`OK   ${label}`, r ?? ''); return r; } catch (e) { console.log(`FAIL ${label}: ${e.message}`); return null; }
};
const intent = { merchant: { id: 'farm', name: 'Little Bluestem Farm' }, items: [{ name: 'Eggs (dozen)', unit_price: 7, quantity: 2 }] };

const order = await step('Agent Toolkit create_order', async () => {
  const o = await paypal.callTool('create_order', toolkitOrderArgs(intent, { returnUrl: `${config.publicUrl}/paypal/return`, cancelUrl: `${config.publicUrl}/paypal/cancel`, note: 'sandbox check' }));
  return { id: o.id, status: o.status, pay: linkOf(o, 'payer-action', 'approve') };
});
if (order) await step('Agent Toolkit get_order', async () => (await paypal.callTool('get_order', { id: order.id })).status);
await step('Agent Toolkit create_invoice (draft, not sent)', async () => {
  const inv = await paypal.callTool('create_invoice', invoiceArgs({ farmName: 'Little Bluestem Farm', email: 'new.member@example.com', name: 'New Member', lines: [{ name: 'Standard share, weeks 14-20', unit_price: 36, quantity: 7 }], note: 'sandbox check', reference: 'check' }));
  return inv.id || inv.href || JSON.stringify(inv).slice(0, 120);
});
await step('Vault v3 setup token (save a buyer wallet)', async () => paypal.createWalletSetup({ description: 'Boxday sandbox check', returnUrl: `${config.publicUrl}/x`, cancelUrl: `${config.publicUrl}/y` }));
