// Tiny stack VM — make.fun tiny-stack-vm-01-run-20261122.
// Runs each program in MAKEFUN_INPUT_DIR/<id>/program.bin on its input.bin,
// writing stdout.bin + exit.txt per id to MAKEFUN_OUTPUT_DIR.
// The kit ISA, exactly: 32-bit wrapping ints, 256-value data stack, 64-deep
// call stack, 256 words of memory, traps 2-11 with their own exit codes.
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_MAX = 256, CALLS_MAX = 64, MEM_WORDS = 256;
const STEP_LIMIT = 1_000_000, OUT_MAX = 65_536, INT_MIN = -2147483648;

// [imm bytes, pops, pushes] per opcode.
const SPEC: Record<number, [number, number, number]> = {
  0x00:[0,0,0], 0x01:[1,0,1], 0x02:[4,0,1], 0x03:[0,1,0],
  0x04:[0,1,2], 0x05:[0,2,2], 0x06:[0,2,3], 0x07:[0,3,3],
  0x10:[0,2,1], 0x11:[0,2,1], 0x12:[0,2,1], 0x13:[0,2,1],
  0x14:[0,2,1], 0x15:[0,2,1], 0x16:[0,2,1], 0x17:[0,1,1],
  0x18:[0,2,1], 0x19:[0,2,1], 0x1a:[0,2,1], 0x1b:[0,1,1],
  0x1c:[0,2,1], 0x1d:[0,2,1], 0x1e:[0,2,1], 0x20:[0,2,1],
  0x21:[0,2,1], 0x22:[0,2,1], 0x30:[2,0,0], 0x31:[2,1,0],
  0x32:[2,1,0], 0x33:[2,0,0], 0x34:[0,0,0], 0x40:[0,1,1],
  0x41:[0,2,0], 0x50:[0,1,0], 0x51:[0,1,0], 0x52:[0,0,1],
  0x53:[0,1,0],
};

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  const s = new Int32Array(STACK_MAX);
  const c = new Int32Array(CALLS_MAX); // return addresses
  const m = new Int32Array(MEM_WORDS);
  const o = new Uint8Array(OUT_MAX);
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code: number) => ({ out: o.slice(0, ol), code });
  for (;;) {
    if (steps === STEP_LIMIT) return end(10);
    if (pc < 0 || pc >= n) return end(9); // incl. falling off the end
    const op = p[pc];
    const spec = SPEC[op];
    if (spec === undefined) return end(5);
    const [imm, pops, pushes] = spec;
    if (pc + imm >= n) return end(9); // immediate cut off
    steps++;
    if (sp < pops) return end(2);
    if (sp - pops + pushes > STACK_MAX) return end(3);
    const nx = pc + 1 + imm;
    pc = nx;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: s[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian
        s[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: s[sp] = s[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = s[sp - 1]; s[sp - 1] = s[sp - 2]; s[sp - 2] = t; break; } // SWAP
      case 0x06: s[sp] = s[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT ( a b c -- b c a )
        const a = s[sp - 3]; s[sp - 3] = s[sp - 2]; s[sp - 2] = s[sp - 1]; s[sp - 1] = a;
        break;
      }
      case 0x17: s[sp - 1] = -s[sp - 1] | 0; break; // NEG (-INT_MIN is INT_MIN)
      case 0x1b: s[sp - 1] = ~s[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = s[sp - 1], a = s[sp - 2];
        let r: number;
        if (op >= 0x13 && op <= 0x16 && b === 0) return end(4); // DIV/MOD/DIVU/MODU by zero
        if (op === 0x10) r = (a + b) | 0; // ADD, wraps
        else if (op === 0x11) r = (a - b) | 0; // SUB, wraps
        else if (op === 0x12) r = Math.imul(a, b); // MUL, low 32 bits
        else if (op === 0x13) r = a === INT_MIN && b === -1 ? a : (a / b) | 0; // DIV, toward zero; INT_MIN / -1 is INT_MIN
        else if (op === 0x14) r = b === -1 ? 0 : (a % b) | 0; // MOD, sign of a; x % -1 is 0
        else if (op === 0x15) r = Math.floor((a >>> 0) / (b >>> 0)) | 0; // DIVU, unsigned
        else if (op === 0x16) r = ((a >>> 0) % (b >>> 0)) | 0; // MODU, unsigned
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31); // shift counts: low 5 bits
        else if (op === 0x1d) r = a >> (b & 31); // arithmetic (sign copied)
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // logical (zeros in)
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = a >>> 0 < (b >>> 0) ? 1 : 0;
        sp -= 2;
        s[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ: signed 16-bit offset from nx
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = s[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, unsigned 16-bit address
        if (cp === CALLS_MAX) return end(7);
        c[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET; empty call stack traps
        if (cp === 0) return end(8);
        pc = c[--cp];
        break;
      case 0x40: { // LOAD
        const a = s[sp - 1];
        if (a < 0 || a >= MEM_WORDS) return end(6);
        s[sp - 1] = m[a];
        break;
      }
      case 0x41: { // STORE ( v addr -- )
        const a = s[sp - 1], v = s[sp - 2];
        if (a < 0 || a >= MEM_WORDS) return end(6);
        sp -= 2;
        m[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII; past the output limit traps, writes nothing.
        const t = String(s[sp - 1]);
        if (ol + t.length > OUT_MAX) return end(11);
        sp--;
        for (let i = 0; i < t.length; i++) o[ol++] = t.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (ol + 1 > OUT_MAX) return end(11);
        o[ol++] = s[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up
        s[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: return end(s[--sp] & 255); // EXIT: code is the low byte
      default: return end(5); // unreachable
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
