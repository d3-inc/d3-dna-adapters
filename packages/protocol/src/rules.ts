export const ACCESS_RULE_ACTIONS = ['allow', 'block', 'verify', 'charge', 'charge-or-verify'] as const;

export type AccessRuleAction = (typeof ACCESS_RULE_ACTIONS)[number];

/** The actions that answer an unpaid visitor with a 402 or a sign-in instead of the page. */
export type GateAction = Extract<AccessRuleAction, 'verify' | 'charge' | 'charge-or-verify'>;

/** What the request record's `policy_action` holds. */
export type AppliedAction = 'pass' | AccessRuleAction;
