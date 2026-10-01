// web3.js 1.x and Anchor expect Node's Buffer as a global.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
