import minimist from 'minimist';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server.js';
import { Simulator } from '../src/simulator.js';
import { ConsoleLogger, LogLevel } from '../src/utils/logging.js';
import { bootromB2 } from './bootrom.js';
import { loadUF2 } from './load-flash.js';

const args = minimist(process.argv.slice(2), {
    string: [
        'image', // UF2 image to load; defaults to "RPI_PICO-20230426-v1.20.0.uf2"
    ],
    boolean: [
        'gdb', // start GDB server on 3333
    ],
});
const simulator = new Simulator();
const mcu = simulator.rp2040;
mcu.loadBootrom(bootromB2);
mcu.logger = new ConsoleLogger(LogLevel.Error);

let imageName: string = args.image ?? 'wozmon-rp2040.uf2';

console.log(`Loading uf2 image ${imageName}`);
loadUF2(imageName, mcu);

if (args.gdb) {
    const gdbServer = new GDBTCPServer(simulator, 3333);
    console.log(`RP2040 GDB Server ready! Listening on port ${gdbServer.port}`);
}
mcu.uart[0].onByte = (value) => {
    if (value === 0x0008 || value === 0x007F) { // Handle backspace and delete
        process.stdout.write('\b \b'); // Moves cursor back, writes a space to erase the character, then moves cursor back again
    } else {
        process.stdout.write(new Uint8Array([value]));
    }
};

if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
    // 24 is Ctrl+X
    if (chunk[0] === 24) {
        process.exit(0);
    } else if (chunk[0] === 0x0008 || chunk[0] === 0x007F) {
        chunk[0] = 0x0008;
    }
    for (const byte of chunk) {
        mcu.uart[0].feedByte(byte);
    }
});

simulator.rp2040.core.PC = 0x10000000;
simulator.execute();
