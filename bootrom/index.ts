import * as fs from "fs";
class IntelHexParser {
    private hexString: string;
    private dataArray: Uint32Array;

    constructor(hexString: string) {
        this.hexString = hexString;
        this.dataArray = new Uint32Array(0); // Initialize with an empty Uint32Array
    }

    parse() {
        const lines = this.hexString.split('\n');
        const parsedData: number[] = [];

        for (const line of lines) {
            if (line.startsWith(':')) {
                const byteCount = parseInt(line.substring(1, 3), 16);
                const address = parseInt(line.substring(3, 7), 16);
                const recordType = parseInt(line.substring(7, 9), 16);
                const data = line.substring(9, 9 + byteCount * 2);
                const checksum = parseInt(line.substring(9 + byteCount * 2, 9 + byteCount * 2 + 2), 16);

                if (recordType === 0) { // Data record
                    for (let i = 0; i < byteCount; i += 4) {
                        const byte1 = parseInt(data.substring(i * 2, i * 2 + 2), 16);
                        const byte2 = parseInt(data.substring(i * 2 + 2, i * 2 + 4), 16);
                        const byte3 = parseInt(data.substring(i * 2 + 4, i * 2 + 6), 16);
                        const byte4 = parseInt(data.substring(i * 2 + 6, i * 2 + 8), 16);
                        const word = (byte4 << 24) | (byte3 << 16) | (byte2 << 8) | byte1;
                        parsedData.push(word >>> 0); // Ensure unsigned interpretation
                    }
                }
            }
        }

        this.dataArray = new Uint32Array(parsedData);
    }

    toUint32Array(): Uint32Array {
        return this.dataArray;
    }

    toTypeScriptArrayLiteral(): string {
        const values = Array.from(this.dataArray).map(num => `0x${num.toString(16).padStart(8, '0')}`);
        const arrayLiteral = `const dataArray: Uint32Array = new Uint32Array([${values.join(', ')}]);\n`;
        return arrayLiteral;
    }
    toTypeScriptArrayLiteralFormated(): string {
        const values = Array.from(this.dataArray).map(num => `0x${num.toString(16).padStart(8, '0')}`);
        const lines: string[] = [];
        for (let i = 0; i < values.length; i += 8) {
            lines.push(values.slice(i, i + 8).join(', '));
        }
        const arrayLiteral = `const dataArray: Uint32Array = new Uint32Array([\n${lines.join(',\n')}\n]);\n`;
        return arrayLiteral;
    }
}

// Example usage:
const intelHexString = fs.readFileSync('b2.hex', 'utf-8');

const parser = new IntelHexParser(intelHexString);
parser.parse();

// console.log(parser.toUint32Array());

const uint32Array = parser.toTypeScriptArrayLiteralFormated();

fs.writeFileSync('bootromb2f.ts', uint32Array);
