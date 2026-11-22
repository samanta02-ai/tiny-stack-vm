// Tiny stack VM (make.fun tiny-stack-vm-01-run-20261122).
// Runs MAKEFUN_INPUT_DIR/<id>/program.bin on input.bin, writing
// stdout.bin + exit.txt per id to MAKEFUN_OUTPUT_DIR. Node 22, stdlib only.

import{mkdirSync,readdirSync,readFileSync,writeFileSync}from'node:fs';
import{join}from'node:path';

// [immediate bytes, pops, pushes] per opcode byte.
const SPEC: Record<number, [number, number, number]> = {
  0x00:[0,0,0],0x01:[1,0,1],0x02:[4,0,1],0x03:[0,1,0],
  0x04:[0,1,2],0x05:[0,2,2],0x06:[0,2,3],0x07:[0,3,3],
  0x10:[0,2,1],0x11:[0,2,1],0x12:[0,2,1],0x13:[0,2,1],
  0x14:[0,2,1],0x15:[0,2,1],0x16:[0,2,1],0x17:[0,1,1],
  0x18:[0,2,1],0x19:[0,2,1],0x1a:[0,2,1],0x1b:[0,1,1],
  0x1c:[0,2,1],0x1d:[0,2,1],0x1e:[0,2,1],0x20:[0,2,1],
  0x21:[0,2,1],0x22:[0,2,1],0x30:[2,0,0],0x31:[2,1,0],
  0x32:[2,1,0],0x33:[2,0,0],0x34:[0,0,0],0x40:[0,1,1],
  0x41:[0,2,0],0x50:[0,1,0],0x51:[0,1,0],0x52:[0,0,1],
  0x53:[0,1,0],
};

// Binary ops 0x10-0x22, indexed by opcode-0x10. Slots 7 (NEG) and 11 (NOT)
// are unary and handled separately, and slot 15 (0x1f) is no opcode at all.
const BIN: (((a: number, b: number) => number) | null)[] = [
  (a,b)=>a+b, (a,b)=>a-b, Math.imul,
  (a,b)=>(a/b)|0, (a,b)=>a%b,
  (a,b)=>((a>>>0)/(b>>>0))|0, (a,b)=>((a>>>0)%(b>>>0))|0,
  null,
  (a,b)=>a&b, (a,b)=>a|b, (a,b)=>a^b,
  null,
  (a,b)=>a<<(b&31), (a,b)=>a>>(b&31), (a,b)=>a>>>(b&31),
  null,
  (a,b)=>a===b?1:0, (a,b)=>a<b?1:0,
  (a,b)=>(a>>>0)<(b>>>0)?1:0,
];

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const s = new Int32Array(256);
  const c = new Int32Array(64);
  const m = new Int32Array(256);
  const o = new Uint8Array(65536);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code: number) => ({ out: o.slice(0, ol), code });
  for (;;) {
    if (steps === 1e6) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = p[pc];
    const spec = SPEC[op];
    if (spec === undefined) return end(5);
    const [im, po, pu] = spec;
    if (pc + im >= n) return end(9);
    steps++;
    if (sp < po) return end(2);
    if (sp - po + pu > 256) return end(3);
    const nx = pc + 1 + im;
    pc = nx;
    if (op === 0x00) return end(0);
    if (op === 0x01) { s[sp++] = (p[nx - 1] << 24) >> 24; continue; }
    if (op === 0x02) { s[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); continue; }
    if (op === 0x03) { sp--; continue; }
    if (op === 0x04) { s[sp] = s[sp - 1]; sp++; continue; }
    if (op === 0x05) { const t = s[sp - 1]; s[sp - 1] = s[sp - 2]; s[sp - 2] = t; continue; }
    if (op === 0x06) { s[sp] = s[sp - 2]; sp++; continue; }
    if (op === 0x07) { const a = s[sp - 3]; s[sp - 3] = s[sp - 2]; s[sp - 2] = s[sp - 1]; s[sp - 1] = a; continue; }
    if (op >= 0x10 && op <= 0x22) {
      if (op === 0x17) { s[sp - 1] = -s[sp - 1]; continue; }
      if (op === 0x1b) { s[sp - 1] = ~s[sp - 1]; continue; }
      if (op >= 0x13 && op <= 0x16 && s[sp - 1] === 0) return end(4);
      const b = s[sp - 1], a = s[sp - 2];
      sp -= 2;
      s[sp++] = BIN[op - 0x10]!(a, b);
      continue;
    }
    if (op >= 0x30 && op <= 0x32) {
      const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
      if (op === 0x30 || (op === 0x31 ? s[--sp] === 0 : s[--sp] !== 0)) pc = nx + rel;
      continue;
    }
    if (op === 0x33) { if (cp === 64) return end(7); c[cp++] = nx; pc = p[nx - 2] | (p[nx - 1] << 8); continue; }
    if (op === 0x34) { if (cp === 0) return end(8); pc = c[--cp]; continue; }
    if (op === 0x40) { const a = s[sp - 1]; if (a < 0 || a >= 256) return end(6); s[sp - 1] = m[a]; continue; }
    if (op === 0x41) { const a = s[sp - 1], v = s[sp - 2]; if (a < 0 || a >= 256) return end(6); sp -= 2; m[a] = v; continue; }
    if (op === 0x50) {
      const t = String(s[sp - 1]);
      if (ol + t.length > 65536) return end(11);
      sp--;
      for (let i = 0; i < t.length; i++) o[ol++] = t.charCodeAt(i);
      continue;
    }
    if (op === 0x51) { if (ol + 1 > 65536) return end(11); o[ol++] = s[--sp] & 255; continue; }
    if (op === 0x52) { s[sp++] = ip < inp.length ? inp[ip++] : -1; continue; }
    if (op === 0x53) return end(s[--sp] & 255);
    return end(5);
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
