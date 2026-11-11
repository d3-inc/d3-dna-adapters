/**
 * What a build does with a request or with DNA's answer. A name's meaning is
 * frozen once a build's record lists it: add a name, never redefine one.
 */
export const ADAPTER_MECHANISMS = [
  'credentials',
  'namespace',
  'forward-all',
  'answer',
  'decorate',
  'bare-pass',
  'rewrite-body',
] as const;

export type AdapterMechanism = (typeof ADAPTER_MECHANISMS)[number];

export function isAdapterMechanism(name: string): name is AdapterMechanism {
  return (ADAPTER_MECHANISMS as readonly string[]).includes(name);
}
