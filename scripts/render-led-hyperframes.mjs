import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectDir = path.resolve(process.cwd(), 'tools/led-hyperframes');
const outMp4 = path.join(projectDir, 'ubc-sign-214x112.mp4');
const outAvi = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.USERPROFILE || process.cwd(), 'Downloads', 'ubc-hyperframes-214x112.avi');

console.log('1/3 Validating HyperFrames composition...');
execFileSync('npx', ['--yes', 'hyperframes', 'check', projectDir], { stdio: 'inherit', shell: true });

console.log('2/3 Rendering 214x112 MP4 via HyperFrames...');
if (fs.existsSync(outMp4)) fs.unlinkSync(outMp4);
execFileSync('npx', ['--yes', 'hyperframes', 'render', projectDir, '--output', outMp4], { stdio: 'inherit', shell: true });

console.log('3/3 Converting to 214x112 MJPEG .AVI (audio-free) via FFmpeg...');
execFileSync('ffmpeg', [
  '-y',
  '-i', outMp4,
  '-vf', 'scale=214:112:flags=lanczos',
  '-r', '15',
  '-c:v', 'mjpeg',
  '-q:v', '2',
  '-an',
  outAvi,
], { stdio: 'inherit' });

const stats = fs.statSync(outAvi);
console.log(`Done! Saved ${(stats.size / 1024).toFixed(1)} KB -> ${outAvi}`);
