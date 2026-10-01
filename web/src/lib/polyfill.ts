// web3.js 1.x and Anchor expect Node's Buffer as a global in the browser.
import { Buffer } from 'buffer';
globalThis.Buffer ??= Buffer;
