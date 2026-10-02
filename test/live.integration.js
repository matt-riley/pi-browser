// Same end-to-end fixture as the browser test, but selections call real Jev.
// Opt-in only: costs API tokens and sends synthetic fixture data to TypeSafe.
if (!process.env.TYPESAFE_API_KEY) throw new Error('test:live requires TYPESAFE_API_KEY');
await import('./browser.integration.js');
