// THE ZIP THAT BOTH OOXML FORMATS SIT INSIDE.
//
// Lifted out of `xlsx.ts` unchanged when `docx.ts` needed the same container. An .xlsx and a .docx
// are the same thing at this level — a ZIP of XML parts with a content-type map and a relationship
// graph — and the piece of a library either would use is this function. The argument `xlsx.ts` made
// for owning it holds twice as well now that two formats share it:
//
//   "The piece of a library we would actually use is a few hundred lines, and the rest is layout
//    opinions and a font pipeline we do not want. An xlsx is a ZIP of XML — five small documents and
//    a container — and Node ships `zlib.deflateRawSync` and `zlib.crc32`, which is the whole of the
//    hard part."
//
// Nothing here is format-specific and nothing here should become format-specific. A caller passes
// named XML parts and gets bytes.
import { deflateRawSync, crc32 } from "node:zlib";


interface Entry {
  name: string;
  data: Buffer;
  deflated: Buffer;
  crc: number;
}

/**
 * A ZIP, written directly.
 *
 * Deflate via `zlib.deflateRawSync` and CRC via `zlib.crc32` — both stdlib, both exactly what the
 * format asks for. Timestamps are fixed at a constant rather than `new Date()`: a byte-identical
 * workbook for identical figures means a diff between two months shows what changed in the numbers,
 * and a rebuilt artifact does not look like a new one.
 */
export function zip(entries: { name: string; xml: string }[]): Buffer {
  const files: Entry[] = entries.map(({ name, xml }) => {
    const data = Buffer.from(xml, "utf8");
    return { name, data, deflated: deflateRawSync(data, { level: 9 }), crc: crc32(data) };
  });

  const DOS_TIME = 0; // 1980-01-01. See above: deliberate, not a missing clock.
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_TIME, 12);
    local.writeUInt32LE(f.crc, 14);
    local.writeUInt32LE(f.deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, f.deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_TIME, 14);
    cd.writeUInt32LE(f.crc, 16);
    cd.writeUInt32LE(f.deflated.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + f.deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}
