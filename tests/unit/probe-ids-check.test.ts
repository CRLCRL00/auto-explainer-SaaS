import { describe, it, expect } from 'vitest';

describe('placeholder id check', () => {
  it('returns missing ids for {{{...}}} unresolved placeholders', () => {
    const html = `<html><body>{{BEAT_0_TITLE}}<div id="b1">{{BEAT_0_TEXT}}</div></body></html>`;
    const re = /\{\{([A-Z_0-9]+)\}\}/g;
    const missing: string[] = [];
    let m;
    while ((m = re.exec(html)) !== null) missing.push(m[1]);
    expect(missing).toEqual(['BEAT_0_TITLE', 'BEAT_0_TEXT']);
  });
});
