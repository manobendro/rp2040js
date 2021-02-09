// Run blink!

import { loadHex } from './intelhex';

export const FLASH_START_ADDRESS = 0x10000000;
export const RAM_START_ADDRESS = 0x20000000;
export const SIO_START_ADDRESS = 0xd0000000;

// export const APSR_N = 0x80000000;
// export const APSR_Z = 0x40000000;
// export const APSR_C = 0x20000000;
// export const APSR_V = 0x10000000;

export type CPUWriteCallback = (address: number, value: number) => void;
export type CPUReadCallback = (address: number) => number;

function signExtend8(value: number) {
  return value & 0x80 ? 0x80000000 + (value & 0x7f) : value;
}

function signExtend16(value: number) {
  return value & 0x8000 ? 0x80000000 + (value & 0x7fff) : value;
}

export class RP2040 {
  readonly sram = new Uint8Array(264 * 1024);
  readonly sramView = new DataView(this.sram.buffer);
  readonly flash = new Uint8Array(16 * 1024 * 1024);
  readonly flash16 = new Uint16Array(this.flash.buffer);
  readonly flashView = new DataView(this.flash.buffer);
  readonly registers = new Uint32Array(16);

  readonly writeHooks = new Map<number, CPUWriteCallback>();
  readonly readHooks = new Map<number, CPUReadCallback>();

  // APSR fields
  public N: boolean = false;
  public C: boolean = false;
  public Z: boolean = false;
  public V: boolean = false;

  constructor(hex: string) {
    this.SP = 0x20041000;
    this.flash.fill(0xff);
    loadHex(hex, this.flash);
  }

  get SP() {
    return this.registers[13];
  }

  set SP(value: number) {
    this.registers[13] = value;
  }

  get LR() {
    return this.registers[14];
  }

  set LR(value: number) {
    this.registers[14] = value;
  }

  get PC() {
    return this.registers[15];
  }

  set PC(value: number) {
    this.registers[15] = value;
  }

  checkCondition(cond: number) {
    // Evaluate base condition.
    let result = false;
    switch (cond >> 1) {
      case 0b000:
        result = this.Z;
        break;
      case 0b001:
        result = this.C;
        break;
      case 0b010:
        result = this.N;
        break;
      case 0b011:
        result = this.V;
        break;
      case 0b100:
        result = this.C && !this.Z;
        break;
      case 0b101:
        result = this.N === this.V;
        break;
      case 0b110:
        result = this.N === this.V && !this.Z;
        break;
      case 0b111:
        result = true;
        break;
    }
    return cond & 0b1 && cond != 0b1111 ? !result : result;
  }

