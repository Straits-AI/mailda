export {
  DEFAULT_FRAME_BYTES, EvidenceFrameError, HEADER_BYTES, MAGIC, TAG_BYTES, VERSION,
  decodeHeader, encodeHeader, frameCountFor, framesForRange, open, openStream, seal,
} from "./frame.ts";
export type { Header, Sealed } from "./frame.ts";
