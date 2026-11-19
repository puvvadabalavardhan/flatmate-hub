export function initializeApp(cfg){ if(!cfg||!cfg.apiKey) throw new Error('bad config'); return {cfg}; }
