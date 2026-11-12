const CONFIG = {
  // Your org's API key (dashboard → API keys). The only setting DNA needs.
  apiKey: 'd3_k_REPLACE_ME',
  // false turns DNA off without removing the key: pure passthrough.
  enabled: true,
  // Hard budget for the decision call, in milliseconds.
  timeoutMs: 150,
  // Budget for a request presenting a payment: settlement happens inside the call.
  paymentTimeoutMs: 10000,
  // 'open' passes traffic when the decision call fails; 'closed' blocks instead.
  // A request presenting a payment never falls open, whatever this says.
  failMode: 'open',
  // Fraction of requests that get a decision call. Unsampled requests return
  // untouched — no call, no x-d3-edge header. A payment is never sampled out.
  sampleRate: 1,
  // Call on every request carrying signature headers, whatever sampleRate says.
  alwaysSampleSigned: false,
  // Names DNA is never sent, comma-separated — your session cookie, an internal
  // API key. DNA reads a name you list as kept back rather than absent, so an
  // access rule that checks one is skipped instead of matching on nothing.
  excludeHeaders: '',
  excludeCookies: '',
};
