'use strict';
// A stand-in microphone for the speech tests: writes 16-bit mono PCM at 16 kHz to stdout in real time, 50 ms at a time.
// argv[2]: the pattern, e.g. "q600,t1200,q4000" (quiet / tone, in ms), repeated; argv[3] = "die": exits at once with an error.
if (process.argv[3] === 'die') { process.stderr.write('No microphone here.'); process.exit(3); }
const steps = String(process.argv[2] || 'q600,t1200,q4000').split(',').map(s => ({ tone: s[0] === 't', ms: Number(s.slice(1)) }));
const RATE = 16000, FRAME = 800;
let step = 0, left = steps[0].ms, n = 0;
setInterval(() => {
  const b = Buffer.alloc(FRAME * 2);
  const tone = steps[step].tone;
  for (let i = 0; i < FRAME; i++, n++) b.writeInt16LE(Math.round(tone ? Math.sin(n * 440 * 2 * Math.PI / RATE) * 8000 : (Math.random() - 0.5) * 60), i * 2);
  try { process.stdout.write(b); } catch { process.exit(0); }
  left -= 50;
  if (left <= 0) { step = (step + 1) % steps.length; left = steps[step].ms; }
}, 50);
process.stdout.on('error', () => process.exit(0));
