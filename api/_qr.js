// A small QR code maker with no dependencies. Files that start with an underscore are not routes.
//
// qrMatrix(text)  -> a square grid of true (dark) and false (light)
// qrSvg(text, o)  -> the same code as an SVG string, sharp at any print size
//
// Byte mode, error correction level M, versions 1 to 6. That holds a link of up to 106 characters,
// which covers a client's /review-us page or a Google review link. A longer link throws, so a card
// is never printed with a code that does not scan.

// Version: [total data bytes, error correction bytes per block, number of blocks]
const VERSIONS = {
  1: [16, 10, 1],
  2: [28, 16, 1],
  3: [44, 26, 1],
  4: [64, 18, 2],
  5: [86, 24, 2],
  6: [108, 16, 4],
};

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// The text as data bytes with the mode, the length and the padding, sized for the smallest version that fits.
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let version = 0;
  for (const v of Object.keys(VERSIONS).map(Number)) {
    // 4 bits of mode and 8 bits of length come out of the data space.
    if (bytes.length + 2 <= VERSIONS[v][0]) { version = v; break; }
  }
  if (!version) throw new Error('qr_text_too_long');
  const capacity = VERSIONS[version][0];
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(4, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  return { version, data };
}

// Splits the data into blocks, adds the error correction to each and weaves them together.
function withErrorCorrection(version, data) {
  const [, ecLen, blockCount] = VERSIONS[version];
  const blockLen = data.length / blockCount;
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  for (let b = 0; b < blockCount; b++) {
    const chunk = data.slice(b * blockLen, (b + 1) * blockLen);
    blocks.push({ chunk, ec: rsRemainder(chunk, divisor) });
  }
  const out = [];
  for (let i = 0; i < blockLen; i++) for (const b of blocks) out.push(b.chunk[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(version, codewords, mask) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = !!on; fixed[y][x] = true; };

  // Timing lines
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

  // The three corner squares, each with its light border
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  // The small alignment square (versions 2 and up have one)
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  // Format bits: level M (00) and the mask number, protected and written twice
  const formatData = mask; // level M is 0, so the five bits are just the mask
  let rem = formatData;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  const bit = (i) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);

  // The data, written in a zigzag from the bottom right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        let on = false;
        if (i < codewords.length * 8) on = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
        dark[y][x] = on !== MASKS[mask](x, y);
      }
    }
  }
  return dark;
}

// Scores how hard a grid is to scan. Lower is better.
function penalty(m) {
  const size = m.length;
  let score = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
      // A corner-square look-alike in the middle of the data confuses scanners.
      for (let b = 0; b + 10 < size; b++) {
        const s = [];
        for (let k = 0; k < 11; k++) s.push(get(a, b + k) ? 1 : 0);
        const t = s.join('');
        if (t === '10111010000' || t === '00001011101') score += 40;
      }
    }
  };
  line((a, b) => m[a][b]);
  line((a, b) => m[b][a]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  let darkCount = 0;
  for (const row of m) for (const c of row) if (c) darkCount++;
  score += Math.floor(Math.abs((darkCount * 20) / (size * size) - 10)) * 10;
  return score;
}

function qrMatrix(text) {
  const { version, data } = encode(text);
  const codewords = withErrorCorrection(version, data);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

// The code as an SVG. `quiet` is the light border in squares, and scanners want 4.
function qrSvg(text, { dark = '#111111', light = '#ffffff', quiet = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + quiet * 2;
  let d = '';
  m.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x++; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { qrMatrix, qrSvg };
