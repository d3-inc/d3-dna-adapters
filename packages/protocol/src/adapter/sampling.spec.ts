import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawSampleRate } from './sampling';

const plain = (): Request => new Request('https://ai.d3.com/page');

function drawing(value: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drawSampleRate', () => {
  it('skips a plain request the draw misses', () => {
    drawing(0.5);
    expect(drawSampleRate(plain(), 0.25, false)).toBeNull();
  });

  it('reports the rate a plain request was drawn at', () => {
    drawing(0.1);
    expect(drawSampleRate(plain(), 0.25, false)).toBe(0.25);
  });

  it('skips at the boundary: a draw equal to the rate misses', () => {
    drawing(0.25);
    expect(drawSampleRate(plain(), 0.25, false)).toBeNull();
  });

  it('always sends a paying request, at rate 1', () => {
    drawing(0.99);
    expect(drawSampleRate(plain(), 0.01, true)).toBe(1);
  });

  it('always sends a signed request, at rate 1, whichever signature header it carries', () => {
    drawing(0.99);
    const signed = new Request('https://ai.d3.com/page', { headers: { signature: 'sig1=:abc:' } });
    const signedInput = new Request('https://ai.d3.com/page', { headers: { 'signature-input': 'sig1=()' } });
    expect(drawSampleRate(signed, 0.01, false)).toBe(1);
    expect(drawSampleRate(signedInput, 0.01, false)).toBe(1);
  });

  it('never skips at rate 1, whatever the draw', () => {
    drawing(0.999_999);
    expect(drawSampleRate(plain(), 1, false)).toBe(1);
  });
});
