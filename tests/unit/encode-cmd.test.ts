import { describe, it, expect } from 'vitest';
import { buildEncodeArgs } from '@/worker/phases/encode';

describe('buildEncodeArgs', () => {
  it('produces args for input fps + output 30fps', () => {
    const args = buildEncodeArgs({
      inputFps: 18.3,
      framesPattern: '/tmp/job-x/frames/f_%05d.png',
      outputPath: '/tmp/job-x/video.mp4',
    });
    expect(args).toContain('-framerate');
    expect(args).toContain('18.3');
    expect(args).toContain('-vf');
    expect(args).toContain('fps=30');
    expect(args).toContain('/tmp/job-x/video.mp4');
  });
});