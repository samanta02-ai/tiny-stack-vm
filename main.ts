// Tiny stack VM (make.fun tiny-stack-vm-01-run-20261122).
// Runs MAKEFUN_INPUT_DIR/<id>/program.bin on input.bin, writing
// stdout.bin + exit.txt per id to MAKEFUN_OUTPUT_DIR. 32-bit wrapping
// ints, 256-value stack, 64-deep call stack, 256 words memory, traps 2-11.
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK = 256, CALLS = 64, MEM = 256, STEPS = 1e6, OUT = 65536;

// [immediate bytes, pops, pushes] per opcode.
const SPEC: Record<number, [number, number, number]> = {
  0x00:[0,0,0], 0x01:[1,0,1], 0x02:[4,0,1], 0x03:[0,1,0], 0x04:[0,1,2],
  0x05:[0,2,2], 0x06:[0,2,3], 0x07:[0,3,3], 0x10:[0,2,1], 0x11:[0,2,1],
  0x12:[0,2,1], 0x13:[0,2,1], 0x14:[0,2,1], 0x15:[0,2,1], 0x16:[0,2,1],
  0x17:[0,1,1], 0x18:[0,2,1], 0x19:[0,2,1], 0x1a:[0,2,1], 0x1b:[0,1,1],
  0x1c:[0,2,1], 0x1d:[0,2,1], 0x1e:[0,2,1], 0x20:[0,2,1], 0x21:[0,2,1],
  0x22:[0,2,1], 0x30:[2,0,0], 0x31:[2,1,0], 0x32:[2,1,0], 0x33:[2,0,0],
  0x34:[0,0,0], 0x40:[0,1,1], 0x41:[0,2,0], 0x50:[0,1,0], 0x51:[0,1,0],
  0x52:[0,0,1], 0x53:[0,1,0],
};

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const st = new Int32Array(STACK);
  const cs = new Int32Array(CALLS);
  const mem = new Int32Array(MEM);
  const out = new Uint8Array(OUT);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code: number) => ({ out: out.slice(0, ol), code });
  for (;;) {
    if (steps === STEPS) return end(10);
    if (pc < 0 || pc >= p.length) return end(9);
    const op = p[pc];
    const spec = SPEC[op];
    if (!spec) return end(5);
    const [imm, pops, pushes] = spec;
    if (pc + imm >= p.length) return end(9);
    steps++;
    if (sp < pops) return end(2);
    if (sp - pops + pushes > STACK) return end(3);
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
      case 0x00: return end(0);
      case 0x01: st[sp++] = (p[nx - 1] << 24) >> 24; break;
      case 0x02:
        st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03: sp--; break;
      case 0x04: st[sp] = st[sp - 1]; sp++; break;
      case 0x05: [st[sp - 1], st[sp - 2]] = [st[sp - 2], st[sp - 1]]; break;
      case 0x06: st[sp] = st[sp - 2]; sp++; break;
      case 0x07: [st[sp - 3], st[sp - 2], st[sp - 1]] = [st[sp - 2], st[sp - 1], st[sp - 3]]; break;
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break;
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1], a = st[sp - 2];
        if (op >= 0x13 && op <= 0x16 && b === 0) return end(4);
        const u = a >>> 0, v = b >>> 0, s = b & 31;
        const r = op === 0x10 ? (a + b) | 0 : op === 0x11 ? (a - b) | 0
          : op === 0x12 ? Math.imul(a, b)
          : op === 0x13 ? (a === -2147483648 && b === -1 ? a : (a / b) | 0)
          : op === 0x14 ? (b === -1 ? 0 : (a % b) | 0)
          : op === 0x15 ? Math.floor(u / v) | 0 : op === 0x16 ? (u % v) | 0
          : op === 0x18 ? a & b : op === 0x19 ? a | b : op === 0x1a ? a ^ b
          : op === 0x1c ? a << s : op === 0x1d ? a >> s : op === 0x1e ? (a >>> s) | 0
          : op === 0x20 ? +(a === b) : op === 0x21 ? +(a < b) : +(u < v);
        sp -= 2;
        st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        // JMP always takes; JZ/JNZ pop and take on v == 0 / v != 0.
        const take = op === 0x30 || (st[--sp] === 0) === (op === 0x31);
        if (take) pc = nx + rel;
        break;
      }
      case 0x33:
        if (cp === CALLS) return end(7);
        cs[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return end(8);
        pc = cs[--cp];
        break;
      case 0x40: {
        const a = st[sp - 1];
        if (a < 0 || a >= MEM) return end(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: {
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a >= MEM) return end(6);
        sp -= 2;
        mem[a] = v;
        break;
      }
      case 0x50: {
        const t = String(st[sp - 1]);
        if (ol + t.length > OUT) return end(11);
        sp--;
        for (let i = 0; i < t.length; i++) out[ol++] = t.charCodeAt(i);
        break;
      }
      case 0x51:
        if (ol + 1 > OUT) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: st[sp++] = ip < inp.length ? inp[ip++] : -1; break;
      case 0x53: return end(st[--sp] & 255);
      default: return end(5);
    }
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