  readUint32(address: number) {
    if (address < FLASH_START_ADDRESS) {
      // TODO: should be readonly from bootrom once we have it
      return this.flashView.getUint32(address, true);
    } else if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      return this.flashView.getUint32(address - FLASH_START_ADDRESS, true);
    } else if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      return this.sramView.getUint32(address - RAM_START_ADDRESS, true);
    } else {
      const hook = this.readHooks.get(address);
      if (hook) {
        return hook(address);
      }
    }
    console.warn(`Read from invalid memory address: ${address.toString(16)}`);
    return 0xffffffff;
  }

  readUint16(address: number) {
    return this.readUint32(address) & 0xffff;
  }

  readUint8(address: number) {
    return this.readUint32(address) & 0xff;
  }

  writeUint32(address: number, value: number) {
    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      this.sramView.setUint32(address - RAM_START_ADDRESS, value, true);
    } else if (address >= SIO_START_ADDRESS && address < SIO_START_ADDRESS + 0x10000000) {
      const sioAddress = address - SIO_START_ADDRESS;
      // SIO write
      let pinList = [];
      for (let i = 0; i < 32; i++) {
        if (value & (1 << i)) {
          pinList.push(i);
        }
      }
      if (sioAddress === 20) {
        console.log(`GPIO pins ${pinList} set to HIGH`);
      } else if (sioAddress === 24) {
        console.log(`GPIO pins ${pinList} set to LOW`);
      } else {
        console.log('Someone wrote', value.toString(16), 'to', sioAddress);
      }
    } else {
      const hook = this.writeHooks.get(address);
      if (hook) {
        hook(address, value);
      }
    }
  }

  executeInstruction() {
    // ARM Thumb instruction encoding - 16 bits / 2 bytes
    const opcode = this.readUint16(this.PC);
    const opcode2 = this.readUint16(this.PC + 1);
    const opcodePC = this.PC;
    this.PC += 2;
    // ADCS
    if (opcode >> 6 === 0b0100000101) {
      const Rm = (opcode >> 3) & 0x7;
      const Rdn = opcode & 0x7;
      const leftValue = this.registers[Rdn];
      const rightValue = this.registers[Rm];
      const result = leftValue + rightValue + (this.C ? 1 : 0);
      this.registers[Rdn] = result;
      this.N = !!(result & 0x80000000);
      this.Z = (result & 0xffffffff) === 0;
      this.C = result >= 0xffffffff;
      this.V =
        ((leftValue | 0) >= 0 && (rightValue | 0) >= 0 && (result | 0) < 0) ||
        ((leftValue | 0) <= 0 && (rightValue | 0) <= 0 && (result | 0) > 0);
    }
    // ADDS (Encoding T2)
    else if (opcode >> 11 === 0b00110) {
      const imm8 = opcode & 0xff;
      const Rdn = (opcode >> 8) & 0x7;
      const leftValue = this.registers[Rdn];
      const result = leftValue + imm8;
      this.registers[Rdn] = result;
      this.N = !!(result & 0x80000000);
      this.Z = (result & 0xffffffff) === 0;
      this.C = result >= 0xffffffff;
      this.V = (leftValue | 0) > 0 && imm8 < 0x80 && (result | 0) < 0;
    }
    // B (with cond)
    else if (opcode >> 12 === 0b1101) {
      let imm8 = (opcode & 0xff) << 1;
      const cond = (opcode >> 8) & 0xf;
      if (imm8 & (1 << 8)) {
        imm8 = (imm8 & 0x1ff) - 0x200;
      }
      if (this.checkCondition(cond)) {
        this.PC += imm8 + 2;
      }
    }
    // B
    else if (opcode >> 11 === 0b11100) {
      let imm11 = (opcode & 0x7ff) << 1;
      if (imm11 & (1 << 11)) {
        imm11 = (imm11 & 0x7ff) - 0x800;
      }
      this.PC += imm11 + 2;
    }
    // BL
    else if (opcode >> 11 === 0b11110 && opcode2 >> 14 === 0b11) {
      // right now we just ignore it. but let's print it!
      console.log('BL ignored');
      this.PC += 2;
    }
    // CMP immediate
    else if (opcode >> 11 === 0b00101) {
      const Rn = (opcode >> 8) & 0x7;
      const imm8 = opcode & 0xff;
      const value = this.registers[Rn] | 0;
      const result = (value - imm8) | 0;
      this.N = value < imm8;
      this.Z = value === imm8;
      this.C = value >= imm8;
      this.V = value < 0 && imm8 > 0 && result > 0;
    }
    // CMP (register)
    else if (opcode >> 6 === 0b0100001010) {
      const Rm = (opcode >> 3) & 0x7;
      const Rn = opcode & 0x7;
      const leftValue = this.registers[Rn] | 0;
      const rightValue = this.registers[Rm] | 0;
      const result = (leftValue - rightValue) | 0;
      this.N = leftValue < rightValue;
      this.Z = leftValue === rightValue;
      this.C = leftValue >= rightValue;
      this.V =
        (leftValue > 0 && rightValue < 0 && result < 0) ||
        (leftValue < 0 && rightValue > 0 && result > 0);
    }
    // LDR (immediate)
    else if (opcode >> 11 === 0b01101) {
      const imm5 = ((opcode >> 6) & 0x1f) << 2;
      const Rn = (opcode >> 3) & 0x7;
      const Rt = opcode & 0x7;
      const addr = this.registers[Rn] + imm5;
      this.registers[Rt] = this.readUint32(addr);
    }
    // LDR (literal)
    else if (opcode >> 11 === 0b01001) {
      const imm8 = (opcode & 0xff) << 2;
      const Rt = (opcode >> 8) & 7;
      const nextPC = this.PC + 2;
      const addr = (nextPC & 0xfffffffc) + imm8;
      console.log('reading from', addr.toString(16));
      this.registers[Rt] = this.readUint32(addr);
    }
    // LDRB (immediate)
    else if (opcode >> 11 === 0b01111) {
      const imm5 = (opcode >> 6) & 0x1f;
      const Rn = (opcode >> 3) & 0x7;
      const Rt = opcode & 0x7;
      const addr = this.registers[Rn] + imm5;
      this.registers[Rt] = this.readUint8(addr);
    }
    // LDRSH (immediate)
    else if (opcode >> 9 === 0b0101111) {
      const Rm = (opcode >> 6) & 0x7;
      const Rn = (opcode >> 3) & 0x7;
      const Rt = opcode & 0x7;
      const addr = this.registers[Rm] + this.registers[Rn];
      this.registers[Rt] = signExtend16(this.readUint16(addr));
    }
    // LSLS
    else if (opcode >> 11 === 0b00000) {
      const imm5 = (opcode >> 6) & 0x1f;
      const Rm = (opcode >> 3) & 0x7;
      const Rd = opcode & 0x7;
      const input = this.registers[Rm];
      const result = input << imm5;
      this.registers[Rd] = result;
      this.N = !!(result & 0x80000000);
      this.Z = result === 0;
      this.C = imm5 ? !!(input & (1 << (32 - imm5))) : this.C;
    }
    // MOVS
    else if (opcode >> 11 === 0b00100) {
      const value = opcode & 0xff;
      const Rd = (opcode >> 8) & 7;
      this.registers[Rd] = value;
      this.N = !!(value & 0x80000000);
      this.Z = value === 0;
    }
    // PUSH
    else if (opcode >> 9 === 0b1011010) {
      let bitCount = 0;
      for (let i = 0; i <= 8; i++) {
        if (opcode & (1 << i)) {
          bitCount++;
        }
      }
      let address = this.SP - 4 * bitCount;
      for (let i = 0; i <= 7; i++) {
        if (opcode & (1 << i)) {
          this.writeUint32(address, this.registers[i]);
          address += 4;
        }
      }
      if (opcode & (1 << 8)) {
        this.writeUint32(address, this.registers[14]);
      }
      this.SP -= 4 * bitCount;
    }
    // NEGS
    else if (opcode >> 6 === 0b0100001001) {
      let Rn = (opcode >> 3) & 0x7;
      let Rd = opcode & 0x7;
      const value = this.registers[Rn] | 0;
      this.registers[Rd] = -value;
      this.N = value > 0;
      this.Z = value === 0;
      this.C = value === -1;
      this.V = value === 0x7fffffff;
    }
    // STR (immediate)
    else if (opcode >> 11 === 0b01100) {
      const imm5 = ((opcode >> 6) & 0x1f) << 2;
      const Rn = (opcode >> 3) & 0x7;
      const Rt = opcode & 0x7;
      const address = this.registers[Rn] + imm5;
      this.writeUint32(address, this.registers[Rt]);
    }
    // SUBS (Encoding T2)
    else if (opcode >> 11 === 0b00111) {
      let imm8 = opcode & 0xff;
      let Rdn = (opcode >> 8) & 0x7;
      let value = this.registers[Rdn];
      const result = (value - imm8) | 0;
      this.registers[Rdn] = result;
      this.N = value < imm8;
      this.Z = value === imm8;
      this.C = value >= imm8;
      this.V = (value | 0) < 0 && imm8 > 0 && result > 0;
    }
    // TST
    else if (opcode >> 6 == 0b0100001000) {
      const Rm = (opcode >> 3) & 0x7;
      const Rn = opcode & 0x7;
      const result = this.registers[Rn] & this.registers[Rm];
      this.N = !!(result & 0x80000000);
      this.Z = result === 0;
    }
    // UXTB
    else if (opcode >> 6 == 0b1011001011) {
      const Rm = (opcode >> 3) & 0x7;
      const Rd = opcode & 0x7;
      this.registers[Rd] = this.registers[Rm] & 0xff;
    } else {
      console.log(`Warning: Instruction at ${opcodePC.toString(16)} is not implemented yet!`);
    }
  }
}
