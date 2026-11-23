import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Usage: npm run led:render [-- <project-folder> <output.avi>]
// Default project: tools/led-pro (HyperFrames catalog blocks, 214x112)
const projectDir = path.resolve(process.cwd(), process.argv[2] || 'tools/led-pro');
const outMp4 = path.join(projectDir, 'render-214x112.mp4');
const outAvi = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(process.env.USERPROFILE || process.cwd(), 'Downloads', 'ubc-led-' + path.basename(projectDir) + '-214x112.avi');

const npx = (args) => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'hyperframes', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });

console.log('1/3 Validating HyperFrames composition...');
npx(['lint', projectDir]);

console.log('2/3 Rendering via HyperFrames...');
if (fs.existsSync(outMp4)) fs.unlinkSync(outMp4);
npx(['render', projectDir, '--output', outMp4]);

console.log('3/3 Converting to 214x112 MJPEG .AVI (audio-free)...');
execFileSync('ffmpeg', [
  '-y', '-i', outMp4,
  '-vf', 'scale=214:112:flags=lanczos',
  '-r', '15', '-c:v', 'mjpeg', '-q:v', '2', '-an',
  outAvi,
], { stdio: 'inherit' });

console.log(`Done! ${(fs.statSync(outAvi).size / 1024).toFixed(1)} KB -> ${outAvi}`);
