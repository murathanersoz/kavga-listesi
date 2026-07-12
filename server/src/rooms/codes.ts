import { customAlphabet } from "nanoid";

/** 4-letter room codes from an unambiguous alphabet (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const newRoomCode = customAlphabet(CODE_ALPHABET, 4);

/** QR join tokens are separate and unguessable (codes are shoutable, tokens are not). */
export const newQrToken = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  24,
);

export const isValidCode = (s: string): boolean =>
  s.length === 4 && [...s.toUpperCase()].every((c) => CODE_ALPHABET.includes(c));
