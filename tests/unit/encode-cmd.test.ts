import { describe, it, expect } from 'vitest';
import { buildEncodeArgs } from '@/worker/phases/encode';

describe('buildEncodeArgs (P0 全量: deprecated; Creatomate cut-over replaces FFmpeg)', () => {
  it('returns empty array — kept only as import-bleed guard', () => {
    const args = buildEncodeArgs({
      inputFps: 18.3,
      framesPattern: '/tmp/job-x/frames/f_%05d.png',
      outputPath: '/tmp/job-x/video.mp4',
    });
    expect(args).toEqual([]);
  });
});